// streamChat은 sidePanel에서 직접 사용 (MV3 SW fetch streaming 제한)
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  STORAGE_KEYS,
} from '../shared/constants';
import type {
  ExtensionMessage,
  PageContext,
  SSEEvent,
} from '../shared/types';
import type { CapturedApi } from '../shared/api-hook-types';
import { mainWorldHookFunction, mainWorldUnhookFunction } from '../content/api-hook/main-world-hook';
import { apiHookRelayFunction } from '../content/api-hook/relay';

// ── State ──
// origin별 토큰 저장 — 멀티 인스턴스 (xgen.x2bee.com / jeju-xgen.x2bee.com) 동시 사용 지원
const tokensByOrigin: Record<string, string> = {};
let cachedPageContext: PageContext | null = null;
let cachedPageContextTabId: number | null = null;
// activeAbortController 제거 — SSE abort는 sidePanel에서 직접 처리

// ── API Hook State ──
const hookedTabs = new Set<number>();
const capturedApisByTab = new Map<number, CapturedApi[]>();

// ── Side Panel open on icon click ──

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── Message handling ──

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    switch (message.type) {
      case 'SET_TOKEN': {
        const origin = message.origin || sender.origin || '';
        if (origin) {
          tokensByOrigin[origin] = message.token;
          chrome.storage.local.set({ [`token:${origin}`]: message.token });
        }
        // SettingsBar 호환: 마지막 토큰을 기본값으로도 저장
        chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKEN]: message.token });
        sendResponse({ ok: true });
        break;
      }

      case 'SET_ORIGIN':
        // SettingsBar UI 표시용 — API 호출에는 active tab origin 사용
        chrome.storage.local.set({ [STORAGE_KEYS.SERVER_URL]: message.origin });
        sendResponse({ ok: true });
        break;

      case 'GET_CHAT_CONFIG': {
        // sidePanel이 SSE를 직접 소비하기 위해 필요한 config 반환
        (async () => {
          const settings = await chrome.storage.local.get([
            STORAGE_KEYS.PROVIDER,
            STORAGE_KEYS.MODEL,
          ]);
          const serverUrl = await resolveXgenServerUrl();
          const authToken = serverUrl ? (tokensByOrigin[serverUrl] || await getStoredToken(serverUrl)) : '';
          const pageContext = await getPageContextFromTab().catch(() => null);

          if (pageContext) {
            cachedPageContext = pageContext;
          }

          // SSE 스트리밍은 Next.js 프록시를 우회하여 gateway에 직접 연결해야 함
          // Next.js rewrites는 SSE 응답을 버퍼링하므로 실시간 스트리밍이 안 됨
          let streamUrl = serverUrl || '';
          if (streamUrl) {
            try {
              const parsed = new URL(streamUrl);
              // 프론트엔드(3000) → gateway(8000)로 교체
              if (parsed.port === '3000' || !parsed.port) {
                parsed.port = '8000';
                streamUrl = parsed.origin;
              }
            } catch { /* URL 파싱 실패 시 원본 사용 */ }
          }

          sendResponse({
            type: 'CHAT_CONFIG',
            serverUrl: streamUrl,
            authToken: authToken || '',
            provider: settings[STORAGE_KEYS.PROVIDER] || DEFAULT_PROVIDER,
            model: settings[STORAGE_KEYS.MODEL] || DEFAULT_MODEL,
            pageContext: pageContext || cachedPageContext,
          });
        })();
        return true; // async response
      }

      case 'RELAY_COMMAND': {
        // sidePanel이 SSE에서 받은 canvas_command/page_command를 SW로 위임
        const event = (message as any).event as SSEEvent;
        console.log('[XGEN SW] RELAY_COMMAND received:', event.type, event);
        (async () => {
          if (event.type === 'canvas_command') {
            await sendToContentScript({
              type: 'CANVAS_COMMAND',
              requestId: (event as any).requestId || crypto.randomUUID(),
              action: event.action,
              params: event.params,
            });
          } else if (event.type === 'page_command') {
            const requestId = (event as any).requestId || crypto.randomUUID();
            const apiHookResult = await handleApiHookAction(event.action, event.params);
            if (apiHookResult) {
              await postCommandResultToBackend(requestId, apiHookResult);
            } else {
              await sendToContentScript({
                type: 'PAGE_COMMAND',
                requestId,
                action: event.action,
                params: event.params,
              });
            }
          }
          sendResponse({ ok: true });
        })();
        return true; // async response
      }

      case 'SEND_MESSAGE':
        // 레거시 호환: sidePanel이 직접 SSE를 소비하므로 더 이상 사용하지 않음
        sendResponse({ ok: true });
        break;

      case 'STOP_STREAM':
        sendResponse({ ok: true });
        break;

      case 'GET_PAGE_CONTEXT':
        getPageContextFromTab()
          .then((ctx) => sendResponse(ctx))
          .catch(() => sendResponse(null));
        return true; // async response

      case 'PAGE_CONTEXT_UPDATE':
        cachedPageContext = message.context;
        cachedPageContextTabId = sender.tab?.id ?? null;
        broadcastToSidePanel({ type: 'PAGE_CONTEXT_UPDATE', context: message.context });
        sendResponse({ ok: true });
        break;

      case 'PAGE_COMMAND_RESULT':
        // DOM 재스캔 결과로 context 갱신
        if (message.result?.pageContext) {
          cachedPageContext = message.result.pageContext as PageContext;
        }
        // 백엔드 에이전트 루프에 결과 전달 — 다음 스텝 결정에 필요
        if (message.requestId) {
          postCommandResultToBackend(message.requestId, message.result);
        }
        sendResponse({ ok: true });
        break;

      case 'CANVAS_RESULT':
        // canvas state 캐싱 — 다음 턴에 갱신된 state 제공
        if (message.result && cachedPageContext) {
          cachedPageContext = {
            ...cachedPageContext,
            data: { ...cachedPageContext.data, canvasState: message.result },
          };
        }
        // 백엔드 에이전트 루프에 결과 전달
        if (message.requestId) {
          postCommandResultToBackend(message.requestId, message.result);
        }
        sendResponse({ ok: true });
        break;

      // ── API Hook: content script relay → SW 저장 ──
      case 'API_CAPTURED': {
        const tabId = sender.tab?.id || 0;
        const captured = message.data as CapturedApi;
        captured.tabId = tabId;

        if (!capturedApisByTab.has(tabId)) {
          capturedApisByTab.set(tabId, []);
        }
        capturedApisByTab.get(tabId)!.push(captured);

        // 로그인 요청 감지 시 auth profile 즉시 자동 생성
        if (captured.method === 'POST' && /\/(login|auth|token|signin|oauth|session)/i.test(captured.url)) {
          autoCreateAuthProfileFromCapture(captured.url).catch(() => {});
        }

        sendResponse({ ok: true });
        break;
      }

      // ── Sidepanel → SW 직접 PAGE_COMMAND (register_tool 등) ──
      case 'PAGE_COMMAND': {
        if (!sender.tab) {
          // sidepanel에서 보낸 경우 (sender.tab 없음) → SW에서 직접 처리
          handleApiHookAction(message.action, message.params).then((hookResult) => {
            sendResponse(hookResult || { success: false, action: message.action, error: 'Unknown action' });
          });
          return true;
        }
        sendResponse({ ok: true });
        break;
      }

      // ── Element Picker ──
      case 'ELEMENT_PICKER_START':
        sendToContentScript({ type: 'ELEMENT_PICKER_START' } as ExtensionMessage);
        sendResponse({ ok: true });
        break;

      case 'ELEMENT_PICKER_STOP': {
        const tabId3 = sender.tab?.id;
        if (tabId3) {
          // content script에서 보낸 경우 (요소 클릭 후) → hook inject
          handlePickerHookInject(tabId3).then(() => sendResponse({ ok: true }));
          return true;
        }
        // sidepanel에서 보낸 경우 (취소 버튼) → content script에 stop 전달
        sendToContentScript({ type: 'ELEMENT_PICKER_STOP' } as ExtensionMessage);
        sendResponse({ ok: true });
        break;
      }

      case 'ELEMENT_PICKER_RESULT': {
        // content script에서 요소 클릭 후 2초 대기 후 호출됨
        const tabId4 = sender.tab?.id || 0;
        const captured2 = capturedApisByTab.get(tabId4) || [];
        const elementInfo = (message as any).elementInfo;

        // 캡처된 API를 sidepanel에 전달
        broadcastToSidePanel({
          type: 'ELEMENT_PICKER_RESULT',
          apis: captured2,
          elementInfo,
        } as ExtensionMessage);
        sendResponse({ ok: true });
        break;
      }
    }

    return false;
  },
);

// ── Restore per-origin tokens on startup ──

chrome.storage.local.get(null, (items) => {
  for (const [key, value] of Object.entries(items)) {
    if (key.startsWith('token:') && typeof value === 'string') {
      tokensByOrigin[key.slice(6)] = value; // "token:https://xgen..." → origin
    }
  }
});

// ── (SSE는 sidePanel에서 직접 소비 — MV3 SW fetch streaming 제한 우회) ──

// ── Helpers ──

async function getOriginFromTab(): Promise<string | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && tabs[0].url) {
    try {
      return new URL(tabs[0].url).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * XGEN 서버 URL을 결정한다.
 * 1순위: 토큰이 있는 XGEN origin (메모리 캐시)
 * 2순위: storage에 저장된 serverUrl
 * 3순위: active tab의 origin (XGEN 페이지인 경우)
 */
async function resolveXgenServerUrl(): Promise<string | null> {
  // 1순위: active tab의 origin (사용자가 보고 있는 페이지 우선)
  const tabOrigin = await getOriginFromTab();
  if (tabOrigin) {
    // localhost거나 xgen 사이트면 해당 origin 사용
    const isLocal = tabOrigin.includes('localhost') || tabOrigin.includes('127.0.0.1');
    const isXgen = tabOrigin.includes('xgen');
    if (isLocal || isXgen) return tabOrigin;
  }

  // 2순위: storage에 저장된 서버 URL
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SERVER_URL);
  const storedUrl = stored[STORAGE_KEYS.SERVER_URL] as string | undefined;
  if (storedUrl) {
    const token = await getStoredToken(storedUrl);
    if (token) return storedUrl;
  }

  // 3순위: 토큰이 있는 xgen origin (fallback)
  const xgenOrigin = Object.keys(tokensByOrigin).find((o) => o.includes('xgen'));
  if (xgenOrigin) return xgenOrigin;

  return null;
}

async function getStoredToken(origin: string): Promise<string> {
  const result = await chrome.storage.local.get(`token:${origin}`);
  const token = result[`token:${origin}`] || '';
  if (token) {
    tokensByOrigin[origin] = token; // 메모리 캐시에도 반영
  }
  return token;
}

async function getPageContextFromTab(): Promise<PageContext | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0 || !tabs[0].id) return null;

  const activeTabId = tabs[0].id;

  // 캐시: 같은 탭 + 2초 이내일 때만 사용
  if (
    cachedPageContext &&
    cachedPageContextTabId === activeTabId &&
    Date.now() - cachedPageContext.timestamp < 2000
  ) {
    return cachedPageContext;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTabId, {
      type: 'GET_PAGE_CONTEXT',
    });
    if (response) {
      cachedPageContext = response;
      cachedPageContextTabId = activeTabId;
    }
    return response;
  } catch {
    return null;
  }
}

async function sendToContentScript(message: ExtensionMessage) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && tabs[0].id) {
    console.log('[XGEN SW] sendToContentScript:', message.type, 'to tab', tabs[0].id);
    await chrome.tabs.sendMessage(tabs[0].id, message).catch((err) => {
      console.error('[XGEN SW] sendToContentScript failed:', message.type, err);
    });
  } else {
    console.warn('[XGEN SW] sendToContentScript: no active tab found');
  }
}

async function postCommandResultToBackend(
  requestId: string,
  result: unknown,
) {
  const serverUrl = await resolveXgenServerUrl();
  if (!serverUrl) return;

  const authToken = tokensByOrigin[serverUrl] || (await getStoredToken(serverUrl));

  try {
    await fetch(`${serverUrl}/api/ai-chat/command-result/${requestId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(result),
    });
  } catch (err) {
    console.error('[XGEN SW] Failed to POST command result:', err);
  }
}

function broadcastToSidePanel(message: ExtensionMessage) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ── API Hook: page_command 액션 처리 ──

const API_HOOK_ACTIONS = new Set([
  'start_api_hook',
  'stop_api_hook',
  'get_captured_apis',
  'clear_captured_apis',
  'register_tool',
]);

/**
 * API Hook 관련 page_command 액션을 SW에서 직접 처리.
 * 해당 액션이면 결과를 반환, 아니면 null 반환 (content script로 전달).
 */
async function handleApiHookAction(
  action: string,
  params: Record<string, unknown>,
): Promise<import('../shared/types').PageCommandResult | null> {
  if (!API_HOOK_ACTIONS.has(action)) return null;

  try {
    switch (action) {
      case 'start_api_hook': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0 || !tabs[0].id) {
          return { success: false, action, error: 'Active tab not found' };
        }
        const tabId = tabs[0].id;

        if (hookedTabs.has(tabId)) {
          return { success: true, action, result: 'API hook already active' };
        }

        // relay (isolated world) + MAIN world hook 주입
        await chrome.scripting.executeScript({
          target: { tabId },
          func: apiHookRelayFunction,
          world: 'ISOLATED' as any,
        });
        await chrome.scripting.executeScript({
          target: { tabId },
          func: mainWorldHookFunction,
          world: 'MAIN' as any,
        });

        hookedTabs.add(tabId);
        capturedApisByTab.set(tabId, []);
        return { success: true, action, result: 'API hook started. All fetch/XHR requests on this page will be captured.' };
      }

      case 'stop_api_hook': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0 || !tabs[0].id) {
          return { success: false, action, error: 'Active tab not found' };
        }
        const tabId = tabs[0].id;

        await chrome.scripting.executeScript({
          target: { tabId },
          func: mainWorldUnhookFunction,
          world: 'MAIN' as any,
        }).catch(() => {});

        const count = capturedApisByTab.get(tabId)?.length || 0;
        hookedTabs.delete(tabId);
        return { success: true, action, result: `API hook stopped. ${count} requests captured.` };
      }

      case 'get_captured_apis': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id || 0;
        const captured = capturedApisByTab.get(tabId) || [];

        // 필터 적용
        let filtered = captured;
        if (params.url_pattern) {
          const pattern = (params.url_pattern as string).toLowerCase();
          filtered = filtered.filter((a) => a.url.toLowerCase().includes(pattern));
        }
        if (params.method) {
          const method = (params.method as string).toUpperCase();
          filtered = filtered.filter((a) => a.method === method);
        }
        if (params.min_status) {
          filtered = filtered.filter((a) => a.responseStatus >= (params.min_status as number));
        }
        if (params.max_status) {
          filtered = filtered.filter((a) => a.responseStatus <= (params.max_status as number));
        }

        // 요약 형태로 반환 (토큰 효율)
        const summary = filtered.map((a) => ({
          id: a.id,
          method: a.method,
          url: a.url,
          status: a.responseStatus,
          content_type: a.contentType,
          duration: a.duration,
          request_body_preview: a.requestBody?.slice(0, 200) || null,
          response_body_preview: a.responseBody?.slice(0, 500) || null,
        }));

        return {
          success: true,
          action,
          result: {
            total: captured.length,
            filtered: filtered.length,
            apis: summary,
          },
        };
      }

      case 'clear_captured_apis': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id || 0;
        const count = capturedApisByTab.get(tabId)?.length || 0;
        capturedApisByTab.set(tabId, []);
        return { success: true, action, result: `Cleared ${count} captured APIs.` };
      }

      case 'register_tool': {
        const toolData = params as Record<string, unknown>;

        // XGEN 서버 URL 결정
        let serverUrl = (toolData.server_url as string | undefined) || await resolveXgenServerUrl();
        if (!serverUrl) {
          return { success: false, action, error: 'XGEN server URL not found. Log in to XGEN first.' };
        }

        const authToken = tokensByOrigin[serverUrl] || await getStoredToken(serverUrl);
        if (!authToken) {
          return { success: false, action, error: `Not logged in to ${serverUrl}` };
        }

        // 인증 프로필 자동 매칭: api_url 도메인과 일치하는 auth profile 찾기
        let authProfileId = toolData.auth_profile_id as string | undefined;
        if (!authProfileId) {
          const matchResult = await autoMatchAuthProfile(serverUrl, authToken, toolData.api_url as string);
          if (matchResult === 'LOGIN_REQUIRED') {
            return {
              success: false,
              action,
              error: `이 API는 인증이 필요합니다. 해당 사이트에서 로그인해주세요. API hook이 활성 상태에서 로그인하면 자동으로 인증 프로필이 생성됩니다. 로그인 후 다시 등록을 시도해주세요.`,
            };
          }
          authProfileId = matchResult || undefined;
        }

        // tool 저장 요청
        const savePayload = {
          function_name: toolData.function_name as string,
          content: {
            function_name: toolData.function_name as string,
            function_id: (toolData.function_id as string) || `tool_${Date.now().toString(36)}`,
            description: (toolData.description as string) || '',
            api_url: toolData.api_url as string,
            api_method: (toolData.api_method as string) || 'GET',
            api_header: (toolData.api_header as Record<string, string>) || {},
            api_body: (toolData.api_body as Record<string, unknown>) || {},
            static_body: (toolData.static_body as Record<string, unknown>) || {},
            body_type: (toolData.body_type as string) || 'application/json',
            api_timeout: (toolData.api_timeout as number) || 30,
            is_query_string: (toolData.is_query_string as boolean) || false,
            response_filter: (toolData.response_filter as boolean) || false,
            html_parser: (toolData.html_parser as boolean) || false,
            response_filter_path: (toolData.response_filter_path as string) || '',
            response_filter_field: (toolData.response_filter_field as string) || '',
            status: 'active',
            metadata: (toolData.metadata as Record<string, unknown>) || {},
            ...(authProfileId ? { auth_profile_id: authProfileId } : {}),
          },
        };

        console.log(`[XGEN SW] register_tool savePayload auth_profile_id: ${(savePayload.content as any).auth_profile_id ?? 'NONE'}`);
        const response = await fetch(`${serverUrl}/api/tools/storage/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(savePayload),
        });

        const result = await response.json();
        if (!response.ok) {
          return { success: false, action, error: result.detail || `HTTP ${response.status}` };
        }

        const authInfo = authProfileId
          ? ` (auth_profile: ${authProfileId})`
          : '';
        return {
          success: true,
          action,
          result: `Tool "${toolData.function_name}" registered successfully to ${serverUrl}${authInfo}`,
        };
      }

      default:
        return null;
    }
  } catch (err) {
    return {
      success: false,
      action,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Auth Profile 자동 매칭 ──

/**
 * api_url의 도메인과 일치하는 auth profile을 찾거나, 없으면 캡처된 인증 헤더로 자동 생성.
 */
async function autoMatchAuthProfile(
  serverUrl: string,
  authToken: string,
  apiUrl: string,
): Promise<string | undefined> {
  try {
    let apiDomain: string;
    let apiOrigin: string;
    try {
      const u = new URL(apiUrl);
      apiDomain = u.hostname;
      apiOrigin = u.origin;
    } catch {
      return undefined;
    }

    if (apiDomain === 'localhost') return undefined;

    // 1) 기존 프로필에서 도메인 매칭
    console.log(`[XGEN SW] autoMatchAuthProfile: serverUrl=${serverUrl}, apiDomain=${apiDomain}, token=${authToken?.slice(0, 20)}...`);
    const resp = await fetch(`${serverUrl}/api/session-station/v1/auth-profiles`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    console.log(`[XGEN SW] auth-profiles response: ${resp.status}`);

    if (resp.ok) {
      const profiles = await resp.json() as Array<{
        service_id: string;
        name: string;
        status: string;
      }>;

      const domainParts = apiDomain.replace('www.', '').split('.');
      const domainKey = domainParts[0];

      const matched = profiles.find((p) =>
        p.status === 'active' && (
          p.service_id.toLowerCase().includes(domainKey) ||
          p.name.toLowerCase().includes(domainKey)
        )
      );

      if (matched) {
        console.log(`[XGEN SW] Auto-matched auth profile: ${matched.service_id} for ${apiDomain}`);
        return matched.service_id;
      }
    }

    // 2) 매칭 실패 → 캡처된 로그인 요청으로 auth profile 자동 생성
    const serviceId = apiDomain.replace('www.', '').replace(/\./g, '_');

    const capturedLogin = findCapturedLoginForDomain(apiDomain);
    if (!capturedLogin) {
      const capturedAuth = findCapturedAuthForDomain(apiDomain);
      if (capturedAuth) {
        // Authorization 헤더 있지만 로그인 미캡처 → 로그인 필요
        return 'LOGIN_REQUIRED';
      }
      // Authorization 헤더 없음 — 하지만 같은 도메인에 로그인 API가 존재하면
      // 쿠키 기반 인증일 수 있으므로 로그인 필요로 판단
      // (로그인 API는 이전 캡처 세션에서 남아있을 수 있음)
      return undefined;
    }

    const profileData = buildAuthProfileFromLogin(serviceId, apiDomain, capturedLogin);

    const createResp = await fetch(`${serverUrl}/api/session-station/v1/auth-profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(profileData),
    });

    if (createResp.ok) {
      console.log(`[XGEN SW] Auto-created auth profile: ${serviceId} for ${apiDomain}`);
      return serviceId;
    }

    // 409 (already exists) — 이미 있으면 그 service_id 반환
    if (createResp.status === 409) {
      return serviceId;
    }

    const err = await createResp.text();
    console.warn(`[XGEN SW] Failed to create auth profile: ${createResp.status} ${err}`);
    return undefined;
  } catch (e) {
    console.warn('[XGEN SW] autoMatchAuthProfile error:', e);
    return undefined;
  }
}

/**
 * 캡처된 API에서 로그인 요청을 찾는다.
 * POST 메서드 + URL에 login/auth/token/signin 포함 + 요청 body에 자격증명 포함
 */
interface CapturedLogin {
  url: string;
  method: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  responseBody: Record<string, unknown>;
  tokenFields: { name: string; keyPath: string }[];
}

function findCapturedLoginForDomain(domain: string): CapturedLogin | null {
  const loginUrlPatterns = /\/(login|auth|token|signin|oauth|session)/i;

  for (const [, apis] of capturedApisByTab) {
    for (const api of apis) {
      if (api.method !== 'POST') continue;

      try {
        if (!new URL(api.url).hostname.includes(domain.replace('www.', ''))) continue;
      } catch { continue; }

      if (!loginUrlPatterns.test(api.url)) continue;

      // request body 파싱
      let payload: Record<string, unknown> = {};
      if (api.requestBody) {
        try { payload = JSON.parse(api.requestBody); } catch { continue; }
      }
      if (Object.keys(payload).length === 0) continue;

      // response body에서 토큰 필드 탐지
      let responseBody: Record<string, unknown> = {};
      if (api.responseBody) {
        try { responseBody = JSON.parse(api.responseBody); } catch { continue; }
      }

      // 토큰 필드 찾기
      const tokenFieldNames = ['access_token', 'accessToken', 'token', 'jwt', 'id_token', 'auth_token', 'session_token'];
      const tokenFields: { name: string; keyPath: string }[] = [];
      const foundNames = new Set<string>();

      // 1단계: 루트 레벨
      for (const fieldName of tokenFieldNames) {
        if (responseBody[fieldName] && typeof responseBody[fieldName] === 'string') {
          tokenFields.push({ name: fieldName, keyPath: fieldName });
          foundNames.add(fieldName);
        }
      }

      // 2단계: 중첩 구조 (payload.accessToken, data.token 등)
      for (const [topKey, topVal] of Object.entries(responseBody)) {
        if (typeof topVal === 'object' && topVal !== null) {
          for (const fieldName of tokenFieldNames) {
            if (!foundNames.has(fieldName) && (topVal as any)[fieldName] && typeof (topVal as any)[fieldName] === 'string') {
              tokenFields.push({ name: fieldName, keyPath: `${topKey}.${fieldName}` });
              foundNames.add(fieldName);
            }
          }
        }
      }

      if (tokenFields.length === 0) continue;

      // request headers에서 Content-Type만 보존
      const headers: Record<string, string> = {};
      const ct = api.requestHeaders['content-type'] || api.requestHeaders['Content-Type'];
      if (ct) headers['Content-Type'] = ct;

      console.log(`[XGEN SW] Found login request: ${api.method} ${api.url}, tokens: ${tokenFields.map(f => f.name).join(', ')}`);

      return {
        url: api.url,
        method: api.method,
        headers,
        payload,
        responseBody,
        tokenFields,
      };
    }
  }
  return null;
}

/**
 * 캡처된 로그인 요청으로 auto-refresh 가능한 auth profile을 생성한다.
 */
function buildAuthProfileFromLogin(
  serviceId: string,
  domain: string,
  login: CapturedLogin,
) {
  // 주요 토큰 필드 (첫 번째를 access_token으로 사용)
  const primaryToken = login.tokenFields[0];

  // extraction rules: 응답 body에서 토큰 추출
  const extractionRules = login.tokenFields.map((f) => ({
    name: f.name,
    source: 'body' as const,
    key_path: f.keyPath,
  }));

  // injection rules: Authorization: Bearer {access_token}
  const injectionRules = [
    {
      source_field: primaryToken.name,
      target: 'header',
      key: 'Authorization',
      value_template: `Bearer {${primaryToken.name}}`,
      required: true,
    },
  ];

  return {
    service_id: serviceId,
    name: `${domain} (자동 생성)`,
    description: `캡처된 로그인 요청으로 자동 생성된 인증 프로필. 토큰 만료 시 자동 갱신됩니다.`,
    auth_type: 'bearer',
    login_config: {
      url: login.url,
      method: login.method,
      headers: login.headers,
      payload: login.payload,
      timeout: 30,
    },
    extraction_rules: extractionRules,
    injection_rules: injectionRules,
    ttl: 3600,
    refresh_before_expire: 300,
  };
}

/**
 * 캡처된 API 데이터에서 특정 도메인의 인증 헤더를 찾는다. (fallback)
 */
function findCapturedAuthForDomain(domain: string): { type: string; key: string; value: string } | null {
  for (const [, apis] of capturedApisByTab) {
    for (const api of apis) {
      try {
        if (!new URL(api.url).hostname.includes(domain.replace('www.', ''))) continue;
      } catch { continue; }

      for (const [key, value] of Object.entries(api.requestHeaders)) {
        const k = key.toLowerCase();
        if (k === 'authorization' && value.toLowerCase().startsWith('bearer ')) {
          return { type: 'bearer', key: 'Authorization', value };
        }
        if (k === 'authorization' && value.toLowerCase().startsWith('basic ')) {
          return { type: 'basic', key: 'Authorization', value };
        }
        if (k === 'x-api-key') {
          return { type: 'api_key', key: 'X-API-Key', value };
        }
      }
    }
  }
  return null;
}

/**
 * 캡처된 인증 정보로 auth profile 생성 데이터를 구성한다.
 * login_config는 플레이스홀더 — 사용자가 나중에 실제 로그인 URL/자격증명을 설정해야 자동 갱신 가능.
 * 우선은 캡처된 토큰을 fixed 값으로 injection하여 즉시 사용 가능하게 한다.
 */
function buildAuthProfileFromCaptured(
  serviceId: string,
  domain: string,
  serverUrl: string,
  auth: { type: string; key: string; value: string },
) {
  // 토큰 값 추출 (예: "Bearer xxx" → "xxx")
  const tokenValue = auth.value.includes(' ') ? auth.value.split(' ').slice(1).join(' ') : auth.value;
  const prefix = auth.value.includes(' ') ? auth.value.split(' ')[0] + ' ' : '';

  return {
    service_id: serviceId,
    name: `${domain} (자동 생성)`,
    description: `Element Picker에서 자동 생성된 인증 프로필. 로그인 자동 갱신을 위해 login_config를 업데이트하세요.`,
    auth_type: auth.type,
    login_config: {
      // gateway health 엔드포인트로 200 응답 보장 — fixed extraction은 응답 내용 무관
      url: `${serverUrl}/api/health`,
      method: 'GET',
      headers: {},
      payload: {},
      timeout: 10,
    },
    extraction_rules: [
      {
        name: 'access_token',
        source: 'fixed',
        value: tokenValue,
      },
    ],
    injection_rules: [
      {
        source_field: 'access_token',
        target: 'header',
        key: auth.key,
        value_template: `${prefix}{access_token}`,
        required: true,
      },
    ],
    ttl: 3600,
    refresh_before_expire: 300,
  };
}

// ── 로그인 캡처 시 auth profile 즉시 생성 ──

async function autoCreateAuthProfileFromCapture(loginUrl: string) {
  try {
    const apiDomain = new URL(loginUrl).hostname;
    const serverUrl = await resolveXgenServerUrl();
    if (!serverUrl) return;

    const authToken = tokensByOrigin[serverUrl] || await getStoredToken(serverUrl);
    if (!authToken) return;

    // 이미 프로필 있는지 확인
    const resp = await fetch(`${serverUrl}/api/session-station/v1/auth-profiles`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (resp.ok) {
      const profiles = await resp.json() as Array<{ service_id: string; status: string }>;
      const serviceId = apiDomain.replace('www.', '').replace(/\./g, '_');
      if (profiles.some((p) => p.service_id === serviceId)) {
        console.log(`[XGEN SW] Auth profile already exists: ${serviceId}`);
        return;
      }
    }

    // 로그인 캡처 찾기
    const capturedLogin = findCapturedLoginForDomain(apiDomain);
    if (!capturedLogin) return;

    const serviceId = apiDomain.replace('www.', '').replace(/\./g, '_');
    const profileData = buildAuthProfileFromLogin(serviceId, apiDomain, capturedLogin);

    const createResp = await fetch(`${serverUrl}/api/session-station/v1/auth-profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(profileData),
    });

    if (createResp.ok) {
      console.log(`[XGEN SW] Auto-created auth profile on login capture: ${serviceId}`);
    } else if (createResp.status === 409) {
      console.log(`[XGEN SW] Auth profile already exists: ${serviceId}`);
    }
  } catch (e) {
    console.warn('[XGEN SW] autoCreateAuthProfileFromCapture error:', e);
  }
}

// ── Element Picker: hook inject ──
async function handlePickerHookInject(tabId: number) {
  if (!hookedTabs.has(tabId)) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: apiHookRelayFunction,
      world: 'ISOLATED' as any,
    }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId },
      func: mainWorldHookFunction,
      world: 'MAIN' as any,
    }).catch(() => {});
    hookedTabs.add(tabId);
    capturedApisByTab.set(tabId, []);
  } else {
    capturedApisByTab.set(tabId, []);
  }
}

// ── 탭 닫힘 시 정리 ──
chrome.tabs.onRemoved.addListener((tabId) => {
  hookedTabs.delete(tabId);
  capturedApisByTab.delete(tabId);
});

// ── 페이지 네비게이션 감지: 후킹된 탭에서 페이지 이동 시 자동 재주입 + 기록 ──
chrome.webNavigation.onCompleted.addListener(async (details) => {
  // 메인 프레임만 (iframe 무시)
  if (details.frameId !== 0) return;
  const tabId = details.tabId;

  if (!hookedTabs.has(tabId)) return;

  // 네비게이션 기록을 캡처 데이터에 추가
  if (!capturedApisByTab.has(tabId)) {
    capturedApisByTab.set(tabId, []);
  }
  capturedApisByTab.get(tabId)!.push({
    id: crypto.randomUUID(),
    tabId,
    timestamp: Date.now(),
    url: details.url,
    method: 'NAVIGATION',
    requestHeaders: {},
    requestBody: null,
    responseStatus: 200,
    responseHeaders: {},
    responseBody: null,
    contentType: '',
    duration: 0,
  } as CapturedApi);

  // hook 자동 재주입 (페이지 이동으로 이전 hook 소멸)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: apiHookRelayFunction,
      world: 'ISOLATED' as any,
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: mainWorldHookFunction,
      world: 'MAIN' as any,
    });
    console.log(`[XGEN SW] API hook re-injected after navigation: ${details.url}`);
  } catch (err) {
    console.warn('[XGEN SW] Failed to re-inject hook:', err);
  }
});

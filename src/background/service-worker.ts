import { streamChat } from '../shared/api';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  STORAGE_KEYS,
} from '../shared/constants';
import type {
  AiChatRequest,
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
let activeAbortController: AbortController | null = null;

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

      case 'SEND_MESSAGE':
        handleSendMessage(message.content, message.summary);
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

// ── Core: handle user message ──

async function handleSendMessage(content: string, summary?: string) {
  activeAbortController?.abort();
  activeAbortController = new AbortController();

  const settings = await chrome.storage.local.get([
    STORAGE_KEYS.PROVIDER,
    STORAGE_KEYS.MODEL,
  ]);

  // XGEN 서버 URL 결정: 저장된 XGEN origin 우선, 없으면 active tab origin
  const serverUrl = await resolveXgenServerUrl();
  if (!serverUrl) {
    broadcastToSidePanel({ type: 'STREAM_ERROR', error: 'XGEN에 먼저 로그인해주세요 (XGEN 페이지에서 한 번 접속하면 세션이 유지됩니다)' });
    return;
  }

  const authToken = tokensByOrigin[serverUrl] || await getStoredToken(serverUrl);
  if (!authToken) {
    broadcastToSidePanel({ type: 'STREAM_ERROR', error: `${serverUrl}에 먼저 로그인해주세요` });
    return;
  }

  const provider = settings[STORAGE_KEYS.PROVIDER] || DEFAULT_PROVIDER;
  const model = settings[STORAGE_KEYS.MODEL] || DEFAULT_MODEL;

  const pageContext = await getPageContextFromTab().catch((err) => {
    console.warn('[XGEN SW] getPageContextFromTab 실패:', err);
    return null;
  });
  console.log('[XGEN SW] pageContext:', pageContext ? `elements=${pageContext.elements?.length ?? 0}ch, pageType=${pageContext.pageType}` : 'null');

  const request: AiChatRequest = {
    messages: [{ role: 'user', content }],
    provider,
    model,
    ...(summary ? { conversation_summary: summary } : {}),
    ...(pageContext ? { page_context: pageContext } : {}),
    ...(pageContext?.pageType === 'canvas' && pageContext.data?.canvasState
      ? { canvas_state: pageContext.data.canvasState as Record<string, unknown> }
      : {}),
  };

  try {
    for await (const event of streamChat(serverUrl, authToken, request)) {
      if (activeAbortController?.signal.aborted) break;
      await handleSSEEvent(event);
    }

    broadcastToSidePanel({ type: 'STREAM_DONE' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const error = `${msg}\n(서버: ${serverUrl}/api/ai-chat/stream)`;
    broadcastToSidePanel({ type: 'STREAM_ERROR', error });
  }
}

// ── SSE event routing ──

async function handleSSEEvent(event: SSEEvent) {
  switch (event.type) {
    case 'token':
      broadcastToSidePanel({ type: 'STREAM_TOKEN', content: event.content });
      break;

    case 'tool_start':
      broadcastToSidePanel({ type: 'TOOL_START', tool: event.tool, input: event.input });
      break;

    case 'tool_end':
      broadcastToSidePanel({ type: 'TOOL_END', tool: event.tool, output: event.output });
      break;

    case 'canvas_command':
      await sendToContentScript({
        type: 'CANVAS_COMMAND',
        requestId: (event as any).requestId || crypto.randomUUID(),
        action: event.action,
        params: event.params,
      });
      break;

    case 'page_command': {
      const requestId = (event as any).requestId || crypto.randomUUID();

      // API Hook 액션은 SW에서 직접 처리 (content script로 보내지 않음)
      const apiHookResult = await handleApiHookAction(event.action, event.params);
      if (apiHookResult) {
        await postCommandResultToBackend(requestId, apiHookResult);
        break;
      }

      // 그 외 액션은 content script로 전달
      await sendToContentScript({
        type: 'PAGE_COMMAND',
        requestId,
        action: event.action,
        params: event.params,
      });
      break;
    }

    case 'token_usage':
      broadcastToSidePanel({ type: 'STREAM_TOKEN_USAGE', tokenUsage: (event as any).usage });
      break;

    case 'error':
      broadcastToSidePanel({ type: 'STREAM_ERROR', error: event.content });
      break;

    case 'done':
      break;
  }
}

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
  // 1순위: 이미 토큰이 있는 xgen origin
  const xgenOrigin = Object.keys(tokensByOrigin).find((o) => o.includes('xgen'));
  if (xgenOrigin) return xgenOrigin;

  // 2순위: storage에 저장된 서버 URL
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SERVER_URL);
  const storedUrl = stored[STORAGE_KEYS.SERVER_URL] as string | undefined;
  if (storedUrl) {
    // 토큰도 복원 시도
    const token = await getStoredToken(storedUrl);
    if (token) return storedUrl;
  }

  // 3순위: active tab이 XGEN인 경우
  const tabOrigin = await getOriginFromTab();
  if (tabOrigin?.includes('xgen')) return tabOrigin;

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
    await chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
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
          },
        };

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

        return {
          success: true,
          action,
          result: `Tool "${toolData.function_name}" registered successfully to ${serverUrl}`,
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

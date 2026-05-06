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

// AI agent가 page_command/canvas_command로 탭을 운전 중인 윈도우.
// 이 시간 동안 캡처된 API는 origin='ai'로 태깅되어 사용자 capture session에서 제외된다.
// Map<tabId, expiresAtMs>. dispatchPageCommand 호출 시점에 ~2초 갱신.
const aiDrivingTabIds = new Map<number, number>();
const AI_DRIVE_WINDOW_MS = 2000;

function markAiDriving(tabId: number): void {
  aiDrivingTabIds.set(tabId, Date.now() + AI_DRIVE_WINDOW_MS);
}

function isAiDriving(tabId: number): boolean {
  const expires = aiDrivingTabIds.get(tabId);
  if (!expires) return false;
  if (Date.now() >= expires) {
    aiDrivingTabIds.delete(tabId);
    return false;
  }
  return true;
}

// ── User Capture Session State ──
// 사용자가 🔴 버튼으로 시작 → 같은 탭에서 발생한 origin='user' 캡처를 누적 → ⏹로 종료.
// 다른 탭으로 전환해도 원래 탭의 캡처만 모음 (사용자 요청).
interface CaptureSession {
  tabId: number;
  startedAt: number;
  captures: CapturedApi[];
}
let activeCaptureSession: CaptureSession | null = null;
const CAPTURE_SESSION_MAX = 500; // FIFO 상한 — 5분 무활동 자동종료는 Phase 2에서 추가

// 캡처 종료 후 sidepanel이 mount되기 전 broadcast가 발사되는 race를 막기 위한 캐시.
// sidepanel이 GET_CAPTURE_RESULT로 한 번 가져가면 null로 소비.
let cachedCaptureResult: {
  apis: CapturedApi[];
  tabId: number;
  durationMs: number;
} | null = null;

// ── Side Panel open on icon click ──

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

/**
 * origin이 XGEN 자체 호스트인지 — 이걸로 SET_ORIGIN/SET_TOKEN/resolver/startup migration 모두 검증.
 * fo.x2bee.com 같은 형제 서브도메인이 storage/메모리/resolver에 끼어들지 못하게 막는 single source of truth.
 */
function isXgenOrigin(origin: string): boolean {
  return /^https?:\/\/(xgen\.x2bee\.com|xgen\.[^/:]+|[^/:]+\.xgen\.x2bee\.com|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)(\/|$)/.test(origin);
}

// ── Startup: migrate stale storage from earlier buggy versions ──
// 과거 버그로 들어온 비-XGEN serverUrl / token:* 키를 정리. 사용자가 storage 직접 손대지 않아도 됨.
chrome.storage.local.get(null, (items) => {
  const toRemove: string[] = [];
  const stored = items[STORAGE_KEYS.SERVER_URL] as string | undefined;
  if (stored && !isXgenOrigin(stored)) {
    toRemove.push(STORAGE_KEYS.SERVER_URL);
    console.warn('[XGEN SW] Removing stale non-XGEN serverUrl:', stored);
  }
  for (const key of Object.keys(items)) {
    if (key.startsWith('token:')) {
      const origin = key.slice(6);
      if (!isXgenOrigin(origin)) {
        toRemove.push(key);
        console.warn('[XGEN SW] Removing stale non-XGEN token key:', key);
      }
    }
  }
  if (toRemove.length > 0) {
    chrome.storage.local.remove(toRemove);
  }
});

// ── Message handling ──

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    switch (message.type) {
      case 'SET_TOKEN': {
        const origin = message.origin || sender.origin || '';
        // SET_ORIGIN과 동일하게 XGEN origin만 토큰 저장 — fo.x2bee.com 등 형제 서브도메인이
        // 자기 토큰을 우리 storage에 영구 박아넣지 못하게.
        if (origin && isXgenOrigin(origin)) {
          tokensByOrigin[origin] = message.token;
          chrome.storage.local.set({ [`token:${origin}`]: message.token });
          // SettingsBar 호환: 마지막 토큰을 기본값으로도 저장 (XGEN 토큰만)
          chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKEN]: message.token });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SET_ORIGIN': {
        // content script(token-extractor)에서 자동 호출되므로 origin이 정말 XGEN인지 검증.
        const origin = message.origin || '';
        if (isXgenOrigin(origin)) {
          chrome.storage.local.set({ [STORAGE_KEYS.SERVER_URL]: origin });
        }
        sendResponse({ ok: true });
        break;
      }

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
              // 로컬 환경에서만 프론트엔드(3000/3001) → gateway(8000)로 교체
              // 서버 환경(외부 도메인)에서는 포트 교체 안 함 (방화벽/프록시 이슈)
              const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
              if (isLocal && (parsed.port === '3000' || parsed.port === '3001')) {
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
          // AI agent의 직접 dispatch — 이후 ~2초 캡처를 origin='ai'로 태깅하기 위해 active tab 마킹
          const tabsForMark = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabsForMark[0]?.id) markAiDriving(tabsForMark[0].id);

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
              // 네비게이션 생존주기 처리 포함 디스패치
              await dispatchPageCommand(requestId, event.action, event.params);
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

      case 'PAGE_CONTEXT_UPDATE': {
        const senderTabId = sender.tab?.id ?? null;
        cachedPageContext = message.context;
        cachedPageContextTabId = senderTabId;
        broadcastToSidePanel({
          type: 'PAGE_CONTEXT_UPDATE',
          context: message.context,
          tabId: senderTabId ?? undefined,
        });
        sendResponse({ ok: true });
        break;
      }

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
        captured.origin = isAiDriving(tabId) ? 'ai' : 'user';

        if (!capturedApisByTab.has(tabId)) {
          capturedApisByTab.set(tabId, []);
        }
        capturedApisByTab.get(tabId)!.push(captured);

        // 사용자 capture session에 누적: 같은 탭 + origin='user'만
        if (
          activeCaptureSession &&
          activeCaptureSession.tabId === tabId &&
          captured.origin === 'user'
        ) {
          activeCaptureSession.captures.push(captured);
          if (activeCaptureSession.captures.length > CAPTURE_SESSION_MAX) {
            // FIFO: 오래된 것 버림
            activeCaptureSession.captures.shift();
          }
          broadcastCaptureStatus({
            active: true,
            tabId: activeCaptureSession.tabId,
            count: activeCaptureSession.captures.length,
          });
        }

        // 로그인 요청 감지 시 auth profile 즉시 자동 생성
        if (captured.method === 'POST' && /\/(login|auth|token|signin|oauth|session)/i.test(captured.url)) {
          autoCreateAuthProfileFromCapture(captured.url).catch(() => {});
        }

        sendResponse({ ok: true });
        break;
      }

      // ── User Capture Session ──
      case 'START_CAPTURE_SESSION': {
        (async () => {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = tabs[0]?.id;
          if (!tabId) {
            sendResponse({ ok: false, error: 'No active tab' });
            return;
          }
          activeCaptureSession = { tabId, startedAt: Date.now(), captures: [] };
          // content script가 아직 hook 주입 안 됐다면 주입 (ELEMENT_PICKER_STOP과 동일한 진입점 재사용).
          // 부수효과로 capturedApisByTab[tabId]가 리셋되지만 session 버퍼는 별도라 영향 없음.
          await handlePickerHookInject(tabId).catch(() => {});
          broadcastCaptureStatus({ active: true, tabId, count: 0 });
          sendResponse({ ok: true, tabId });
        })();
        return true;
      }

      case 'STOP_FLOATING_CAPTURE':
      case 'STOP_CAPTURE_SESSION': {
        if (!activeCaptureSession) {
          sendResponse({ ok: false, error: 'No active session' });
          break;
        }
        const session = activeCaptureSession;
        activeCaptureSession = null;

        // 1. 사이드패널 즉시 열기 (await 전에) — overlay 클릭으로 전달된 user gesture가
        //    살아있는 동안 호출해야 한다. await/setOptions 끼면 gesture 끊겨서 무음 실패.
        chrome.sidePanel.open({ tabId: session.tabId }).catch((err) => {
          console.warn('[XGEN SW] sidePanel.open on stop failed:', err);
        });

        // 2. 결과 캐시 — sidepanel이 mount되기 전에 broadcast가 끝나는 race를 막기 위해.
        //    sidepanel 첫 mount 시 GET_CAPTURE_RESULT로 직접 query.
        cachedCaptureResult = {
          apis: session.captures,
          tabId: session.tabId,
          durationMs: Date.now() - session.startedAt,
        };

        // 3. STATUS 브로드캐스트 — sidepanel + 캡처 탭(overlay 자동 hide).
        broadcastCaptureStatus({ active: false, tabId: session.tabId });
        // 4. 이미 열려있던 sidepanel을 위해 결과 브로드캐스트 (놓쳐도 cachedCaptureResult가 안전망).
        broadcastToSidePanel({
          type: 'CAPTURE_SESSION_RESULT',
          apis: session.captures,
          tabId: session.tabId,
          durationMs: Date.now() - session.startedAt,
        });

        sendResponse({ ok: true, count: session.captures.length });
        break;
      }

      case 'GET_CAPTURE_RESULT': {
        // sidepanel이 STOP 이후 새로 열린 경우 broadcast를 놓쳤으니 직접 가져감.
        // 한 번 읽으면 소비 (다음 mount 시 재노출 방지).
        const result = cachedCaptureResult;
        cachedCaptureResult = null;
        sendResponse({ ok: true, result });
        break;
      }

      case 'LOOKUP_AUTH_PROFILE_FOR_HOST': {
        // host에 대해 등록된 인증 프로필의 service_id 조회. autoMatchAuthProfile 재사용 —
        // 같은 도메인 키워드 매칭 + 캡처된 로그인 fallback. 결과를 collection 등록 시
        // auth_profile_id로 같이 넘겨 tool row까지 자동 propagate.
        (async () => {
          try {
            const serverUrl = await resolveXgenServerUrl();
            const authToken = serverUrl
              ? (tokensByOrigin[serverUrl] || await getStoredToken(serverUrl))
              : '';
            if (!serverUrl || !authToken) {
              sendResponse({ ok: false, error: 'no XGEN auth' });
              return;
            }
            // autoMatchAuthProfile은 api_url 인자를 받음 — 도메인만 알면 충분하니 dummy URL.
            const profileId = await autoMatchAuthProfile(
              serverUrl, authToken, `https://${message.host}/`,
            );
            sendResponse({ ok: true, authProfileId: profileId || null });
          } catch (err) {
            console.warn('[XGEN SW] LOOKUP_AUTH_PROFILE_FOR_HOST failed:', err);
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      case 'GET_LIVE_COOKIES': {
        // 사용자 브라우저가 그 host에 대해 들고있는 fresh 쿠키를 모두 모아 Cookie 헤더 문자열로
        // 변환. 캡처 시점의 stale 쿠키 대신 호출 시점의 살아있는 세션 사용. host_permissions
        // <all_urls>가 manifest에 있어서 어떤 host든 읽기 가능.
        (async () => {
          try {
            const cookies = await chrome.cookies.getAll({ domain: message.host });
            // 같은 이름이 여러 path에 걸려있으면 longest-path가 일반적으로 우선 — 단순화 위해
            // 첫 발견 우선. 도메인은 .x2bee.com과 fo.x2bee.com 둘 다 들어옴 (chrome 동작).
            const seen = new Set<string>();
            const parts: string[] = [];
            for (const c of cookies) {
              if (seen.has(c.name)) continue;
              seen.add(c.name);
              parts.push(`${c.name}=${c.value}`);
            }
            sendResponse({ ok: true, cookieHeader: parts.join('; '), count: cookies.length });
          } catch (err) {
            console.warn('[XGEN SW] GET_LIVE_COOKIES failed:', err);
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;  // async response
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
      const origin = key.slice(6);
      // XGEN origin만 메모리에 로드. (storage 자체는 위 startup migration이 청소)
      if (isXgenOrigin(origin)) {
        tokensByOrigin[origin] = value;
      }
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
 * XGEN 서버 URL을 결정한다. 모든 단계에서 isXgenOrigin으로 검증 — 비-XGEN origin은 절대 반환 X.
 *
 * 1순위: 토큰이 있는 XGEN origin (메모리 캐시)
 * 2순위: storage에 저장된 serverUrl (단, XGEN origin인지 검증)
 * 3순위: active tab의 origin (XGEN 페이지인 경우)
 */
async function resolveXgenServerUrl(): Promise<string | null> {
  // 1순위: active tab의 origin
  const tabOrigin = await getOriginFromTab();
  if (tabOrigin && isXgenOrigin(tabOrigin)) return tabOrigin;

  // 2순위: storage에 저장된 서버 URL — 반드시 XGEN origin이어야 함.
  // 이전 버그로 fo.x2bee.com 같은 게 저장돼있을 수 있어서 startup migration이 청소하지만
  // 런타임에서도 한 번 더 가드.
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SERVER_URL);
  const storedUrl = stored[STORAGE_KEYS.SERVER_URL] as string | undefined;
  if (storedUrl && isXgenOrigin(storedUrl)) {
    const token = await getStoredToken(storedUrl);
    if (token) return storedUrl;
  }

  // 3순위: 토큰이 있는 XGEN origin (메모리)
  const xgenOrigin = Object.keys(tokensByOrigin).find((o) => isXgenOrigin(o));
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

/**
 * PAGE_COMMAND 전용 디스패치 — 네비게이션 생존주기 처리 포함.
 *
 * 클릭 등의 DOM 조작이 전체 페이지 네비게이션(window.location 변경)을 유발할 수 있다.
 * 이 경우 content script가 소멸하면서 결과 메시지가 유실되고 백엔드 bridge가 타임아웃된다.
 *
 * 해결: sendMessage 실패(채널 끊김) 시 네비게이션 완료를 대기하고,
 * 새 페이지의 context를 추출하여 백엔드에 성공 결과로 전달한다.
 */
async function dispatchPageCommand(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0 || !tabs[0].id) {
    await postCommandResultToBackend(requestId, {
      success: false, action, error: 'No active tab found',
    });
    return;
  }

  const tabId = tabs[0].id;
  const urlBefore = tabs[0].url || '';

  try {
    // content script가 살아있으면 정상 실행 → PAGE_COMMAND_RESULT로 결과 전달됨
    await chrome.tabs.sendMessage(tabId, {
      type: 'PAGE_COMMAND',
      requestId,
      action,
      params,
    } as ExtensionMessage);
    // sendMessage resolved = content script가 sendResponse() 호출 = 정상 완료.
    // 결과는 content script가 별도 PAGE_COMMAND_RESULT 메시지로 이미 전송함.
  } catch (err) {
    // ── content script 소멸 — 대부분 페이지 네비게이션 때문 ──
    console.log(
      `[XGEN SW] PAGE_COMMAND delivery failed (action=${action}), ` +
      `waiting for navigation: ${err}`,
    );

    try {
      const newContext = await waitForNavigationContext(tabId, urlBefore);
      await postCommandResultToBackend(requestId, {
        success: true,
        action,
        pageContext: newContext,
      });
      console.log(`[XGEN SW] Navigation handled: posted new page context to backend`);
    } catch (navErr) {
      // 네비게이션도 없고 content script도 죽은 경우 — 진짜 실패
      await postCommandResultToBackend(requestId, {
        success: false,
        action,
        error: `Content script disconnected, no navigation detected: ${navErr}`,
      });
    }
  }
}

/**
 * 페이지 네비게이션 완료를 대기하고 새 페이지의 context를 추출한다.
 * 이미 네비게이션이 진행 중일 수 있으므로, onCompleted 리스너 + 폴링을 병행한다.
 */
function waitForNavigationContext(
  tabId: number,
  urlBefore: string,
  timeoutMs: number = 10000,
): Promise<PageContext | null> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.webNavigation.onCompleted.removeListener(onNavCompleted);
      clearTimeout(timer);
    };

    const extractAndResolve = async () => {
      if (settled) return;
      settled = true;
      cleanup();

      // content script 초기화 대기 — manifest의 content_scripts 주입에 시간이 필요
      await new Promise((r) => setTimeout(r, 800));

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const ctx = await chrome.tabs.sendMessage(tabId, {
            type: 'GET_PAGE_CONTEXT',
          });
          if (ctx) {
            resolve(ctx as PageContext);
            return;
          }
        } catch {
          // content script 아직 준비 안 됨 — 재시도
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // 3회 시도 실패 — 기본 context 생성
      try {
        const tab = await chrome.tabs.get(tabId);
        resolve({
          pageType: 'unknown',
          url: tab.url || '',
          title: tab.title || '',
          elements: '',
          snapshotId: '',
          data: {},
          availableActions: [],
          timestamp: Date.now(),
        } as PageContext);
      } catch {
        resolve(null);
      }
    };

    const onNavCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      console.log(`[XGEN SW] Navigation completed: ${details.url}`);
      extractAndResolve();
    };

    chrome.webNavigation.onCompleted.addListener(onNavCompleted);

    // 타임아웃 — 네비게이션이 없거나 너무 느린 경우
    const timer = setTimeout(() => {
      if (settled) return;
      // 타임아웃이지만 URL이 바뀌었을 수 있음 (onCompleted 놓침)
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.url && tab.url !== urlBefore) {
          extractAndResolve();
        } else {
          settled = true;
          cleanup();
          reject(new Error(`Navigation timeout (${timeoutMs}ms), URL unchanged`));
        }
      }).catch(() => {
        settled = true;
        cleanup();
        reject(new Error('Tab not found'));
      });
    }, timeoutMs);
  });
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

/**
 * CAPTURE_SESSION_STATUS를 sidepanel과 (지정된) 탭 content script 둘 다로 전달.
 * 플로팅 overlay가 count/active 상태를 직접 보려면 tab 쪽으로도 보내야 한다.
 */
function broadcastCaptureStatus(payload: {
  active: boolean;
  tabId?: number;
  count?: number;
}) {
  const msg: ExtensionMessage = { type: 'CAPTURE_SESSION_STATUS', ...payload };
  broadcastToSidePanel(msg);
  if (payload.tabId !== undefined) {
    chrome.tabs.sendMessage(payload.tabId, msg).catch(() => {});
  }
}

/** 외부 사이트에서만 우클릭 메뉴 노출 — XGEN/localhost는 의미 없음. */
function isCapturableHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname;
    if (h === 'xgen.x2bee.com' || h.startsWith('xgen.') || h.endsWith('.xgen.x2bee.com')) return false;
    if (h === 'localhost' || h === '127.0.0.1') return false;
    return true;
  } catch {
    return false;
  }
}

// ── Context Menu: 우클릭 → API 스캔 ──
const CTX_MENU_ID = 'xgen-api-scan';

chrome.runtime.onInstalled.addListener(() => {
  // 이전 항목이 있으면 제거 후 재생성 (개발 시 reload 안전).
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CTX_MENU_ID,
      title: 'XGEN: API 스캔 시작',
      contexts: ['page', 'frame', 'selection', 'link', 'image'],
      // documentUrlPatterns가 부정 매치를 못하므로, 클릭 시점에 isCapturableHost로 필터.
      documentUrlPatterns: ['*://*/*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CTX_MENU_ID) return;
  if (!tab?.id) return;

  const url = tab.url || info.pageUrl || '';
  if (!isCapturableHost(url)) {
    // XGEN/로컬 페이지에선 의미 없음 — 조용히 무시.
    return;
  }

  // 이미 다른 탭에서 캡처 중이면 우선 종료. (단순화: 동시 1개 세션만)
  if (activeCaptureSession && activeCaptureSession.tabId !== tab.id) {
    const prev = activeCaptureSession;
    activeCaptureSession = null;
    broadcastCaptureStatus({ active: false, tabId: prev.tabId });
    chrome.tabs.sendMessage(prev.tabId, { type: 'HIDE_FLOATING_OVERLAY' }).catch(() => {});
  }

  // Start 단계에서는 사이드패널을 열지 않는다 — 페이지 시야 확보가 우선.
  // 사이드패널은 정지 시(STOP_FLOATING_CAPTURE 핸들러)에 열어서 결과 리스트를 보여준다.

  // 캡처 세션 시작 — 기존 START_CAPTURE_SESSION 로직과 동일.
  activeCaptureSession = { tabId: tab.id, startedAt: Date.now(), captures: [] };
  await handlePickerHookInject(tab.id).catch(() => {});

  // overlay 표시 — content script가 안 떠있는 탭(확장 reload 후 기존 탭)에서도 동작하도록
  // tabs.sendMessage 실패하면 scripting.executeScript로 직접 주입.
  await showFloatingOverlayOnTab(tab.id);
  broadcastCaptureStatus({ active: true, tabId: tab.id, count: 0 });
});

/**
 * 탭에 floating overlay 표시. content script가 이미 주입돼있으면 그쪽 listener가
 * SHOW_FLOATING_OVERLAY를 받아 띄움. 아니면 chrome.scripting.executeScript로 페이지에
 * 인라인 overlay 주입 (count 갱신은 chrome.runtime.onMessage listener도 같이 등록).
 */
async function showFloatingOverlayOnTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_FLOATING_OVERLAY' });
    return;
  } catch {
    // content script not loaded — fall through to scripting injection
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: _injectFloatingOverlayInline,
    });
  } catch (err) {
    console.warn('[XGEN SW] floating overlay scripting fallback failed:', err);
  }
}

/**
 * scripting.executeScript용 — page isolated world에서 실행. 호스트 페이지에 overlay 주입 +
 * STOP 클릭/STATUS 갱신/HIDE 처리 로직을 모두 인라인으로 가짐. content script가 떠있으면
 * 중복 주입 방지(id 체크).
 */
function _injectFloatingOverlayInline(): void {
  const HOST_ID = '__xgen_floating_overlay__';
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;top:0;right:0;z-index:2147483647;';

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .root {
        position: fixed; top: 16px; right: 16px;
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px;
        background: #1f2937; color: #fff;
        border-radius: 999px;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
      }
      .dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #ef4444;
        animation: xgen-pulse 1.4s infinite;
      }
      @keyframes xgen-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.85); }
      }
      .count {
        background: rgba(255, 255, 255, 0.15);
        padding: 2px 8px; border-radius: 999px;
        min-width: 20px; text-align: center;
      }
      .stop {
        all: unset; cursor: pointer;
        width: 22px; height: 22px;
        display: inline-flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.12);
        border-radius: 50%;
      }
      .stop:hover { background: #ef4444; }
    </style>
    <div class="root">
      <span class="dot"></span>
      <span>API 녹화 중</span>
      <span class="count">0</span>
      <button class="stop" type="button" title="정지">
        <svg viewBox="0 0 14 14" fill="currentColor" width="10" height="10">
          <rect x="1" y="1" width="12" height="12" rx="2"/>
        </svg>
      </button>
    </div>
  `;

  const stopBtn = shadow.querySelector('.stop') as HTMLButtonElement | null;
  const countEl = shadow.querySelector('.count') as HTMLSpanElement | null;

  stopBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_FLOATING_CAPTURE' });
  });

  // SW가 broadcast하는 STATUS를 받아 count 갱신 + active=false면 자체 제거.
  const onMsg = (msg: { type?: string; active?: boolean; count?: number }) => {
    if (msg?.type !== 'CAPTURE_SESSION_STATUS') return;
    if (msg.active === false) {
      chrome.runtime.onMessage.removeListener(onMsg);
      host.remove();
    } else if (typeof msg.count === 'number' && countEl) {
      countEl.textContent = String(msg.count);
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);

  (document.documentElement || document.body).appendChild(host);
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
              error: `이 API는 인증이 필요하지만 로그인 요청이 캡처되지 않았습니다. ` +
                `start_api_hook이 켜진 상태에서 로그인이 수행되어야 인증 프로필이 자동 생성됩니다. ` +
                `해결 방법: (1) start_api_hook이 켜져 있는지 확인 후, (2) 로그아웃 → 재로그인으로 토큰을 재발급받은 다음, (3) register_tool을 다시 시도하세요.`,
            };
          }
          authProfileId = matchResult || undefined;
        }

        // ── 캡처된 원본 request body로 static_body/api_body 보정 ──
        // 전략: 원본 body 전체를 static_body에 주입 → 런타임에서 AI 파라미터가 있으면 덮어쓰고,
        // 없으면 원본 값으로 호출되므로 "body 빈 채로 나가서 500" 문제를 원천 차단.
        // api_body는 AI 스키마를 그대로 두되, JSON Schema 형식(properties/required)로 래핑한다.
        let aiApiBody = (toolData.api_body as Record<string, unknown>) || {};
        let aiStaticBody = (toolData.static_body as Record<string, unknown>) || {};
        let aiBodyType = (toolData.body_type as string) || 'application/json';

        try {
          const targetUrl = toolData.api_url as string;
          const targetMethod = ((toolData.api_method as string) || 'GET').toUpperCase();
          const stripQuery = (u: string) => u.split('?')[0].split('#')[0];
          const targetBase = stripQuery(targetUrl);

          // 모든 탭 캡처에서 url(쿼리 제외) + method 매칭, 가장 최근 것
          let matched: CapturedApi | undefined;
          for (const [, apis] of capturedApisByTab) {
            for (const a of apis) {
              if (a.method.toUpperCase() === targetMethod && stripQuery(a.url) === targetBase) {
                if (!matched || a.timestamp > matched.timestamp) matched = a;
              }
            }
          }

          if (matched?.requestBody) {
            const ct = (matched.contentType || '').toLowerCase();
            if (ct.includes('application/json') || matched.requestBody.trim().startsWith('{')) {
              try {
                const original = JSON.parse(matched.requestBody) as Record<string, unknown>;
                if (original && typeof original === 'object' && !Array.isArray(original)) {
                  // 1) static_body = 원본 전체 (AI static_body보다 우선)
                  aiStaticBody = { ...aiStaticBody, ...original };

                  // 2) api_body 정규화: AI가 flat하게 만들든 JSON Schema로 만들든 다 처리
                  //    - 이미 properties 키가 있으면 그대로 (JSON Schema)
                  //    - 아니면 flat 형식으로 보고 properties로 래핑
                  //    - 원본에 없는 AI 상상 필드는 제거
                  const hasProperties = 'properties' in aiApiBody &&
                    typeof (aiApiBody as any).properties === 'object';

                  if (hasProperties) {
                    const props = (aiApiBody as any).properties as Record<string, unknown>;
                    const cleanedProps: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(props)) {
                      if (k in original) cleanedProps[k] = v;
                    }
                    aiApiBody = { ...aiApiBody, properties: cleanedProps };
                  } else {
                    // flat → JSON Schema로 래핑 (기존 엔트리가 {type, description} 형태라고 가정)
                    const cleanedProps: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(aiApiBody)) {
                      if (k in original) cleanedProps[k] = v;
                    }
                    aiApiBody = { type: 'object', properties: cleanedProps, required: [] };
                  }

                  aiBodyType = 'application/json';
                  console.log(`[XGEN SW] register_tool: body normalized. ` +
                    `static_body keys=${Object.keys(aiStaticBody).join(',')}, ` +
                    `api_body.properties keys=${Object.keys((aiApiBody as any).properties || {}).join(',')}`);
                }
              } catch (e) {
                console.warn('[XGEN SW] register_tool: captured JSON body parse failed, keeping AI values', e);
              }
            } else {
              console.log(`[XGEN SW] register_tool: non-JSON captured body (contentType=${ct}), keeping AI values`);
            }
          } else {
            console.log(`[XGEN SW] register_tool: no captured match for ${targetMethod} ${targetBase}, keeping AI values`);
          }
        } catch (e) {
          console.warn('[XGEN SW] register_tool: body normalization error, keeping AI values', e);
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
            api_body: aiApiBody,
            static_body: aiStaticBody,
            body_type: aiBodyType,
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
      // 2-a) autoCreateAuthProfileFromCapture는 API_CAPTURED 시점에 fire-and-forget으로 실행됨.
      //      레이스로 인해 첫 조회에서 프로필이 아직 안 만들어졌을 수 있으므로
      //      짧게 한 번 대기 후 서버 프로필 목록을 재조회하여 구제한다.
      await new Promise(r => setTimeout(r, 500));
      try {
        const retryResp = await fetch(`${serverUrl}/api/session-station/v1/auth-profiles`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (retryResp.ok) {
          const retryProfiles = await retryResp.json() as Array<{
            service_id: string; name: string; status: string;
          }>;
          const domainParts = apiDomain.replace('www.', '').split('.');
          const domainKey = domainParts[0];
          const matched = retryProfiles.find((p) =>
            p.status === 'active' && (
              p.service_id.toLowerCase().includes(domainKey) ||
              p.name.toLowerCase().includes(domainKey)
            )
          );
          if (matched) {
            console.log(`[XGEN SW] Auto-matched auth profile on retry: ${matched.service_id} for ${apiDomain}`);
            return matched.service_id;
          }
        }
      } catch (e) {
        console.warn('[XGEN SW] retry profile fetch failed:', e);
      }

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
  aiDrivingTabIds.delete(tabId);
  if (activeCaptureSession?.tabId === tabId) {
    // 세션 중인 탭이 닫혔으면 그 시점까지의 캡처를 사이드패널로 보내고 세션 종료.
    // 탭이 이미 사라졌으니 tabs.sendMessage는 fail하지만 broadcastCaptureStatus가 catch.
    const session = activeCaptureSession;
    activeCaptureSession = null;
    broadcastCaptureStatus({ active: false, tabId: session.tabId });
    broadcastToSidePanel({
      type: 'CAPTURE_SESSION_RESULT',
      apis: session.captures,
      tabId: session.tabId,
      durationMs: Date.now() - session.startedAt,
    });
  }
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

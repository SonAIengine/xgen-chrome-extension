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

// ── State ──
// origin별 토큰 저장 — 멀티 인스턴스 (xgen.x2bee.com / jeju-xgen.x2bee.com) 동시 사용 지원
const tokensByOrigin: Record<string, string> = {};
let cachedPageContext: PageContext | null = null;
let activeAbortController: AbortController | null = null;

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

  // 항상 active tab의 origin을 서버 URL로 사용
  const serverUrl = (await getOriginFromTab()) || '';
  if (!serverUrl) {
    broadcastToSidePanel({ type: 'STREAM_ERROR', error: 'XGEN 페이지를 먼저 열어주세요' });
    return;
  }

  // active tab의 origin에 매칭되는 토큰 사용
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

    case 'page_command':
      await sendToContentScript({
        type: 'PAGE_COMMAND',
        requestId: (event as any).requestId || crypto.randomUUID(),
        action: event.action,
        params: event.params,
      });
      break;

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

async function getStoredToken(origin: string): Promise<string> {
  const result = await chrome.storage.local.get(`token:${origin}`);
  const token = result[`token:${origin}`] || '';
  if (token) {
    tokensByOrigin[origin] = token; // 메모리 캐시에도 반영
  }
  return token;
}

async function getPageContextFromTab(): Promise<PageContext | null> {
  if (cachedPageContext && Date.now() - cachedPageContext.timestamp < 2000) {
    return cachedPageContext;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0 || !tabs[0].id) return null;

  try {
    const response = await chrome.tabs.sendMessage(tabs[0].id, {
      type: 'GET_PAGE_CONTEXT',
    });
    if (response) {
      cachedPageContext = response;
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
  const serverUrl = await getOriginFromTab();
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

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

let authToken = '';
let serverOrigin = ''; // Content Script에서 받은 페이지 origin
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
      case 'SET_TOKEN':
        authToken = message.token;
        chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKEN]: message.token });
        sendResponse({ ok: true });
        break;

      case 'SET_ORIGIN':
        serverOrigin = message.origin;
        chrome.storage.local.set({ [STORAGE_KEYS.SERVER_URL]: message.origin });
        sendResponse({ ok: true });
        break;

      case 'SEND_MESSAGE':
        handleSendMessage(message.content);
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

      case 'CANVAS_RESULT':
      case 'PAGE_COMMAND_RESULT':
        sendResponse({ ok: true });
        break;
    }

    return false;
  },
);

// ── Restore state on startup ──

chrome.storage.local.get(
  [STORAGE_KEYS.AUTH_TOKEN, STORAGE_KEYS.SERVER_URL],
  (result) => {
    if (result[STORAGE_KEYS.AUTH_TOKEN]) {
      authToken = result[STORAGE_KEYS.AUTH_TOKEN];
    }
    if (result[STORAGE_KEYS.SERVER_URL]) {
      serverOrigin = result[STORAGE_KEYS.SERVER_URL];
    }
  },
);

// ── Core: handle user message ──

async function handleSendMessage(content: string) {
  activeAbortController?.abort();
  activeAbortController = new AbortController();

  const settings = await chrome.storage.local.get([
    STORAGE_KEYS.PROVIDER,
    STORAGE_KEYS.MODEL,
  ]);

  // API base URL = 브라우저에서 열린 XGEN 페이지의 origin
  const serverUrl = serverOrigin || (await getOriginFromTab()) || '';
  if (!serverUrl) {
    broadcastToSidePanel({ type: 'STREAM_ERROR', error: 'XGEN 페이지를 먼저 열어주세요' });
    return;
  }

  const provider = settings[STORAGE_KEYS.PROVIDER] || DEFAULT_PROVIDER;
  const model = settings[STORAGE_KEYS.MODEL] || DEFAULT_MODEL;

  const pageContext = await getPageContextFromTab().catch(() => null);

  const request: AiChatRequest = {
    messages: [{ role: 'user', content }],
    provider,
    model,
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
    const error = err instanceof Error ? err.message : 'Unknown error';
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
        requestId: crypto.randomUUID(),
        action: event.action,
        params: event.params,
      });
      break;

    case 'page_command':
      await sendToContentScript({
        type: 'PAGE_COMMAND',
        requestId: crypto.randomUUID(),
        action: event.action,
        params: event.params,
      });
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

function broadcastToSidePanel(message: ExtensionMessage) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

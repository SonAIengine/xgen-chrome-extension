import type { PageHandler, PageContext } from './types';
import type { ExtensionMessage } from '../../shared/types';
import { detectPageType } from './page-detector';
import { createHandlerRegistry } from './handlers';
import { CanvasHandler } from './handlers/canvas-handler';

export class PageAgent {
  private handlers: PageHandler[];
  private activeHandler: PageHandler | null = null;
  private stopNavWatch: (() => void) | null = null;

  constructor() {
    this.handlers = createHandlerRegistry();
  }

  start(): void {
    // Detect initial page and activate handler
    this.activateHandler(new URL(window.location.href));

    // Listen for messages from background SW
    chrome.runtime.onMessage.addListener(this.handleMessage);

    // Watch for SPA navigation
    this.startNavigationWatch();

    console.log('[XGEN PageAgent] Started —', this.activeHandler?.pageType);
  }

  stop(): void {
    this.activeHandler?.disconnect();
    this.activeHandler = null;
    this.stopNavWatch?.();
    chrome.runtime.onMessage.removeListener(this.handleMessage);
  }

  private activateHandler(url: URL): void {
    const newPageType = detectPageType(url);

    // Skip if same handler
    if (this.activeHandler?.pageType === newPageType) return;

    // Disconnect old handler
    this.activeHandler?.disconnect();

    // Find matching handler
    this.activeHandler =
      this.handlers.find((h) => h.pageType === newPageType && h.matches(url)) ??
      this.handlers.find((h) => h.matches(url)) ??
      this.handlers[this.handlers.length - 1]; // GenericHandler

    // Start observing
    this.activeHandler.observe((context) => {
      chrome.runtime.sendMessage({
        type: 'PAGE_CONTEXT_UPDATE',
        context,
      } satisfies ExtensionMessage).catch(() => {});
    });

    // Send initial context
    const context = this.activeHandler.extractContext();
    chrome.runtime.sendMessage({
      type: 'PAGE_CONTEXT_UPDATE',
      context,
    } satisfies ExtensionMessage).catch(() => {});

    console.log('[XGEN PageAgent] Page:', this.activeHandler.pageType);
  }

  private startNavigationWatch(): void {
    let lastUrl = window.location.href;

    const check = () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        this.activateHandler(new URL(lastUrl));
      }
    };

    // URL polling
    const interval = setInterval(check, 500);

    // Title mutation observer
    const observer = new MutationObserver(check);
    const titleEl = document.querySelector('title');
    if (titleEl) {
      observer.observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    this.stopNavWatch = () => {
      clearInterval(interval);
      observer.disconnect();
    };
  }

  private handleMessage = (
    message: ExtensionMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    switch (message.type) {
      case 'GET_PAGE_CONTEXT': {
        // Canvas 페이지에서는 비동기로 canvas_state 포함한 컨텍스트 가져옴
        // 백엔드 canvas_tools가 canvas_state를 읽어서 동작하기 때문에 필수
        if (this.activeHandler instanceof CanvasHandler) {
          this.activeHandler
            .extractContextWithCanvasState()
            .then((ctx) => sendResponse(ctx))
            .catch(() => sendResponse(this.activeHandler?.extractContext() ?? this.getFallbackContext()));
          return true; // async response
        }

        const context = this.activeHandler?.extractContext() ?? this.getFallbackContext();
        sendResponse(context);
        return false;
      }

      case 'CANVAS_COMMAND':
      case 'PAGE_COMMAND': {
        if (!this.activeHandler) {
          sendResponse({ success: false, action: message.action, error: 'No active handler' });
          return false;
        }

        this.activeHandler
          .executeCommand(message.action, message.params)
          .then((result) => {
            const responseType =
              message.type === 'CANVAS_COMMAND'
                ? 'CANVAS_RESULT'
                : 'PAGE_COMMAND_RESULT';

            chrome.runtime.sendMessage({
              type: responseType,
              requestId: message.requestId,
              result,
            } as ExtensionMessage).catch(() => {});

            sendResponse(result);
          })
          .catch((err) => {
            sendResponse({
              success: false,
              action: message.action,
              error: err instanceof Error ? err.message : 'Unknown error',
            });
          });

        return true; // async response
      }
    }

    return false;
  };

  private getFallbackContext(): PageContext {
    return {
      pageType: 'unknown',
      url: window.location.href,
      title: document.title,
      data: {},
      availableActions: ['navigate'],
      timestamp: Date.now(),
    };
  }
}

import type { PageHandler, PageContext, PageCommandResult } from '../types';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CanvasHandler implements PageHandler {
  readonly pageType = 'canvas' as const;

  private observer: MutationObserver | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private resultListener: ((e: Event) => void) | null = null;

  constructor() {
    // Listen for canvas results from the XGEN page
    this.resultListener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.requestId) return;

      const pending = this.pendingRequests.get(detail.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(detail.requestId);
        pending.resolve(detail.result);
      }
    };

    window.addEventListener('xgen:canvas-result', this.resultListener);
  }

  matches(url: URL): boolean {
    return url.pathname.includes('/canvas');
  }

  extractContext(): PageContext {
    return {
      pageType: 'canvas',
      url: window.location.href,
      title: document.title,
      data: {
        hasCanvas: !!document.querySelector('[data-testid="canvas"], .react-flow'),
      },
      availableActions: this.getAvailableActions(),
      timestamp: Date.now(),
    };
  }

  /**
   * canvas_state를 포함한 전체 컨텍스트 (비동기).
   * 백엔드의 canvas_tools가 canvas_state를 읽어서 canvas_get_nodes 등을 처리하므로,
   * AI 요청 전에 이 메서드로 실제 canvas state를 가져와야 함.
   */
  async extractContextWithCanvasState(): Promise<PageContext> {
    const base = this.extractContext();

    try {
      const canvasState = await this.sendCanvasCommand('get_canvas_state', {}, 3000);
      base.data.canvasState = canvasState;
    } catch {
      // Canvas state 가져오기 실패해도 기본 컨텍스트는 반환
    }

    return base;
  }

  getAvailableActions(): string[] {
    return [
      'get_canvas_state',
      'add_node',
      'remove_node',
      'connect',
      'disconnect',
      'update_node_param',
      'save',
      'navigate',
    ];
  }

  async executeCommand(
    action: string,
    params: Record<string, unknown>,
  ): Promise<PageCommandResult> {
    if (action === 'navigate' && typeof params.path === 'string') {
      window.location.href = params.path;
      return { success: true, action };
    }

    try {
      const result = await this.sendCanvasCommand(action, params);
      return { success: true, action, result };
    } catch (err) {
      return {
        success: false,
        action,
        error: err instanceof Error ? err.message : 'Canvas command failed',
      };
    }
  }

  observe(callback: (context: PageContext) => void): void {
    let debounceTimer: ReturnType<typeof setTimeout>;

    this.observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        callback(this.extractContext());
      }, 2000);
    });

    const canvasContainer = document.querySelector(
      '[data-testid="canvas"], .react-flow',
    );
    if (canvasContainer) {
      this.observer.observe(canvasContainer, {
        childList: true,
        subtree: true,
      });
    }
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;

    if (this.resultListener) {
      window.removeEventListener('xgen:canvas-result', this.resultListener);
      this.resultListener = null;
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Handler disconnected'));
    }
    this.pendingRequests.clear();
  }

  private sendCanvasCommand(
    action: string,
    params: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Canvas command timeout: ${action}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      window.dispatchEvent(
        new CustomEvent('xgen:canvas-command', {
          detail: { requestId, action, params },
        }),
      );
    });
  }
}

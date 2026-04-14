import { PageController } from '@page-agent/page-controller';
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
  private controller: PageController;

  constructor() {
    // PageController로 캔버스 페이지의 DOM 요소(버튼 등)를 스캔
    try {
      this.controller = new PageController({
        viewportExpansion: 3,
        highlightOpacity: 0.3,
      });
    } catch {
      this.controller = new PageController({ viewportExpansion: 3 });
    }

    // Listen for canvas results via postMessage (CSP-safe, works across isolated/main world)
    this.resultListener = (e: Event) => {
      const msg = (e as MessageEvent).data;
      if (msg?.type !== 'xgen:canvas-result') return;

      const detail = msg;
      if (!detail?.requestId) return;

      const pending = this.pendingRequests.get(detail.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(detail.requestId);
        pending.resolve(detail.result);
      }
    };

    window.addEventListener('message', this.resultListener);
  }

  matches(url: URL): boolean {
    return url.pathname.includes('/canvas');
  }

  /**
   * 캔버스 페이지 컨텍스트 — DOM elements(버튼 등) + canvas 메타데이터를 포함.
   * AI가 "노드 추가 버튼 클릭" 같은 DOM 조작도 할 수 있게 한다.
   */
  async extractContext(): Promise<PageContext> {
    // DOM 평탄화로 캔버스 페이지의 버튼/입력 요소 추출
    const state = await this.controller.getBrowserState();
    await this.controller.cleanUpHighlights();

    return {
      pageType: 'canvas',
      url: state.url,
      title: state.title,
      elements: state.content,
      data: {
        hasCanvas: !!document.querySelector('[data-testid="canvas"], [class*="Canvas_canvas"]'),
      },
      availableActions: this.getAvailableActions(),
      timestamp: Date.now(),
    };
  }

  /**
   * canvas_state를 포함한 전체 컨텍스트 (비동기).
   * DOM elements + 캔버스 노드/엣지 상태를 함께 제공.
   */
  async extractContextWithCanvasState(): Promise<PageContext> {
    const base = await this.extractContext();

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
      'click_element',
      'input_text',
      'select_option',
      'scroll',
      'get_canvas_state',
      'add_node',
      'remove_node',
      'connect',
      'disconnect',
      'update_node_param',
      'save',
    ];
  }

  async executeCommand(
    action: string,
    params: Record<string, unknown>,
  ): Promise<PageCommandResult> {
    // DOM 조작 (page_command) — 버튼 클릭, 입력 등
    switch (action) {
      case 'click_element':
        await this.controller.clickElement(params.index as number);
        return this.buildPageResult(action);

      case 'input_text':
        await this.controller.inputText(params.index as number, params.text as string);
        return this.buildPageResult(action);

      case 'select_option':
        await this.controller.selectOption(params.index as number, params.text as string);
        return this.buildPageResult(action);

      case 'scroll':
        await this.controller.scroll({
          down: (params.down as boolean) ?? true,
          numPages: (params.num_pages as number) ?? 1,
        });
        return this.buildPageResult(action);
    }

    // Canvas 조작 (canvas_command) — CustomEvent 브릿지
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
      debounceTimer = setTimeout(async () => {
        callback(await this.extractContext());
      }, 2000);
    });

    const canvasContainer = document.querySelector(
      '[data-testid="canvas"], [class*="Canvas_canvas"]',
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
      window.removeEventListener('message', this.resultListener);
      this.resultListener = null;
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Handler disconnected'));
    }
    this.pendingRequests.clear();
  }

  /** DOM 조작 후 페이지 상태를 재스캔하여 반환 */
  private async buildPageResult(action: string): Promise<PageCommandResult> {
    await new Promise((r) => setTimeout(r, 300));
    const state = await this.controller.getBrowserState();
    await this.controller.cleanUpHighlights();
    return {
      success: true,
      action,
      pageContext: {
        pageType: 'canvas',
        url: state.url,
        title: state.title,
        elements: state.content,
        data: {},
        availableActions: this.getAvailableActions(),
        timestamp: Date.now(),
      },
    };
  }

  private sendCanvasCommand(
    action: string,
    params: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Canvas command timeout: ${action}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      // postMessage는 CSP에 영향 안 받고, isolated ↔ main world 간 통신 가능
      window.postMessage({
        type: 'xgen:canvas-command',
        requestId,
        action,
        params,
      }, '*');
    });
  }
}

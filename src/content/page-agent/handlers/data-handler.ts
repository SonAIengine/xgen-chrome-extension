import type { PageHandler, PageContext, PageCommandResult } from '../types';
import {
  getPageTitle,
  getTableData,
  clickElement,
  fillInput,
  getSelectedText,
} from '../dom-utils';

export class DataHandler implements PageHandler {
  readonly pageType = 'data' as const;

  private observer: MutationObserver | null = null;

  matches(url: URL): boolean {
    const view = url.searchParams.get('view') ?? '';
    return (
      url.pathname.includes('/main') &&
      (view.includes('data') || view.includes('document'))
    );
  }

  extractContext(): PageContext {
    const tableData = getTableData(undefined, 20);

    return {
      pageType: 'data',
      url: window.location.href,
      title: getPageTitle(),
      data: {
        selectedText: getSelectedText(),
        ...(tableData ? { documents: tableData } : {}),
      },
      availableActions: this.getAvailableActions(),
      timestamp: Date.now(),
    };
  }

  getAvailableActions(): string[] {
    return ['select_document', 'search_documents', 'navigate'];
  }

  async executeCommand(
    action: string,
    params: Record<string, unknown>,
  ): Promise<PageCommandResult> {
    switch (action) {
      case 'navigate':
        if (typeof params.path === 'string') {
          window.location.href = params.path;
          return { success: true, action };
        }
        return { success: false, action, error: 'path required' };

      case 'select_document': {
        const name = typeof params.name === 'string' ? params.name : undefined;
        if (name) {
          const clicked = clickElement('tbody tr', name);
          return { success: clicked, action, ...(!clicked ? { error: `Document "${name}" not found` } : {}) };
        }
        return { success: false, action, error: 'name required' };
      }

      case 'search_documents': {
        const query = typeof params.query === 'string' ? params.query : '';
        const filled = fillInput(
          'input[type="search"], input[placeholder*="검색"], input[placeholder*="search"]',
          query,
        );
        return { success: filled, action, ...(!filled ? { error: 'Search input not found' } : {}) };
      }

      default:
        return { success: false, action, error: `Unknown action: ${action}` };
    }
  }

  observe(callback: (context: PageContext) => void): void {
    let debounceTimer: ReturnType<typeof setTimeout>;

    this.observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        callback(this.extractContext());
      }, 1000);
    });

    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}

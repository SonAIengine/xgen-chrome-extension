import type { PageHandler, PageContext, PageCommandResult } from '../types';
import {
  getPageTitle,
  getTableData,
  clickElement,
  fillInput,
  getSelectedText,
} from '../dom-utils';

export class WorkflowsHandler implements PageHandler {
  readonly pageType = 'workflows' as const;

  private observer: MutationObserver | null = null;

  matches(url: URL): boolean {
    const view = url.searchParams.get('view') ?? '';
    return (
      url.pathname.includes('/main') &&
      (view.includes('workflow') || view.includes('canvas'))
    );
  }

  extractContext(): PageContext {
    const tableData = getTableData(undefined, 20);

    return {
      pageType: 'workflows',
      url: window.location.href,
      title: getPageTitle(),
      data: {
        selectedText: getSelectedText(),
        ...(tableData ? { workflows: tableData } : {}),
      },
      availableActions: this.getAvailableActions(),
      timestamp: Date.now(),
    };
  }

  getAvailableActions(): string[] {
    return [
      'select_workflow',
      'open_workflow',
      'search_workflows',
      'navigate',
    ];
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

      case 'select_workflow':
      case 'open_workflow': {
        const rowIndex = typeof params.row_index === 'number' ? params.row_index : -1;
        const name = typeof params.name === 'string' ? params.name : undefined;

        if (rowIndex >= 0) {
          const rows = document.querySelectorAll('tbody tr');
          const target = rows[rowIndex] as HTMLElement | undefined;
          if (target) {
            if (action === 'open_workflow') {
              target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            } else {
              target.click();
            }
            return { success: true, action };
          }
        }

        if (name) {
          const clicked = clickElement('tbody tr', name);
          return { success: clicked, action, ...(!clicked ? { error: `Workflow "${name}" not found` } : {}) };
        }

        return { success: false, action, error: 'row_index or name required' };
      }

      case 'search_workflows': {
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

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}

import type { PageHandler, PageContext, PageCommandResult, PageType } from '../types';
import { getPageTitle, getVisibleHeadings, getTableData, getSelectedText } from '../dom-utils';

export class GenericHandler implements PageHandler {
  readonly pageType: PageType = 'unknown';

  private observer: MutationObserver | null = null;

  matches(): boolean {
    return true; // fallback — always matches
  }

  extractContext(): PageContext {
    const tableData = getTableData();

    return {
      pageType: this.pageType,
      url: window.location.href,
      title: getPageTitle(),
      data: {
        headings: getVisibleHeadings(),
        selectedText: getSelectedText(),
        ...(tableData ? { table: tableData } : {}),
      },
      availableActions: this.getAvailableActions(),
      timestamp: Date.now(),
    };
  }

  getAvailableActions(): string[] {
    return ['navigate'];
  }

  async executeCommand(
    action: string,
    params: Record<string, unknown>,
  ): Promise<PageCommandResult> {
    if (action === 'navigate' && typeof params.path === 'string') {
      window.location.href = params.path;
      return { success: true, action };
    }

    return { success: false, action, error: `Unknown action: ${action}` };
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

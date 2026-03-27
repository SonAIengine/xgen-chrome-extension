import type { PageHandler, PageContext, PageCommandResult } from '../types';
import {
  getPageTitle,
  getVisibleHeadings,
  getFormValues,
  clickElement,
  fillInput,
} from '../dom-utils';

export class AdminHandler implements PageHandler {
  readonly pageType = 'admin' as const;

  private observer: MutationObserver | null = null;

  matches(url: URL): boolean {
    return url.pathname.includes('/admin');
  }

  extractContext(): PageContext {
    return {
      pageType: 'admin',
      url: window.location.href,
      title: getPageTitle(),
      data: {
        headings: getVisibleHeadings(),
        formValues: getFormValues(),
      },
      availableActions: this.getAvailableActions(),
      timestamp: Date.now(),
    };
  }

  getAvailableActions(): string[] {
    return ['navigate_tab', 'update_setting', 'navigate'];
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

      case 'navigate_tab': {
        const tabName = typeof params.tab_name === 'string' ? params.tab_name : '';
        const clicked = clickElement(
          '[role="tab"], .tab, button',
          tabName,
        );
        return { success: clicked, action, ...(!clicked ? { error: `Tab "${tabName}" not found` } : {}) };
      }

      case 'update_setting': {
        const selector = typeof params.selector === 'string' ? params.selector : '';
        const value = typeof params.value === 'string' ? params.value : '';
        if (!selector) return { success: false, action, error: 'selector required' };
        const filled = fillInput(selector, value);
        return { success: filled, action, ...(!filled ? { error: 'Input not found' } : {}) };
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

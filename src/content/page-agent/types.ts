import type { PageContext, PageCommandResult, PageType } from '../../shared/types';

export type { PageContext, PageCommandResult, PageType };

export interface PageHandler {
  readonly pageType: PageType;
  matches(url: URL): boolean;
  extractContext(): PageContext;
  getAvailableActions(): string[];
  executeCommand(
    action: string,
    params: Record<string, unknown>,
  ): Promise<PageCommandResult>;
  observe(callback: (context: PageContext) => void): void;
  disconnect(): void;
}

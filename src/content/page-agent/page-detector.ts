import type { PageType } from './types';

export function detectPageType(url: URL): PageType {
  const pathname = url.pathname;
  const view = url.searchParams.get('view') ?? '';

  // Canvas editor
  if (pathname.includes('/canvas')) return 'canvas';

  // Admin pages
  if (pathname.includes('/admin')) return 'admin';

  // ML monitoring
  if (
    pathname.includes('/ml-monitoring') ||
    pathname.includes('/ml-inference') ||
    pathname.includes('/modelOps')
  ) {
    return 'ml-monitoring';
  }

  // Main view-based routing
  if (pathname.includes('/main') || pathname === '/') {
    if (view.includes('workflow') || view.includes('canvas')) return 'workflows';
    if (view.includes('chat') || view.includes('new-chat')) return 'chat';
    if (view.includes('model') || view.includes('eval') || view.includes('storage'))
      return 'models';
    if (view.includes('data') || view.includes('document')) return 'data';
  }

  return 'unknown';
}

export type NavigationCallback = (url: URL) => void;

export function watchNavigation(callback: NavigationCallback): () => void {
  let lastUrl = window.location.href;

  // Poll URL every 500ms (SPA-safe, works in isolated world)
  const interval = setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      callback(new URL(lastUrl));
    }
  }, 500);

  // Watch document.title for SPA route changes
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      callback(new URL(lastUrl));
    }
  });

  const titleEl = document.querySelector('title');
  if (titleEl) {
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  return () => {
    clearInterval(interval);
    observer.disconnect();
  };
}

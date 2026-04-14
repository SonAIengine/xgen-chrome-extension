function isXgenDomain(): boolean {
  const host = window.location.hostname;
  return host.includes('x2bee.com') || host === 'localhost';
}

export function extractAndSendToken(): void {
  // XGEN 도메인에서만 토큰 추출
  if (!isXgenDomain()) return;

  const token =
    localStorage.getItem('xgen_access_token') ??
    document.cookie.match(/(?:^|; )xgen_access_token=([^;]+)/)?.[1] ??
    document.cookie.match(/(?:^|; )access_token=([^;]+)/)?.[1] ??
    null;

  if (token) {
    chrome.runtime.sendMessage({ type: 'SET_TOKEN', token, origin: window.location.origin }).catch(() => {});
  }

  // 현재 페이지의 origin을 API base URL로 전달
  chrome.runtime.sendMessage({
    type: 'SET_ORIGIN',
    origin: window.location.origin,
  }).catch(() => {});
}

export function watchTokenChanges(): void {
  if (!isXgenDomain()) return;

  // Re-extract token periodically (handles token refresh)
  setInterval(extractAndSendToken, 30_000);

  // Also watch for storage changes
  window.addEventListener('storage', (e) => {
    if (e.key === 'xgen_access_token' && e.newValue) {
      chrome.runtime.sendMessage({ type: 'SET_TOKEN', token: e.newValue, origin: window.location.origin }).catch(() => {});
    }
  });
}

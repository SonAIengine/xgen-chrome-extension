/**
 * 플로팅 "녹화 중" 오버레이 — 우클릭 → API 스캔 진입점에서 사용.
 *
 * Shadow DOM으로 호스트 페이지 CSS 격리. 사이드패널 따로 안 열어도
 * 사용자가 페이지에서 작업하면서 시작/정지를 직접 컨트롤 가능.
 *
 * SW가 STATUS 브로드캐스트하면 count만 갱신. 정지 버튼은 SW로
 * STOP_FLOATING_CAPTURE 메시지 송신.
 */

import type { ExtensionMessage } from '../shared/types';

const HOST_ID = '__xgen_floating_overlay__';

let host: HTMLDivElement | null = null;
let countEl: HTMLSpanElement | null = null;

const STYLES = `
  :host { all: initial; }
  .root {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #1f2937;
    color: #fff;
    border-radius: 999px;
    font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    user-select: none;
    cursor: default;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #ef4444;
    animation: xgen-pulse 1.4s infinite;
  }
  @keyframes xgen-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
  }
  .label { letter-spacing: 0.02em; }
  .count {
    background: rgba(255, 255, 255, 0.15);
    padding: 2px 8px;
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
    min-width: 20px;
    text-align: center;
  }
  .stop {
    all: unset;
    cursor: pointer;
    width: 22px; height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 50%;
    transition: background 0.15s;
  }
  .stop:hover { background: #ef4444; }
  .stop svg { width: 10px; height: 10px; }
`;

export function showOverlay(): void {
  if (host) return;

  host = document.createElement('div');
  host.id = HOST_ID;
  // host 자체는 위치만 잡고, 실제 스타일은 shadow 안에서.
  // 호스트 페이지가 #ID로 우리 div를 잡아서 깨먹지 못하게 reset.
  host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647;';

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.appendChild(style);

  const root = document.createElement('div');
  root.className = 'root';
  root.innerHTML = `
    <span class="dot"></span>
    <span class="label">API 녹화 중</span>
    <span class="count">0</span>
    <button class="stop" type="button" title="정지">
      <svg viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="1" width="12" height="12" rx="2"/></svg>
    </button>
  `;

  countEl = root.querySelector('.count');
  const stopBtn = root.querySelector<HTMLButtonElement>('.stop');
  stopBtn?.addEventListener('click', () => {
    chrome.runtime
      .sendMessage({ type: 'STOP_FLOATING_CAPTURE' } satisfies ExtensionMessage)
      .catch(() => {});
  });

  shadow.appendChild(root);
  // documentElement에 붙여 body가 늦게 렌더되는 SPA에서도 확실히 보이게.
  (document.documentElement || document.body).appendChild(host);
}

export function hideOverlay(): void {
  host?.remove();
  host = null;
  countEl = null;
}

export function updateCount(n: number): void {
  if (countEl) countEl.textContent = String(n);
}

export function isOverlayVisible(): boolean {
  return host !== null;
}

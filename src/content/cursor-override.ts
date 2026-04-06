/**
 * SimulatorMask 커서 스타일 오버라이드
 * 기존 SVG 그라데이션 커서를 완전 제거하고
 * Lucide mouse-pointer-2 아이콘 기반의 깔끔한 마우스 커서로 대체
 * (https://lucide.dev/icons/mouse-pointer-2 — ISC License)
 */
export function injectCursorOverride(): void {
  const style = document.createElement('style');
  style.textContent = `
    /* 커서 컨테이너 */
    ._cursor_1dgwb_2 {
      --cursor-size: 28px !important;
      width: 28px !important;
      height: 28px !important;
    }

    /* 기존 보더/필링/ripple 전부 제거 */
    ._cursorBorder_1dgwb_10,
    ._cursorFilling_1dgwb_25,
    ._cursorRipple_1dgwb_39 {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      visibility: hidden !important;
    }

    /* Lucide mouse-pointer-2: 흰색 fill + 그레이 stroke */
    ._cursor_1dgwb_2::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 28px;
      height: 28px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24' fill='%237c3aed' stroke='%235b21b6' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z'/%3E%3C/svg%3E");
      background-size: 28px 28px;
      background-repeat: no-repeat;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.18));
      pointer-events: none;
      z-index: 10001;
    }

    /* 클릭 시 축소 효과 */
    ._cursor_1dgwb_2._clicking_1dgwb_57::before {
      transform: scale(0.82);
      transition: transform 0.1s ease;
    }

    /* ai-motion WebGL 테두리 숨기고 보라색 CSS 테두리로 대체 */
    ._wrapper_1ooyb_1 canvas {
      display: none !important;
    }

    ._wrapper_1ooyb_1._visible_1ooyb_11 {
      border: 2px solid rgba(139, 92, 246, 0.5) !important;
      box-shadow: inset 0 0 30px rgba(139, 92, 246, 0.08) !important;
    }

    /* 오버레이 래퍼 — 배경 없음, 테두리만 표시 */
    ._wrapper_1ooyb_1,
    ._wrapper_1ooyb_1._visible_1ooyb_11 {
      background: none !important;
      cursor: default !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}

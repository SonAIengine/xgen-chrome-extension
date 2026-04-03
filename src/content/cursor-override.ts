/**
 * SimulatorMask 커서 스타일 오버라이드
 * 기존 SVG 그라데이션 커서를 완전히 숨기고
 * 일반 마우스 포인터 스타일의 커서로 대체
 */
export function injectCursorOverride(): void {
  const style = document.createElement('style');
  style.textContent = `
    /* 커서 컨테이너 — 작게 */
    ._cursor_1dgwb_2 {
      --cursor-size: 24px !important;
      width: 24px !important;
      height: 24px !important;
    }

    /* 기존 SVG 보더/필링 완전 숨김 */
    ._cursorBorder_1dgwb_10,
    ._cursorFilling_1dgwb_25 {
      display: none !important;
    }

    /* 커서 컨테이너에 마우스 포인터 SVG 직접 적용 */
    ._cursor_1dgwb_2::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 24px;
      height: 24px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cdefs%3E%3Cfilter id='s' x='-20%25' y='-20%25' width='140%25' height='140%25'%3E%3CfeDropShadow dx='0.5' dy='1' stdDeviation='0.8' flood-color='%23000' flood-opacity='0.15'/%3E%3C/filter%3E%3C/defs%3E%3Cpath d='M 3 2 L 3 18 L 7.5 13.5 L 12 20 L 14 19 L 9.5 12.5 L 15 12 Z' fill='white' stroke='%23888' stroke-width='1.2' stroke-linejoin='round' filter='url(%23s)'/%3E%3C/svg%3E");
      background-size: contain;
      background-repeat: no-repeat;
      pointer-events: none;
      z-index: 10001;
    }

    /* ripple — 작고 세련된 블루 */
    ._cursorRipple_1dgwb_39 {
      margin-left: -100% !important;
      margin-top: -100% !important;
    }

    ._cursorRipple_1dgwb_39::after {
      border: 2px solid rgba(59, 130, 246, 0.6) !important;
    }

    /* 오버레이 래퍼 — 연한 그레이 반투명 배경 */
    ._wrapper_1ooyb_1 {
      background: rgba(120, 120, 130, 0.08) !important;
      cursor: default !important;
      pointer-events: none !important;
    }

    ._wrapper_1ooyb_1._visible_1ooyb_11 {
      background: rgba(120, 120, 130, 0.08) !important;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Element Picker — DevTools 스타일 요소 선택기
 *
 * 활성화하면 페이지 위에 호버 하이라이트 오버레이가 표시되고,
 * 사용자가 요소를 클릭하면:
 * 1. API hook 시작 (ELEMENT_PICKER_STOP → SW가 hook inject)
 * 2. 해당 요소 클릭 실행
 * 3. 2초 대기 후 캡처된 API 수집
 * 4. 결과를 service worker로 전달
 */

let pickerActive = false;
let highlightOverlay: HTMLDivElement | null = null;
let labelOverlay: HTMLDivElement | null = null;

function createOverlays() {
  if (highlightOverlay) return; // 이미 생성됨

  highlightOverlay = document.createElement('div');
  highlightOverlay.id = 'xgen-picker-highlight';
  Object.assign(highlightOverlay.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483645',
    border: '2px solid #7c3aed',
    backgroundColor: 'rgba(124, 58, 237, 0.08)',
    borderRadius: '3px',
    transition: 'all 0.1s ease',
    display: 'none',
  });
  document.body.appendChild(highlightOverlay);

  labelOverlay = document.createElement('div');
  labelOverlay.id = 'xgen-picker-label';
  Object.assign(labelOverlay.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483646',
    backgroundColor: '#7c3aed',
    color: 'white',
    fontSize: '11px',
    fontFamily: 'monospace',
    padding: '2px 6px',
    borderRadius: '3px',
    whiteSpace: 'nowrap',
    display: 'none',
  });
  document.body.appendChild(labelOverlay);
}

function removeOverlays() {
  highlightOverlay?.remove();
  labelOverlay?.remove();
  highlightOverlay = null;
  labelOverlay = null;
}

function isPickerElement(el: Element | null): boolean {
  if (!el) return false;
  const id = (el as HTMLElement).id;
  return id === 'xgen-picker-highlight' || id === 'xgen-picker-label';
}

function handleMouseMove(e: MouseEvent) {
  if (!pickerActive || !highlightOverlay || !labelOverlay) return;

  const target = e.target as HTMLElement;
  if (!target || isPickerElement(target)) return;

  const rect = target.getBoundingClientRect();

  Object.assign(highlightOverlay.style, {
    display: 'block',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });

  const tag = target.tagName.toLowerCase();
  const text = (target.textContent || '').trim().slice(0, 30);
  labelOverlay.textContent = `${tag}${text ? ` — ${text}` : ''}`;

  Object.assign(labelOverlay.style, {
    display: 'block',
    top: `${Math.max(0, rect.top - 22)}px`,
    left: `${rect.left}px`,
  });
}

async function handleClick(e: MouseEvent) {
  if (!pickerActive) return;

  const target = e.target as HTMLElement;
  if (!target || isPickerElement(target)) return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  // picker UI 즉시 정리
  cleanup();

  const tag = target.tagName.toLowerCase();
  const text = (target.textContent || '').trim().slice(0, 50);
  const url = window.location.href;

  // 1. SW에 hook inject 요청 (ELEMENT_PICKER_STOP이 hook 시작 트리거)
  chrome.runtime.sendMessage({ type: 'ELEMENT_PICKER_STOP' }).catch(() => {});

  // hook inject 대기
  await new Promise(r => setTimeout(r, 500));

  // 2. 요소 클릭 실행
  target.click();

  // 3. API 응답 대기
  await new Promise(r => setTimeout(r, 2000));

  // 4. 캡처된 API 조회 → SW가 ELEMENT_PICKER_RESULT를 sidepanel에 전달
  chrome.runtime.sendMessage({
    type: 'ELEMENT_PICKER_RESULT',
    apis: [],
    elementInfo: { tag, text, url },
  }).catch(() => {});
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && pickerActive) {
    cleanup();
    chrome.runtime.sendMessage({ type: 'ELEMENT_PICKER_STOP' }).catch(() => {});
  }
}

function cleanup() {
  pickerActive = false;
  document.removeEventListener('mousemove', handleMouseMove, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('keydown', handleKeyDown, true);
  document.body.style.cursor = '';
  removeOverlays();
}

export function startPicker() {
  if (pickerActive) return;
  pickerActive = true;

  createOverlays();
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
  document.body.style.cursor = 'crosshair';
}

export function stopPicker() {
  cleanup();
}

/**
 * Element Picker — DevTools 스타일 요소 선택기
 *
 * 활성화하면 페이지 위에 호버 하이라이트 오버레이가 표시되고,
 * 사용자가 요소를 클릭하면:
 * 1. API hook 시작
 * 2. 해당 요소 클릭 실행
 * 3. 잠시 대기 후 캡처된 API 수집
 * 4. 결과를 service worker로 전달
 */

let pickerActive = false;
let highlightOverlay: HTMLDivElement | null = null;
let labelOverlay: HTMLDivElement | null = null;

function createOverlays() {
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

function handleMouseMove(e: MouseEvent) {
  if (!pickerActive || !highlightOverlay || !labelOverlay) return;

  const target = e.target as HTMLElement;
  if (!target || target.id === 'xgen-picker-highlight' || target.id === 'xgen-picker-label') return;

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

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const target = e.target as HTMLElement;
  if (!target || target.id === 'xgen-picker-highlight' || target.id === 'xgen-picker-label') return;

  // picker 비활성화
  stopPicker();

  const tag = target.tagName.toLowerCase();
  const text = (target.textContent || '').trim().slice(0, 50);
  const url = window.location.href;

  // 1. API hook 시작 요청
  chrome.runtime.sendMessage({ type: 'ELEMENT_PICKER_STOP' }).catch(() => {});

  // 잠시 대기 후 hook이 준비되면 클릭
  // service worker가 hook inject → 여기서 요소 클릭 → API 캡처
  // hook inject는 비동기이므로 약간의 딜레이 필요
  await new Promise(r => setTimeout(r, 500));

  // 2. 요소 클릭 실행 (실제 이벤트)
  target.click();

  // 3. API 응답 대기
  await new Promise(r => setTimeout(r, 2000));

  // 4. 캡처된 API 조회 요청 → service worker가 ELEMENT_PICKER_RESULT로 응답
  chrome.runtime.sendMessage({
    type: 'ELEMENT_PICKER_RESULT',
    apis: [], // service worker가 채워줌
    elementInfo: { tag, text, url },
  }).catch(() => {});
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    stopPicker();
    chrome.runtime.sendMessage({ type: 'ELEMENT_PICKER_STOP' }).catch(() => {});
  }
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
  if (!pickerActive) return;
  pickerActive = false;

  document.removeEventListener('mousemove', handleMouseMove, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('keydown', handleKeyDown, true);
  document.body.style.cursor = '';
  removeOverlays();
}

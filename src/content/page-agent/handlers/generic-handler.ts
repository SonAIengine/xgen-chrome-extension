/**
 * GenericHandler — @page-agent/page-controller 기반 범용 핸들러
 *
 * alibaba/page-agent의 PageController를 그대로 활용:
 * - getBrowserState(): DOM을 "[0]<button>..." 형태로 평탄화 (LLM 토큰 효율적)
 * - clickElement(index): 합성 이벤트 시퀀스로 실제 클릭
 * - inputText(index, text): React/native input 호환 입력
 * - selectOption(index, text): 드롭다운 선택
 * - scroll(options): 스크롤
 * - showMask() / SimulatorMask: 가상 커서 오버레이 (smooth 이동 + click ripple)
 *
 * XGEN 특화 로직 없음 — 연결 고리는 page_tools.py + page_command SSE가 담당
 */

import { PageController } from '@page-agent/page-controller';
import type { PageHandler, PageContext, PageCommandResult, PageType } from '../types';
import { detectPageType } from '../page-detector';

/**
 * DOM 평탄화 텍스트의 해시 — snapshot_id.
 * FNV-1a 32-bit, 8자 hex. 백엔드/LLM이 이 id를 도구 호출에 포함시켜 freshness를 검증한다.
 */
function computeSnapshotId(content: string): string {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 대상 요소가 실제로 보이고 상호작용 가능한지 확인. */
function isInteractableElement(el: Element | null | undefined): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity || '1') === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

export class GenericHandler implements PageHandler {
  readonly pageType: PageType = 'unknown';

  private controller: PageController;
  private stopObserveFn: (() => void) | null = null;

  constructor() {
    try {
      this.controller = new PageController({
        enableMask: true,         // SimulatorMask 활성화 (smooth cursor + click ripple)
        viewportExpansion: 3,     // 뷰포트 ±3배 범위 요소 추출 (스크롤 밖 요소도 포함)
        highlightOpacity: 0.3,
      });
      console.log('[XGEN GenericHandler] PageController 초기화 성공');
    } catch (err) {
      console.error('[XGEN GenericHandler] PageController 초기화 실패:', err);
      // fallback: mask 없이 재시도
      this.controller = new PageController({ viewportExpansion: 3 });
    }
  }

  matches(): boolean {
    return true; // fallback — 항상 매칭
  }

  async extractContext(): Promise<PageContext> {
    const state = await this.controller.getBrowserState();
    await this.controller.cleanUpHighlights();

    // 메뉴 사전탐색 — 접힌 메뉴를 펼쳐서 전체 네비게이션 구조를 파악
    const menuMap = await this.scanMenuHierarchy();

    return {
      pageType: detectPageType(new URL(window.location.href)),
      url: state.url,
      title: state.title,
      elements: state.content,
      snapshotId: computeSnapshotId(state.content ?? ''),
      data: { ...(menuMap ? { menuMap } : {}) },
      availableActions: this.getAvailableActions(),
      timestamp: Date.now(),
    };
  }

  getAvailableActions(): string[] {
    return [
      'click_element', 'input_text', 'select_option', 'scroll',
      // API Hook (service worker에서 처리)
      'start_api_hook', 'stop_api_hook', 'get_captured_apis', 'clear_captured_apis', 'register_tool',
    ];
  }

  async executeCommand(
    action: string,
    params: Record<string, unknown>,
  ): Promise<PageCommandResult> {
    try {
      // updateTree()를 호출하지 않음 — extractContext()에서 빌드한 트리의 인덱스를
      // 그대로 사용해야 AI가 지정한 인덱스와 일치한다.
      // updateTree()는 DOM을 재스캔하여 인덱스를 재할당하므로 불일치 발생.

      // snapshot_id 검증은 백엔드에서만 수행한다 (대화 이력 내 stale ref 차단).
      // 확장 측에서 현재 DOM 해시를 re-check하면 동적 페이지(캐러셀, 배너 등)에서
      // content hash가 매 초 바뀌어 정상 인덱스까지 거부되므로 수행하지 않는다.
      // page-controller 인덱스는 DOM 트리 위치 기반이라 콘텐츠 변경에 안정적이다.

      // ── Step 4: 숨겨진/상호작용 불가 요소 차단 (click/input/select) ──
      if (action === 'click_element' || action === 'input_text' || action === 'select_option') {
        const idx = params.index as number;
        const selectorMap = (this.controller as any).selectorMap as Map<number, any> | undefined;
        const node = selectorMap?.get(idx);
        if (!node) {
          return { success: false, action, error: `인덱스 [${idx}]를 찾을 수 없습니다. page_context의 인덱스 범위를 확인하세요.` };
        }
        if (!isInteractableElement(node.ref)) {
          return {
            success: false,
            action,
            error: `인덱스 [${idx}] 요소가 숨겨져 있거나 상호작용 불가 상태입니다 `
              + `(hidden/display:none/visibility:hidden/opacity:0/zero-size). `
              + `scroll_page로 스크롤하거나 다른 요소를 선택하세요.`,
          };
        }
      }

      // 마스크 표시 (가상 커서 오버레이)
      await this.controller.showMask().catch(() => {});

      switch (action) {
        case 'click_element':
          await this.moveCursorToElement(params.index as number);
          await this.controller.clickElement(params.index as number);
          break;

        case 'input_text':
          await this.moveCursorToElement(params.index as number);
          await this.controller.inputText(params.index as number, params.text as string);
          break;

        case 'select_option':
          await this.moveCursorToElement(params.index as number);
          await this.controller.selectOption(params.index as number, params.text as string);
          break;

        case 'scroll':
          await this.controller.scroll({
            down: (params.down as boolean) ?? true,
            numPages: (params.num_pages as number) ?? 1,
          });
          break;

        case 'navigate_plan':
          return await this.executeNavigatePlan(params.steps as string[]);

        default:
          return { success: false, action, error: `Unknown action: ${action}` };
      }

      // DOM이 안정될 때까지 대기 (MutationObserver 기반)
      await this.waitForDomStability();

      // 마스크 숨기기
      await this.controller.hideMask().catch(() => {});

      const state = await this.controller.getBrowserState();
      await this.controller.cleanUpHighlights();
      const updatedContext: PageContext = {
        pageType: detectPageType(new URL(window.location.href)),
        url: state.url,
        title: state.title,
        elements: state.content,
        snapshotId: computeSnapshotId(state.content ?? ''),
        data: {},
        availableActions: this.getAvailableActions(),
        timestamp: Date.now(),
      };

      return { success: true, action, pageContext: updatedContext };
    } catch (err) {
      await this.controller.hideMask().catch(() => {});
      return {
        success: false,
        action,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 가상 커서를 대상 요소 위치로 이동시킨다.
   * PageController 내부의 SimulatorMask가 MovePointerTo 이벤트를 수신하여 커서를 이동.
   */
  private async moveCursorToElement(index: number): Promise<void> {
    try {
      // PageController의 selectorMap에서 element 가져오기 (내부 API 사용)
      // clickElement가 내부적으로 하는 것과 동일하게 element 찾기
      const state = (this.controller as any);
      const selectorMap = state.selectorMap as Map<number, any> | undefined;
      if (!selectorMap) return;

      const node = selectorMap.get(index);
      if (!node?.ref) return;

      const el = node.ref as HTMLElement;
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      // SimulatorMask의 커서 이동 이벤트 발생
      window.dispatchEvent(new CustomEvent('PageAgent::MovePointerTo', {
        detail: { x, y },
      }));

      // 커서 이동 애니메이션 대기
      await new Promise((r) => setTimeout(r, 400));

      // 클릭 애니메이션 이벤트 발생
      window.dispatchEvent(new CustomEvent('PageAgent::ClickPointer'));
    } catch {
      // 커서 이동 실패해도 동작에 영향 없음
    }
  }

  observe(callback: (context: PageContext) => void): void {
    let lastUrl = window.location.href;
    let debounceTimer: ReturnType<typeof setTimeout>;

    // URL 변경 감지 (SPA 네비게이션) — 500ms 폴링
    const urlInterval = setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        this.extractContext()
          .then((ctx) => callback(ctx))
          .catch(() => {});
      }
    }, 500);

    // DOM 변경 감지 (page_command 실행 후 UI 갱신 반영) — 1초 debounce
    const mutationObserver = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.extractContext()
          .then((ctx) => callback(ctx))
          .catch(() => {});
      }, 1000);
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    this.stopObserveFn = () => {
      clearInterval(urlInterval);
      mutationObserver.disconnect();
      clearTimeout(debounceTimer);
    };
  }

  /**
   * 메뉴 사전탐색 — 사이드바의 전체 메뉴 구조를 파악한다.
   *
   * XGEN 사이드바 DOM 패턴:
   * - 부모 메뉴: class에 "sidebarToggle" 포함 (visible)
   * - 서브 항목: class에 "navItem" 포함 (hidden, display:none)
   * - 서브 항목은 이미 DOM에 렌더링되어 있어 클릭 없이 textContent로 읽을 수 있음
   *
   * 결과 예시: "워크플로우 > [워크플로우 소개, 워크플로우 캔버스, 워크플로우 관리]"
   */
  private async scanMenuHierarchy(): Promise<string | null> {
    try {
      // 방법 1: XGEN CSS 모듈 패턴 (sidebarToggle + navItem)
      const result = this.scanXgenSidebar();
      if (result) return result;

      // 방법 2: aria-expanded 패턴
      const ariaResult = this.scanAriaMenus();
      if (ariaResult) return ariaResult;

      // 방법 3: 범용 DOM 구조 기반
      return this.scanGenericMenus();
    } catch (err) {
      console.warn('[XGEN GenericHandler] scanMenuHierarchy 실패:', err);
      return null;
    }
  }

  /**
   * XGEN 사이드바 전용 스캐너.
   * 부모: class에 "sidebarToggle" / "toggle" 포함
   * 자식: class에 "navItem" / "subItem" 포함 (부모 다음 형제들)
   */
  private scanXgenSidebar(): string | null {
    const aside = document.querySelector('aside');
    if (!aside) return null;

    const allButtons = aside.querySelectorAll<HTMLElement>('button, a');
    if (allButtons.length === 0) return null;

    const menuEntries: string[] = [];
    let currentParent: string | null = null;
    let currentChildren: string[] = [];
    let currentExpanded = false;

    for (const btn of allButtons) {
      const cls = btn.className || '';
      const text = btn.textContent?.trim() ?? '';
      if (!text || text.length > 60) continue;

      const isToggle =
        cls.includes('sidebarToggle') ||
        cls.includes('Toggle') ||
        cls.includes('toggle');
      const isNavItem =
        cls.includes('navItem') ||
        cls.includes('NavItem') ||
        cls.includes('subItem') ||
        cls.includes('SubItem');

      if (isToggle) {
        // 이전 부모의 자식들을 저장
        if (currentParent && currentChildren.length > 0) {
          const state = currentExpanded ? '펼침' : '접힘';
          menuEntries.push(`${currentParent} (${state}) > [${currentChildren.join(', ')}]`);
        }
        currentParent = text;
        currentChildren = [];

        // 펼침/접힘 상태 감지
        // 1) aria-expanded 속성
        // 2) 다음 형제(서브메뉴 컨테이너)의 display/height 확인
        // 3) 부모의 class에 "open", "active", "expanded" 포함 여부
        const ariaExpanded = btn.getAttribute('aria-expanded');
        if (ariaExpanded !== null) {
          currentExpanded = ariaExpanded === 'true';
        } else {
          // 서브메뉴 컨테이너의 가시성으로 판단
          const nextSibling = btn.nextElementSibling as HTMLElement | null;
          const parentLi = btn.closest('li') || btn.parentElement;
          const subContainer = nextSibling || parentLi?.querySelector('ul, div[class*="sub"], div[class*="nav"]');

          if (subContainer) {
            const style = window.getComputedStyle(subContainer);
            currentExpanded = style.display !== 'none' && style.height !== '0px' && style.visibility !== 'hidden';
          } else {
            // class 기반 판단
            const parentCls = (btn.parentElement?.className || '') + ' ' + cls;
            currentExpanded = /\b(open|active|expanded)\b/i.test(parentCls);
          }
        }
      } else if (isNavItem && currentParent) {
        currentChildren.push(text);
      }
    }

    // 마지막 그룹 저장
    if (currentParent && currentChildren.length > 0) {
      const state = currentExpanded ? '펼침' : '접힘';
      menuEntries.push(`${currentParent} (${state}) > [${currentChildren.join(', ')}]`);
    }

    return menuEntries.length > 0
      ? '[메뉴 구조]\n' + menuEntries.join('\n')
      : null;
  }

  /** aria-expanded 기반 메뉴 스캔 (XGEN 외 일반 앱 대응). */
  private scanAriaMenus(): string | null {
    const expandables = document.querySelectorAll<HTMLElement>('[aria-expanded]');
    if (expandables.length === 0) return null;

    const menuEntries: string[] = [];

    for (const item of expandables) {
      const parentLabel = item.getAttribute('aria-label') || item.textContent?.trim() || '';
      if (!parentLabel || parentLabel.length > 60) continue;

      // aria-controls로 서브메뉴 찾기
      const controlsId = item.getAttribute('aria-controls');
      const submenu = controlsId
        ? document.getElementById(controlsId)
        : item.nextElementSibling;

      if (!submenu) continue;

      const children = submenu.querySelectorAll<HTMLElement>('a, button, [role="menuitem"]');
      const childTexts = Array.from(children)
        .map((el) => el.textContent?.trim())
        .filter((t): t is string => !!t && t.length > 0 && t.length < 60);

      if (childTexts.length > 0) {
        menuEntries.push(`${parentLabel} > [${childTexts.join(', ')}]`);
      }
    }

    return menuEntries.length > 0
      ? '[메뉴 구조]\n' + menuEntries.join('\n')
      : null;
  }

  /** 범용 메뉴 스캔: nav/aside 내 ul > li > ul 패턴. */
  private scanGenericMenus(): string | null {
    const containers = document.querySelectorAll<HTMLElement>(
      'nav, aside, [role="navigation"]',
    );
    if (containers.length === 0) return null;

    const menuEntries: string[] = [];

    for (const nav of containers) {
      const topItems = nav.querySelectorAll<HTMLElement>('li');
      for (const li of topItems) {
        const subList = li.querySelector(':scope > ul, :scope > [role="menu"]');
        if (!subList) continue;

        const parentLink = li.querySelector(':scope > a, :scope > button');
        const parentLabel = parentLink?.textContent?.trim();
        if (!parentLabel || parentLabel.length > 60) continue;

        const childItems = subList.querySelectorAll<HTMLElement>(':scope > li > a, :scope > li > button');
        const childTexts = Array.from(childItems)
          .map((el) => el.textContent?.trim())
          .filter((t): t is string => !!t && t.length > 0);

        if (childTexts.length > 0) {
          menuEntries.push(`${parentLabel} > [${childTexts.join(', ')}]`);
        }
      }
    }

    return menuEntries.length > 0
      ? '[메뉴 구조]\n' + menuEntries.join('\n')
      : null;
  }

  /**
   * Plan-Execute 네비게이션 — 텍스트 매칭으로 메뉴를 순서대로 클릭한다.
   *
   * LLM이 ["지식관리", "지식컬렉션"] 같은 계획을 세우면,
   * 코드가 각 텍스트에 매칭되는 DOM 요소를 찾아 순서대로 클릭한다.
   * LLM 추가 호출 없이 멀티스텝 네비게이션을 완료한다.
   */
  private async executeNavigatePlan(steps: string[]): Promise<PageCommandResult> {
    if (!steps || steps.length === 0) {
      return { success: false, action: 'navigate_plan', error: 'No steps provided' };
    }

    const executedSteps: string[] = [];
    const urlBefore = window.location.href;

    for (const stepText of steps) {
      const domBefore = document.body.innerHTML.length;

      // 1. 텍스트에 매칭되는 클릭 가능한 요소 찾기
      const element = this.findClickableByText(stepText);
      if (!element) {
        return {
          success: false,
          action: 'navigate_plan',
          error: `"${stepText}" 요소를 찾을 수 없습니다. 완료: [${executedSteps.join(' → ')}]`,
        };
      }

      // 2. 클릭
      console.log(`[XGEN navigate_plan] 클릭: "${stepText}" →`, element.tagName, element.className?.substring(0, 40));
      element.click();
      executedSteps.push(stepText);

      // 3. DOM 안정화 대기
      await this.waitForDomStability();

      // 4. 클릭 효과 검증: URL 또는 DOM이 변했는지 확인
      const urlChanged = window.location.href !== urlBefore;
      const domChanged = Math.abs(document.body.innerHTML.length - domBefore) > 50;
      if (!urlChanged && !domChanged) {
        console.warn(`[XGEN navigate_plan] "${stepText}" 클릭했지만 변화 없음`);
        // 사이드바가 숨겨진 상태일 수 있음 — 사이드바 열기 시도
        const sidebarToggle = document.querySelector<HTMLElement>(
          'button[class*="sidebarToggle"], button[class*="closeOnly"], [aria-label*="사이드바"]',
        );
        if (sidebarToggle && sidebarToggle !== element) {
          sidebarToggle.click();
          await new Promise((r) => setTimeout(r, 300));
          // 다시 클릭 시도
          const retry = this.findClickableByText(stepText);
          if (retry) {
            retry.click();
            await this.waitForDomStability();
          }
        }
      }
    }

    // 최종 상태 반환
    const state = await this.controller.getBrowserState();
    await this.controller.cleanUpHighlights();

    const finalUrl = window.location.href;
    const navigated = finalUrl !== urlBefore;

    return {
      success: true,
      action: 'navigate_plan',
      pageContext: {
        pageType: detectPageType(new URL(finalUrl)),
        url: state.url,
        title: state.title,
        elements: state.content,
        data: {
          navigated,
          executedSteps,
          ...(navigated ? {} : { warning: '클릭은 수행했지만 URL이 변경되지 않았습니다. click_element_by_index로 직접 시도해보세요.' }),
        },
        availableActions: this.getAvailableActions(),
        timestamp: Date.now(),
      },
    };
  }

  /**
   * 텍스트로 클릭 가능한 DOM 요소를 찾는다.
   * 사이드바/네비게이션 요소를 우선 매칭한다.
   */
  private findClickableByText(targetText: string): HTMLElement | null {
    const target = targetText.trim().toLowerCase();

    // 1순위: 사이드바/네비게이션 내 요소 (가장 정확)
    const navCandidates = document.querySelectorAll<HTMLElement>(
      'aside a, aside button, nav a, nav button, [role="navigation"] a, [role="navigation"] button',
    );
    for (const el of navCandidates) {
      const text = el.textContent?.trim().toLowerCase() ?? '';
      if (text === target) return el;
    }

    // 2순위: 페이지 내 모든 클릭 가능 요소에서 정확 매칭
    const allCandidates = document.querySelectorAll<HTMLElement>(
      'a, button, [role="button"], [role="menuitem"], [role="tab"]',
    );
    for (const el of allCandidates) {
      const text = el.textContent?.trim().toLowerCase() ?? '';
      if (text === target) return el;
    }

    // 3순위: 사이드바에서 포함 매칭
    for (const el of navCandidates) {
      const text = el.textContent?.trim().toLowerCase() ?? '';
      if (text.includes(target) && text.length < target.length * 2) return el;
    }

    // 4순위: 전체에서 포함 매칭 (가장 느슨)
    for (const el of allCandidates) {
      const text = el.textContent?.trim().toLowerCase() ?? '';
      if (text.includes(target) && text.length < target.length * 2) return el;
    }

    return null;
  }

  /**
   * DOM이 안정될 때까지 대기 — MutationObserver 기반.
   * quietMs 동안 DOM 변경이 없으면 안정 상태로 판단.
   * timeoutMs 초과 시 강제 resolve (애니메이션/폴링 페이지 대응).
   */
  private waitForDomStability(timeoutMs = 5000, quietMs = 300): Promise<void> {
    return new Promise((resolve) => {
      let quietTimer: ReturnType<typeof setTimeout>;

      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, quietMs);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      // 초기 quiet timer 시작 — 변경이 전혀 없으면 quietMs 후 resolve
      quietTimer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, quietMs);

      // hard timeout — 무한 대기 방지
      setTimeout(() => {
        clearTimeout(quietTimer);
        observer.disconnect();
        resolve();
      }, timeoutMs);
    });
  }

  disconnect(): void {
    this.stopObserveFn?.();
    this.stopObserveFn = null;
    // controller는 dispose하지 않음 — page-agent가 동일 인스턴스를 재활성화할 수 있음
    // content script 언로드 시 자동 GC
  }
}

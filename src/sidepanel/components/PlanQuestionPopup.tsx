import { useState, useCallback, useEffect, useRef } from 'react';
import type { PlanQuestion } from '../../shared/types';

interface Props {
  questions: PlanQuestion[];
  onSubmit: (answers: { title: string; answer: string }[]) => void;
  onDismiss: () => void;
}

export function PlanQuestionPopup({ questions, onSubmit, onDismiss }: Props) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, Set<string>>>({});
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
  const [minimized, setMinimized] = useState(false);
  // 키보드 포커스 인덱스 — 0..options.length-1: 옵션, options.length: "기타" 입력. -1이면 미포커스.
  const [focusedIdx, setFocusedIdx] = useState(0);
  const customInputRef = useRef<HTMLInputElement | null>(null);

  const total = questions.length;
  const q = questions[currentIndex];
  const selectedCount = answers[currentIndex]?.size ?? 0;
  const customText = customInputs[currentIndex]?.trim() ?? '';
  const customRowIdx = q ? q.options.length : -1;
  const isCustomFocused = focusedIdx === customRowIdx;

  // 질문 전환 시 포커스 첫 옵션으로 리셋
  useEffect(() => {
    setFocusedIdx(0);
  }, [currentIndex]);

  const toggleOption = useCallback((option: string) => {
    setAnswers((prev) => {
      const current = prev[currentIndex] ?? new Set<string>();
      if (q.type === 'single') {
        const next = new Set<string>();
        if (!current.has(option)) next.add(option);
        return { ...prev, [currentIndex]: next };
      } else {
        const next = new Set(current);
        if (next.has(option)) next.delete(option);
        else next.add(option);
        return { ...prev, [currentIndex]: next };
      }
    });
  }, [currentIndex, q?.type]);

  const goNext = useCallback(() => {
    if (currentIndex < total - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      const result = questions.map((question, i) => {
        const selected = Array.from(answers[i] ?? []);
        const custom = customInputs[i]?.trim();
        if (custom) selected.push(custom);
        return {
          title: question.title,
          answer: selected.length > 0 ? selected.join(', ') : '건너뜀',
        };
      });
      onSubmit(result);
    }
  }, [currentIndex, total, questions, answers, customInputs, onSubmit]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  }, [currentIndex]);

  const skipCurrent = useCallback(() => {
    // 건너뛰기 = 답변 없이 다음(또는 종료). 마지막 질문이면 "건너뜀"으로 제출.
    goNext();
  }, [goNext]);

  // 키보드 단축키 — ↑↓ 탐색, 1~9 직접 선택, Enter 진행, Esc 건너뛰기
  useEffect(() => {
    if (!q || minimized) return;
    const onKey = (e: KeyboardEvent) => {
      // 자유 입력칸에 포커스돼있으면 텍스트 편집 우선 — 단 Esc는 건너뛰기로 가로챔
      if (document.activeElement === customInputRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          customInputRef.current?.blur();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIdx((i) => Math.min(customRowIdx, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (focusedIdx === customRowIdx) {
          // 기타 row 포커스 + Enter → 입력칸 포커스
          customInputRef.current?.focus();
        } else if (q.options[focusedIdx]) {
          toggleOption(q.options[focusedIdx]);
          // single 타입이면 즉시 진행
          if (q.type === 'single') {
            setTimeout(goNext, 80);  // 시각적으로 선택된 후 넘김
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        skipCurrent();
      } else if (/^[1-9]$/.test(e.key)) {
        const n = parseInt(e.key, 10) - 1;
        if (n < q.options.length) {
          e.preventDefault();
          setFocusedIdx(n);
          toggleOption(q.options[n]);
          if (q.type === 'single') setTimeout(goNext, 80);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [q, minimized, focusedIdx, customRowIdx, toggleOption, goNext, skipCurrent]);

  if (!q) return null;

  const isLast = currentIndex === total - 1;

  if (minimized) {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center">
        <button
          onClick={() => setMinimized(false)}
          className="w-full max-w-md bg-gray-700 text-white px-4 py-2.5 rounded-t-xl shadow-lg flex items-center justify-between hover:bg-gray-600 transition-colors"
        >
          <span className="text-sm font-medium">확인이 필요해요 ({currentIndex + 1}/{total})</span>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50">
      <div className="w-full max-w-md bg-[#1f1f1f] text-gray-100 rounded-t-2xl shadow-2xl max-h-[80vh] flex flex-col animate-slide-up border-t border-gray-700/50">
        {/* Header */}
        <div className="flex items-center px-5 py-4">
          <span className="text-[15px] font-medium flex-1 mr-2 truncate">{q.title}</span>
          {total > 1 && (
            <div className="flex items-center gap-1 text-xs text-gray-400 mr-1">
              <button
                onClick={goPrev}
                disabled={currentIndex === 0}
                className={`p-1 rounded hover:bg-white/10 transition-colors ${currentIndex === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
                title="이전"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="tabular-nums">{total}개 중 {currentIndex + 1}개</span>
              <button
                onClick={goNext}
                className="p-1 rounded hover:bg-white/10 transition-colors"
                title="다음"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          )}
          <button
            onClick={() => setMinimized(true)}
            className="p-1 rounded text-gray-400 hover:bg-white/10 transition-colors"
            title="최소화"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7" />
            </svg>
          </button>
          <button
            onClick={onDismiss}
            className="p-1 rounded text-gray-400 hover:bg-white/10 transition-colors"
            title="닫기"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Options */}
        <div className="flex-1 overflow-y-auto px-3 pb-2 space-y-1">
          {q.options.map((option, oIndex) => {
            const selected = answers[currentIndex]?.has(option) ?? false;
            const focused = focusedIdx === oIndex;
            return (
              <button
                key={oIndex}
                onClick={() => {
                  setFocusedIdx(oIndex);
                  toggleOption(option);
                  if (q.type === 'single') setTimeout(goNext, 80);
                }}
                onMouseEnter={() => setFocusedIdx(oIndex)}
                className={`w-full text-left px-3 py-3 rounded-lg text-sm transition-colors flex items-center gap-3 ${
                  focused
                    ? 'bg-white/10'
                    : selected
                      ? 'bg-white/5'
                      : 'hover:bg-white/5'
                }`}
              >
                <span className={`inline-flex items-center justify-center w-7 h-7 rounded-md text-xs font-medium flex-shrink-0 ${
                  selected ? 'bg-violet-500 text-white' : 'bg-black/40 text-gray-400 border border-white/10'
                }`}>
                  {selected ? '✓' : oIndex + 1}
                </span>
                <span className="flex-1 truncate">{option}</span>
                {focused && (
                  <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                )}
              </button>
            );
          })}

          {/* 기타 — 자유 입력 */}
          {q.allow_custom !== false && (
            <div
              onClick={() => {
                setFocusedIdx(customRowIdx);
                customInputRef.current?.focus();
              }}
              className={`w-full px-3 py-3 rounded-lg text-sm transition-colors flex items-center gap-3 cursor-text ${
                isCustomFocused ? 'bg-white/5' : 'hover:bg-white/5'
              }`}
            >
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-black/40 border border-white/10 text-gray-400 flex-shrink-0">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </span>
              <input
                ref={customInputRef}
                type="text"
                placeholder="기타"
                value={customInputs[currentIndex] ?? ''}
                onChange={(e) =>
                  setCustomInputs((prev) => ({ ...prev, [currentIndex]: e.target.value }))
                }
                onFocus={() => setFocusedIdx(customRowIdx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (selectedCount > 0 || customText)) {
                    e.preventDefault();
                    goNext();
                  }
                }}
                className="flex-1 bg-transparent border-none outline-none text-gray-100 placeholder-gray-500 min-w-0"
              />
              {q.skippable !== false && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    skipCurrent();
                  }}
                  className="text-xs px-3 py-1.5 rounded-md border border-white/15 text-gray-300 hover:bg-white/5 transition-colors flex-shrink-0"
                >
                  건너뛰기
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-2.5 text-[11px] text-gray-500 text-center border-t border-white/5">
          <span className="inline-flex items-center gap-1.5">
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-gray-300">↑↓</kbd>
            <span>탐색</span>
          </span>
          <span className="mx-2 text-gray-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-gray-300">Enter</kbd>
            <span>{isLast ? '완료' : '선택'}</span>
          </span>
          <span className="mx-2 text-gray-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-gray-300">Esc</kbd>
            <span>건너뛰기</span>
          </span>
        </div>
      </div>
    </div>
  );
}

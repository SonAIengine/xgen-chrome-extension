import { useState, useCallback } from 'react';
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

  const total = questions.length;
  const q = questions[currentIndex];
  const selectedCount = answers[currentIndex]?.size ?? 0;
  const customText = customInputs[currentIndex]?.trim() ?? '';

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
      // 마지막 질문 → 제출
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
    // 현재 질문 건너뛰기 (빈 답변) → 다음으로
    goNext();
  }, [goNext]);

  if (!q) return null;

  const isLast = currentIndex === total - 1;

  // 최소화 상태: 하단 바만 표시
  if (minimized) {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center">
        <button
          onClick={() => setMinimized(false)}
          className="w-full max-w-md bg-violet-500 text-white px-4 py-2.5 rounded-t-xl shadow-lg flex items-center justify-between hover:bg-violet-600 transition-colors"
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30">
      <div className="w-full max-w-md bg-white rounded-t-2xl shadow-xl max-h-[70vh] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-gray-800 flex-1 mr-2">{q.title}</span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {total > 1 && (
              <div className="flex items-center gap-1 text-xs text-gray-400">
                <button
                  onClick={goPrev}
                  disabled={currentIndex === 0}
                  className={`p-0.5 rounded transition-colors ${
                    currentIndex === 0 ? 'text-gray-200' : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span>{currentIndex + 1}/{total}</span>
                <button
                  onClick={goNext}
                  className="p-0.5 rounded text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            )}
            <button
              onClick={() => setMinimized(true)}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              title="최소화"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7" />
              </svg>
            </button>
            <button
              onClick={onDismiss}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              title="닫기"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Options */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
          {q.options.map((option, oIndex) => {
            const selected = answers[currentIndex]?.has(option) ?? false;
            return (
              <button
                key={oIndex}
                onClick={() => toggleOption(option)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all ${
                  selected
                    ? 'bg-violet-50 text-violet-700 ring-1 ring-violet-300'
                    : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-xs font-medium ${
                    selected ? 'bg-violet-500 text-white' : 'bg-gray-200 text-gray-500'
                  }`}>
                    {selected ? '✓' : oIndex + 1}
                  </span>
                  {option}
                </span>
              </button>
            );
          })}

          {/* Custom input */}
          {q.allow_custom !== false && (
            <div className="flex items-center gap-2 pt-1">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-gray-100 text-gray-400">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </span>
              <input
                type="text"
                placeholder="기타"
                value={customInputs[currentIndex] ?? ''}
                onChange={(e) =>
                  setCustomInputs((prev) => ({ ...prev, [currentIndex]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (selectedCount > 0 || customText)) goNext();
                }}
                className="flex-1 text-sm px-2.5 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-300 bg-white"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center px-4 py-3 border-t border-gray-100">
          <span className="text-xs text-gray-400">
            {selectedCount + (customText ? 1 : 0)}개 선택됨
          </span>
          <div className="flex-1" />
          {q.skippable !== false && (
            <button
              onClick={skipCurrent}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors mr-2"
            >
              건너뛰기
            </button>
          )}
          <button
            onClick={goNext}
            className="p-2 rounded-lg bg-violet-500 hover:bg-violet-600 text-white transition-colors"
            title={isLast ? '완료' : '다음'}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

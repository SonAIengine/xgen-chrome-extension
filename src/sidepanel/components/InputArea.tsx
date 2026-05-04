import { useState, useRef, useCallback, type KeyboardEvent } from 'react';

interface Props {
  onSend: (content: string) => void;
  /** 슬래시 명령으로 collection /run 호출. collection 없으면 undefined → 평문 메시지로 폴백. */
  onRunTool?: (requirement: string, displayLabel?: string, displayTool?: string) => void;
  onStop: () => void;
  isStreaming: boolean;
}

export function InputArea({ onSend, onRunTool, onStop, isStreaming }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    if (!value.trim() || isStreaming) return;

    // "/" 로 시작하면 collection /run으로 — 사용자가 명시적으로 도구 호출 의도 표현.
    // 인자/자연어는 /run의 Stage 1 LLM이 알아서 파싱.
    const trimmed = value.trim();
    if (onRunTool && trimmed.startsWith('/')) {
      const requirement = trimmed.slice(1).trim();
      if (requirement) {
        onRunTool(requirement, trimmed);
        setValue('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        return;
      }
    }

    onSend(value);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, isStreaming, onSend, onRunTool]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }, []);

  return (
    <div className="border-t border-gray-200 px-2.5 py-2">
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="메시지 입력..."
          disabled={isStreaming}
          rows={1}
          className="flex-1 resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-[13px] text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-400 focus:bg-white disabled:opacity-50 transition-colors leading-snug"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="flex-none w-8 h-8 flex items-center justify-center rounded-lg bg-gray-700 text-white hover:bg-red-600 transition-colors"
            title="응답 중지"
          >
            {/* Stop icon (square) */}
            <svg className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="currentColor">
              <rect x="1" y="1" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!value.trim()}
            className="flex-none w-8 h-8 flex items-center justify-center rounded-lg bg-gray-700 text-white hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="전송"
          >
            {/* Send icon (arrow up) */}
            <svg className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 12V2M2 6l5-5 5 5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

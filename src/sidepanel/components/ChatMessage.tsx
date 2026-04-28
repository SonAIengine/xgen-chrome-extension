import type { Chip, ChatMessage as ChatMessageType } from '../../shared/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallBadge } from './ToolCallBadge';

interface Props {
  message: ChatMessageType;
  onChipClick?: (chip: Chip) => void;
}

export function ChatMessage({ message, onChipClick }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const hasChips = !!(message.chips && message.chips.length > 0);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2.5`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
          isUser
            ? 'bg-gray-700 text-white'
            : isSystem
              ? 'bg-red-50 text-red-700 border border-red-100'
              : message.isProactive
                ? 'bg-violet-50 text-gray-800 border border-violet-200'
                : 'bg-gray-50 text-gray-800 border border-gray-100'
        }`}
      >
        {message.isProactive && message.siteInfo && (
          <div className="text-[10px] text-violet-600 mb-1 flex items-center gap-1">
            <span>✨</span>
            <span>
              {message.siteInfo.status === 'matched'
                ? `PathFinder · ${message.siteInfo.name || message.siteInfo.host}`
                : `PathFinder · ${message.siteInfo.host || '사이트 학습 전'}`}
            </span>
          </div>
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {message.toolCalls.map((tc) => (
              <ToolCallBadge key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm prose-gray max-w-none
            prose-p:my-1 prose-li:my-0.5 prose-headings:mt-3 prose-headings:mb-1
            prose-pre:bg-gray-800 prose-pre:text-gray-100">
            <MarkdownRenderer content={message.content} />
          </div>
        )}

        {hasChips && (
          <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-violet-200/40">
            {message.chips!.map((chip) => (
              <button
                key={chip.id}
                onClick={() => onChipClick?.(chip)}
                className="text-[11px] px-2 py-1 rounded-full border bg-white border-violet-200 text-violet-700 hover:bg-violet-50 transition-colors"
                title={chip.intent}
              >
                <span className="mr-1">{chip.emoji ?? '✨'}</span>
                {chip.title}
              </button>
            ))}
          </div>
        )}

        {!isUser && message.tokenUsage && (
          <div className="text-[10px] text-gray-400 mt-1.5 pt-1 border-t border-gray-200/50 flex gap-2">
            <span>in: {message.tokenUsage.inputTokens.toLocaleString()}</span>
            <span>out: {message.tokenUsage.outputTokens.toLocaleString()}</span>
            <span>total: {message.tokenUsage.totalTokens.toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}

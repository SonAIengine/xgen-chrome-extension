import type { ChatMessage as ChatMessageType } from '../../shared/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallBadge } from './ToolCallBadge';

interface Props {
  message: ChatMessageType;
}

export function ChatMessage({ message }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-blue-500 text-white'
            : isSystem
              ? 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200'
              : 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
        }`}
      >
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {message.toolCalls.map((tc) => (
              <ToolCallBadge key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownRenderer content={message.content} />
          </div>
        )}
      </div>
    </div>
  );
}

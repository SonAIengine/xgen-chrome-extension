import type { ToolCall } from '../../shared/types';

interface Props {
  toolCall: ToolCall;
}

export function ToolCallBadge({ toolCall }: Props) {
  const styles = {
    running: 'bg-amber-50 text-amber-600 border-amber-200',
    done: 'bg-gray-50 text-gray-500 border-gray-200',
    error: 'bg-red-50 text-red-500 border-red-200',
  };

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${styles[toolCall.status]}`}
    >
      {toolCall.status === 'running' && (
        <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {toolCall.tool}
    </span>
  );
}

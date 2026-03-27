import type { ToolCall } from '../../shared/types';

interface Props {
  toolCall: ToolCall;
}

export function ToolCallBadge({ toolCall }: Props) {
  const statusColors = {
    running: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    done: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    error: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  };

  return (
    <div
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[toolCall.status]}`}
    >
      {toolCall.status === 'running' && (
        <span className="animate-spin inline-block w-3 h-3 border border-current border-t-transparent rounded-full" />
      )}
      <span>{toolCall.tool}</span>
    </div>
  );
}

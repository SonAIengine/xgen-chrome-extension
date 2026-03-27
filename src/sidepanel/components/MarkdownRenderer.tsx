import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
}

export function MarkdownRenderer({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre({ children }) {
          return (
            <pre className="bg-gray-800 text-gray-100 rounded-md p-3 my-2 overflow-x-auto text-xs">
              {children}
            </pre>
          );
        },
        code({ children, className }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code className="bg-gray-200 dark:bg-gray-700 px-1 py-0.5 rounded text-xs">
                {children}
              </code>
            );
          }
          return <code className={className}>{children}</code>;
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full text-xs border-collapse border border-gray-300 dark:border-gray-600">
                {children}
              </table>
            </div>
          );
        },
        th({ children }) {
          return (
            <th className="border border-gray-300 dark:border-gray-600 px-2 py-1 bg-gray-100 dark:bg-gray-700 text-left">
              {children}
            </th>
          );
        },
        td({ children }) {
          return (
            <td className="border border-gray-300 dark:border-gray-600 px-2 py-1">
              {children}
            </td>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

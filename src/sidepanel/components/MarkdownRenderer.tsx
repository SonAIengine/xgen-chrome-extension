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
            <pre className="bg-gray-800 text-gray-100 rounded p-2.5 my-1.5 overflow-x-auto text-xs leading-relaxed">
              {children}
            </pre>
          );
        },
        code({ children, className }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code className="bg-gray-100 text-gray-700 px-1 py-0.5 rounded text-xs">
                {children}
              </code>
            );
          }
          return <code className={className}>{children}</code>;
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-1.5">
              <table className="min-w-full text-xs border-collapse border border-gray-200">
                {children}
              </table>
            </div>
          );
        },
        th({ children }) {
          return (
            <th className="border border-gray-200 px-2 py-1 bg-gray-50 text-left text-gray-600 font-medium">
              {children}
            </th>
          );
        },
        td({ children }) {
          return (
            <td className="border border-gray-200 px-2 py-1 text-gray-700">
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

import { useEffect, useRef } from 'react';
import { useChat } from './hooks/useChat';
import { ChatMessage } from './components/ChatMessage';
import { InputArea } from './components/InputArea';
import { PageIndicator } from './components/PageIndicator';

export function App() {
  const { messages, isStreaming, pageContext, sendMessage, clearMessages } = useChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            XGEN AI
          </h1>
          <PageIndicator pageContext={pageContext} />
        </div>
        <button
          onClick={clearMessages}
          className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
          title="대화 초기화"
        >
          Clear
        </button>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500 text-sm">
            XGEN AI 어시스턴트에게 질문하세요
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <InputArea onSend={sendMessage} disabled={isStreaming} />
    </div>
  );
}

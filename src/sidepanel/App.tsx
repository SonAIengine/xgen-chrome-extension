import { useEffect, useRef } from 'react';
import { useChat } from './hooks/useChat';
import { ChatMessage } from './components/ChatMessage';
import { InputArea } from './components/InputArea';
import { SettingsBar } from './components/SettingsBar';
import { useElementPicker, PickerResultPanel } from './components/ElementPickerButton';

export function App() {
  const { messages, isStreaming, sendMessage, stopStream, clearMessages } = useChat();
  const picker = useElementPicker();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex flex-col h-screen bg-white text-gray-800">
      {/* Toolbar — 한 줄 */}
      <div className="border-b border-gray-200">
        <div className="flex items-center px-2 py-1 gap-1">
          {/* Element Picker 아이콘 */}
          <button
            onClick={picker.togglePicker}
            className={`p-1 rounded transition-colors ${
              picker.picking
                ? 'text-violet-600 bg-violet-100'
                : 'text-gray-400 hover:text-gray-600'
            }`}
            title={picker.picking ? '요소 선택 취소 (Esc)' : 'API 캡처 — 요소 선택'}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="22" y1="12" x2="18" y2="12" />
              <line x1="6" y1="12" x2="2" y2="12" />
              <line x1="12" y1="6" x2="12" y2="2" />
              <line x1="12" y1="22" x2="12" y2="18" />
            </svg>
          </button>

          {/* Settings 아이콘 */}
          <SettingsBar />

          <div className="flex-1" />

          <button
            onClick={clearMessages}
            className="text-[11px] text-gray-400 hover:text-gray-600 px-1.5 py-0.5 transition-colors"
            title="대화 초기화"
          >
            초기화
          </button>
        </div>
      </div>

      {/* Picker 결과 패널 (있을 때만) */}
      {picker.result && (
        <PickerResultPanel
          result={picker.result}
          registered={picker.registered}
          registerApi={picker.registerApi}
          closeResult={picker.closeResult}
        />
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-300 text-sm gap-1">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span>메시지를 입력하세요</span>
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <InputArea onSend={sendMessage} onStop={stopStream} isStreaming={isStreaming} />
    </div>
  );
}

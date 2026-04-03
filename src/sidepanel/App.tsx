import { useEffect, useRef, useCallback, useState } from 'react';
import { useChat } from './hooks/useChat';
import { ChatMessage } from './components/ChatMessage';
import { InputArea } from './components/InputArea';
import { SettingsBar } from './components/SettingsBar';
import { useElementPicker, PickerResultPanel } from './components/ElementPickerButton';
import type { ExtensionMessage } from '../shared/types';

export function App() {
  const { messages, isStreaming, sendMessage, stopStream, clearMessages } = useChat();
  const picker = useElementPicker();
  const [authCapturing, setAuthCapturing] = useState(false);
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

          {/* 인증 프로필 생성 */}
          <button
            onClick={() => {
              setAuthCapturing(true);
              // AI에게 내부적으로 로그인 유도 메시지 전송
              chrome.runtime.sendMessage({
                type: 'SEND_MESSAGE',
                content:
                  '현재 사이트의 인증 프로필을 생성해야 해. ' +
                  'API hook을 시작하고, 이 사이트의 로그인 페이지로 이동해서 사용자에게 로그인을 요청해줘. ' +
                  '이미 로그인된 상태면 로그아웃 먼저 하고. ' +
                  '사용자가 로그인하면 캡처된 로그인 정보로 인증 프로필이 자동 생성돼. ' +
                  '로그인 완료 확인 후 get_captured_apis로 로그인 API가 캡처됐는지 확인하고, 결과를 알려줘.',
              } satisfies ExtensionMessage).catch(() => {});
              setTimeout(() => setAuthCapturing(false), 3000);
            }}
            disabled={authCapturing}
            className={`p-1 rounded transition-colors ${
              authCapturing
                ? 'text-green-600 bg-green-100'
                : 'text-gray-400 hover:text-gray-600'
            }`}
            title="인증 프로필 생성 — 로그인 캡처"
          >
            {/* Lock/key icon */}
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
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
          registerError={picker.registerError}
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

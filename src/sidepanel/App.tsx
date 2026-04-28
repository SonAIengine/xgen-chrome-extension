import { useEffect, useRef, useCallback, useState } from 'react';
import { useChat } from './hooks/useChat';
import { ChatMessage } from './components/ChatMessage';
import { InputArea } from './components/InputArea';
import { SettingsBar } from './components/SettingsBar';
import { PlanQuestionPopup } from './components/PlanQuestionPopup';
import { useElementPicker, PickerResultPanel } from './components/ElementPickerButton';
import type { ExtensionMessage, PageContext } from '../shared/types';

function extractHost(u: string | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function App() {
  const {
    messages, isStreaming, sendMessage, stopStream, clearMessages,
    planQuestions, submitQuestionAnswers, dismissQuestions,
    greetProactive,
  } = useChat();
  const picker = useElementPicker();
  const [authCapturing, setAuthCapturing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const greetedHostsRef = useRef<Set<string>>(new Set());
  // 사이드패널 마운트 시점의 active 탭 ID로 pin. 다른 탭의 PAGE_CONTEXT_UPDATE는 무시한다.
  // tabId 기준이라 같은 탭 안에서의 navigation(google.com → x2bee.com)은 통과 = 새 사이트 들어가면 그 host로 greet 동작.
  // 다른 탭으로 focus 전환 시엔 pin 탭의 이벤트만 보므로 무관.
  const pinnedTabIdRef = useRef<number | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 초기 pageContext + SW에서 들어오는 업데이트 수신 (greet trigger용)
  useEffect(() => {
    (async () => {
      // 마운트 시점 active 탭 ID로 pin (chrome.tabs.query는 activeTab permission으로 가능)
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) pinnedTabIdRef.current = tabs[0].id;
      const config = await chrome.runtime.sendMessage({
        type: 'GET_CHAT_CONFIG',
      } satisfies ExtensionMessage);
      if (config?.pageContext) setPageContext(config.pageContext);
    })().catch(() => {});

    const listener = (message: ExtensionMessage) => {
      if (message.type !== 'PAGE_CONTEXT_UPDATE') return;
      const pinned = pinnedTabIdRef.current;
      // pin이 있으면 같은 탭의 업데이트만 통과 (다른 탭은 무시).
      // pin이 없으면 첫 들어온 update로 pin 확립 (초기 query 실패 보강).
      if (pinned !== null) {
        if (message.tabId !== pinned) return;
      } else if (message.tabId !== undefined) {
        pinnedTabIdRef.current = message.tabId;
      }
      setPageContext(message.context);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleClear = useCallback(() => {
    clearMessages();
    pinnedTabIdRef.current = null;
    greetedHostsRef.current = new Set();
    setPageContext(null);
    // 새 active 탭 기준으로 재pin + 재greet
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) pinnedTabIdRef.current = tabs[0].id;
      const config = await chrome.runtime.sendMessage({
        type: 'GET_CHAT_CONFIG',
      } satisfies ExtensionMessage);
      if (config?.pageContext) setPageContext(config.pageContext);
    })().catch(() => {});
  }, [clearMessages]);

  // pageContext.url 변경 → 외부 사이트면 greet (같은 host는 세션 동안 1번)
  useEffect(() => {
    if (!pageContext?.url) {
      console.log('[PathFinder] greet skipped: no pageContext.url', { pageContext });
      return;
    }
    const host = extractHost(pageContext.url);
    if (!host) {
      console.log('[PathFinder] greet skipped: cannot extract host', pageContext.url);
      return;
    }
    (async () => {
      const config = await chrome.runtime.sendMessage({
        type: 'GET_CHAT_CONFIG',
      } satisfies ExtensionMessage);
      const xgenHost = extractHost(config?.serverUrl);
      console.log('[PathFinder] greet check:', { host, xgenHost, alreadyGreeted: greetedHostsRef.current.has(host) });
      // XGEN 내부 페이지면 skip (사이드패널은 XGEN 외부 사이트에서도 열림)
      if (xgenHost && host === xgenHost) {
        console.log('[PathFinder] greet skipped: XGEN internal host');
        return;
      }
      if (greetedHostsRef.current.has(host)) return;
      greetedHostsRef.current.add(host);
      console.log('[PathFinder] greeting:', pageContext.url);
      greetProactive(pageContext.url);
    })().catch((err) => console.warn('[PathFinder] greet trigger failed:', err));
  }, [pageContext?.url, greetProactive]);

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
                  '현재 사이트의 로그인 정보를 저장해야 해. 아래 단계만 수행하고 반드시 멈춰:\n' +
                  '1. start_api_hook 실행\n' +
                  '2. 이미 로그인된 상태면 로그아웃\n' +
                  '3. 로그인 페이지로 이동\n' +
                  '4. 사용자에게 "로그인해주세요"라고만 말하고 대기\n' +
                  '5. 사용자가 로그인했다고 하면 stop_api_hook만 실행\n' +
                  '6. "로그인 정보가 저장되었습니다"라고만 말하고 완전히 멈춰\n\n' +
                  '절대 금지: 검색, 페이지 이동, 도구 등록, 기능 탐색, 추가 질문. 6단계 후 반드시 멈춰.',
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
            onClick={handleClear}
            className="text-[11px] text-gray-400 hover:text-gray-600 px-1.5 py-0.5 transition-colors"
            title="대화 초기화 (현재 탭으로 재설정)"
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
          <ChatMessage
            key={msg.id}
            message={msg}
            onChipClick={(chip) => {
              // 민감 chip은 자물쇠로 시각 표시만 — 실제 confirm은 plan 엔진의 step 직전에 처리.
              // (사용자 피드백: 시작 시점 confirm은 너무 이름. 결제·주문 step 직전에만 묻는다.)
              sendMessage(chip.intent);
            }}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Plan Question Popup */}
      {planQuestions && (
        <PlanQuestionPopup
          questions={planQuestions}
          onSubmit={submitQuestionAnswers}
          onDismiss={dismissQuestions}
        />
      )}

      {/* Input */}
      <InputArea onSend={sendMessage} onStop={stopStream} isStreaming={isStreaming} />
    </div>
  );
}

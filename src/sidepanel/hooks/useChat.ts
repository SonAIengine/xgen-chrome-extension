import { useState, useCallback, useEffect, useRef } from 'react';
import { streamChat } from '../../shared/api';
import type { ChatMessage, ToolCall, ExtensionMessage, PageContext, AiChatRequest } from '../../shared/types';

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const streamingRef = useRef<{ messageId: string; content: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // SW → sidePanel 메시지 리스너 (PAGE_CONTEXT_UPDATE, COMMAND_RESULT 등)
  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      switch (message.type) {
        case 'PAGE_CONTEXT_UPDATE':
          setPageContext(message.context);
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isStreaming) return;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: content.trim(),
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);
      streamingRef.current = null;

      try {
        // 1. SW에서 config 가져오기 (serverUrl, authToken, pageContext 등)
        console.log('[useChat] GET_CHAT_CONFIG 요청...');
        const config = await chrome.runtime.sendMessage({ type: 'GET_CHAT_CONFIG' } satisfies ExtensionMessage);
        console.log('[useChat] GET_CHAT_CONFIG 응답:', config);

        if (!config?.serverUrl) {
          addSystemMessage('XGEN에 먼저 로그인해주세요');
          setIsStreaming(false);
          return;
        }
        if (!config.authToken) {
          addSystemMessage(`${config.serverUrl}에 먼저 로그인해주세요`);
          setIsStreaming(false);
          return;
        }

        // 2. request 조립
        const summary = buildSummary(messages);
        const pc = config.pageContext as PageContext | null;
        const request: AiChatRequest = {
          messages: [{ role: 'user', content: content.trim() }],
          provider: config.provider,
          model: config.model,
          ...(summary ? { conversation_summary: summary } : {}),
          ...(pc ? { page_context: pc } : {}),
          ...(pc?.pageType === 'canvas' && pc.data?.canvasState
            ? { canvas_state: pc.data.canvasState as Record<string, unknown> }
            : {}),
        };

        // 3. sidePanel에서 직접 SSE 스트리밍
        console.log('[useChat] SSE 스트리밍 시작:', config.serverUrl);
        abortRef.current = new AbortController();

        for await (const event of streamChat(config.serverUrl, config.authToken, request, abortRef.current.signal)) {
          if (abortRef.current?.signal.aborted) break;

          switch (event.type) {
            case 'token':
              appendToken(event.content);
              break;

            case 'tool_start':
              appendToolCall({ id: crypto.randomUUID(), tool: event.tool, input: event.input, status: 'running' });
              break;

            case 'tool_end':
              completeToolCall(event.tool, event.output);
              break;

            case 'canvas_command':
            case 'page_command':
              // SW에 위임 → content script로 전달
              console.log('[useChat] RELAY_COMMAND 전송:', event.type, event);
              await chrome.runtime.sendMessage({ type: 'RELAY_COMMAND', event } satisfies ExtensionMessage);
              console.log('[useChat] RELAY_COMMAND 전송 완료');
              break;

            case 'token_usage':
              updateTokenUsage((event as any).usage);
              break;

            case 'error':
              addSystemMessage(`Error: ${event.content}`);
              break;

            case 'done':
              break;
          }
        }
      } catch (err) {
        console.error('[useChat] 에러:', err);
        if (err instanceof DOMException && err.name === 'AbortError') {
          // 사용자 중단 — 무시
        } else {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          addSystemMessage(`Error: ${msg}`);
        }
      } finally {
        setIsStreaming(false);
        streamingRef.current = null;
        abortRef.current = null;
      }
    },
    [isStreaming, messages],
  );

  // ── 헬퍼 함수들 ──

  function appendToken(content: string) {
    if (!streamingRef.current) {
      const id = crypto.randomUUID();
      streamingRef.current = { messageId: id, content: '' };
      setMessages((prev) => [
        ...prev,
        { id, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [] },
      ]);
    }

    streamingRef.current.content += content;
    const fullContent = streamingRef.current.content;
    const msgId = streamingRef.current.messageId;

    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, content: fullContent } : m)),
    );
  }

  function appendToolCall(toolCall: ToolCall) {
    if (!streamingRef.current) {
      const id = crypto.randomUUID();
      streamingRef.current = { messageId: id, content: '' };
      setMessages((prev) => [
        ...prev,
        { id, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [] },
      ]);
    }

    const msgId = streamingRef.current.messageId;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] } : m,
      ),
    );
  }

  function completeToolCall(tool: string, output: string) {
    if (!streamingRef.current) return;
    const msgId = streamingRef.current.messageId;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              toolCalls: m.toolCalls?.map((tc) =>
                tc.tool === tool && tc.status === 'running'
                  ? { ...tc, output, status: 'done' as const }
                  : tc,
              ),
            }
          : m,
      ),
    );
  }

  function updateTokenUsage(tokenUsage: any) {
    if (!streamingRef.current) return;
    const msgId = streamingRef.current.messageId;
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, tokenUsage } : m)),
    );
  }

  function addSystemMessage(content: string) {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'system', content, timestamp: Date.now() },
    ]);
  }

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    streamingRef.current = null;
    setIsStreaming(false);
  }, []);

  return { messages, isStreaming, pageContext, sendMessage, stopStream, clearMessages };
}

/** 최근 대화 요약 빌드 (최대 2턴, 토큰 절약) */
function buildSummary(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';
  const recent = messages.slice(-4); // 최대 2쌍
  const lines = recent
    .map((m) => {
      if (m.role === 'user') return `사용자: ${m.content.slice(0, 60)}`;
      if (m.role === 'assistant') {
        const tools =
          m.toolCalls
            ?.map((t) => t.tool)
            .join(', ') || '';
        const text = m.content.slice(0, 60);
        return `AI: ${text}${tools ? ` [${tools}]` : ''}`;
      }
      return '';
    })
    .filter(Boolean);
  const summary = lines.join('\n');
  return summary.slice(0, 500);
}

import { useState, useCallback, useEffect, useRef } from 'react';
import type { ChatMessage, ToolCall, ExtensionMessage, PageContext } from '../../shared/types';

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const streamingRef = useRef<{ messageId: string; content: string } | null>(null);

  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      switch (message.type) {
        case 'STREAM_TOKEN': {
          if (!streamingRef.current) {
            const id = crypto.randomUUID();
            streamingRef.current = { messageId: id, content: '' };
            setMessages((prev) => [
              ...prev,
              {
                id,
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                toolCalls: [],
              },
            ]);
          }

          streamingRef.current.content += message.content;
          const content = streamingRef.current.content;
          const msgId = streamingRef.current.messageId;

          setMessages((prev) =>
            prev.map((m) => (m.id === msgId ? { ...m, content } : m)),
          );
          break;
        }

        case 'TOOL_START': {
          const toolCall: ToolCall = {
            id: crypto.randomUUID(),
            tool: message.tool,
            input: message.input,
            status: 'running',
          };

          if (streamingRef.current) {
            const msgId = streamingRef.current.messageId;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
                  : m,
              ),
            );
          }
          break;
        }

        case 'TOOL_END': {
          if (streamingRef.current) {
            const msgId = streamingRef.current.messageId;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId
                  ? {
                      ...m,
                      toolCalls: m.toolCalls?.map((tc) =>
                        tc.tool === message.tool && tc.status === 'running'
                          ? { ...tc, output: message.output, status: 'done' as const }
                          : tc,
                      ),
                    }
                  : m,
              ),
            );
          }
          break;
        }

        case 'STREAM_TOKEN_USAGE': {
          if (streamingRef.current) {
            const msgId = streamingRef.current.messageId;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...m, tokenUsage: message.tokenUsage } : m,
              ),
            );
          }
          break;
        }

        case 'STREAM_DONE': {
          setIsStreaming(false);
          streamingRef.current = null;
          break;
        }

        case 'STREAM_ERROR': {
          setIsStreaming(false);
          streamingRef.current = null;

          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `Error: ${message.error}`,
              timestamp: Date.now(),
            },
          ]);
          break;
        }

        case 'PAGE_CONTEXT_UPDATE': {
          setPageContext(message.context);
          break;
        }
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim() || isStreaming) return;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: content.trim(),
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);

      const summary = buildSummary(messages);
      chrome.runtime.sendMessage({
        type: 'SEND_MESSAGE',
        content: content.trim(),
        ...(summary ? { summary } : {}),
      } satisfies ExtensionMessage);
    },
    [isStreaming, messages],
  );

  const stopStream = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'STOP_STREAM' } satisfies ExtensionMessage);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    streamingRef.current = null;
    setIsStreaming(false);
  }, []);

  return { messages, isStreaming, pageContext, sendMessage, stopStream, clearMessages };
}

/** 최근 대화 요약 빌드 (최대 3턴, 토큰 절약) */
function buildSummary(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';
  const recent = messages.slice(-6); // 최대 3쌍
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

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

      chrome.runtime.sendMessage({ type: 'SEND_MESSAGE', content: content.trim() });
    },
    [isStreaming],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    streamingRef.current = null;
    setIsStreaming(false);
  }, []);

  return { messages, isStreaming, pageContext, sendMessage, clearMessages };
}

import { useState, useCallback, useEffect, useRef } from 'react';
import { streamChat, streamGreet } from '../../shared/api';
import type {
  ChatMessage, ToolCall, ExtensionMessage, PageContext, AiChatRequest,
  PipelineState, PlanQuestion, Chip, SiteInfo,
} from '../../shared/types';

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null);
  const [planQuestions, setPlanQuestions] = useState<PlanQuestion[] | null>(null);
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
          ...(pipelineState ? { pipeline_stage: pipelineState.stage } : {}),
          ...(pipelineState?.analysis ? { pipeline_analysis: pipelineState.analysis as Record<string, unknown> } : {}),
          ...(pipelineState?.completed_actions ? { pipeline_completed: pipelineState.completed_actions } : {}),
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

            case 'stage_change':
              setPipelineState((event as any).pipeline);
              break;

            case 'plan_question':
              setPlanQuestions((event as any).questions as PlanQuestion[]);
              break;

            case 'token_usage':
              updateTokenUsage((event as any).usage);
              break;

            case 'error':
              addSystemMessage(`Error: ${event.content}`);
              break;

            case 'done':
              if ((event as any).pipeline) {
                setPipelineState((event as any).pipeline);
              }
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
    [isStreaming, messages, pipelineState],
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

  // ── PathFinder: proactive greeting ──
  const greetProactive = useCallback(async (url: string) => {
    try {
      const config = await chrome.runtime.sendMessage({
        type: 'GET_CHAT_CONFIG',
      } satisfies ExtensionMessage);
      console.log('[PathFinder] greet config:', {
        url,
        serverUrl: config?.serverUrl,
        hasToken: !!config?.authToken,
        provider: config?.provider,
      });
      if (!config?.serverUrl) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: 'PathFinder: XGEN 서버 URL이 설정되지 않았습니다. 설정에서 서버 주소를 확인해주세요.',
            timestamp: Date.now(),
          },
        ]);
        return;
      }
      if (!config?.authToken) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `PathFinder: ${config.serverUrl} 에 먼저 로그인해주세요. 로그인하면 이 사이트에서 자동 제안을 받을 수 있어요.`,
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      const messageId = crypto.randomUUID();
      let siteInfoCaptured: SiteInfo | undefined;
      let chipsCaptured: Chip[] | undefined;
      let contentAccum = '';
      let messageAdded = false;

      for await (const ev of streamGreet(config.serverUrl, config.authToken, url, {
        provider: config.provider,
        model: config.model,
      })) {
        switch (ev.type) {
          case 'context':
            siteInfoCaptured = ev.site;
            console.log('[PathFinder] context:', ev.site);
            break;
          case 'suggestions':
            chipsCaptured = ev.items || [];
            console.log('[PathFinder] suggestions:', chipsCaptured.length);
            break;
          case 'token':
            contentAccum += ev.content;
            if (!messageAdded) {
              messageAdded = true;
              setMessages((prev) => [
                ...prev,
                {
                  id: messageId,
                  role: 'assistant',
                  content: contentAccum,
                  timestamp: Date.now(),
                  isProactive: true,
                  chips: chipsCaptured,
                  siteInfo: siteInfoCaptured,
                },
              ]);
            } else {
              setMessages((prev) =>
                prev.map((m) => (m.id === messageId ? { ...m, content: contentAccum } : m)),
              );
            }
            break;
          case 'done':
            // 토큰이 전혀 안 나왔을 경우(LLM 미설정 등) 폴백으로라도 메시지 추가
            if (!messageAdded) {
              setMessages((prev) => [
                ...prev,
                {
                  id: messageId,
                  role: 'assistant',
                  content: contentAccum || '무엇을 도와드릴까요?',
                  timestamp: Date.now(),
                  isProactive: true,
                  chips: chipsCaptured,
                  siteInfo: siteInfoCaptured,
                },
              ]);
            } else if (chipsCaptured) {
              // chips가 token보다 늦게 도착한 경우도 대비해 최종 업데이트
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === messageId ? { ...m, chips: chipsCaptured, siteInfo: siteInfoCaptured } : m,
                ),
              );
            }
            break;
          case 'error':
            console.warn('[useChat] greet error:', ev.content);
            break;
        }
      }
    } catch (err) {
      console.warn('[useChat] greetProactive failed:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `PathFinder 호출 실패: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        },
      ]);
    }
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    streamingRef.current = null;
    setIsStreaming(false);
    setPipelineState(null);
    setPlanQuestions(null);
  }, []);

  const submitQuestionAnswers = useCallback(
    (answers: { title: string; answer: string }[]) => {
      setPlanQuestions(null);
      const formatted = answers
        .map((a) => `질문: ${a.title}\n답변: ${a.answer}`)
        .join('\n\n');
      sendMessage(formatted);
    },
    [sendMessage],
  );

  const dismissQuestions = useCallback(() => {
    setPlanQuestions(null);
  }, []);

  return {
    messages, isStreaming, pageContext, pipelineState,
    planQuestions, submitQuestionAnswers, dismissQuestions,
    sendMessage, stopStream, clearMessages, greetProactive,
  };
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

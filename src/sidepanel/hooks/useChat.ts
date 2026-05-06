import { useState, useCallback, useEffect, useRef } from 'react';
import { streamChat, streamCollectionRun, streamGreet } from '../../shared/api';
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
  // 현재 사이트가 매칭된 collection — chip 클릭/슬래시 명령이 execute-plan으로 가려면 필요.
  // greet 응답의 siteInfo.collection_id에서 캡처한다.
  const [collectionId, setCollectionId] = useState<string | null>(null);
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
            if (ev.site?.collection_id) {
              setCollectionId(ev.site.collection_id);
            }
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
      // greet은 사이드패널 진입 자동 제안일 뿐 — 실패해도 채팅창에 박지 않는다.
      // 백엔드 도달 실패(502 등)는 사용자가 행동할 수 없어서 노이즈만 됨. console만.
      console.warn('[useChat] greetProactive failed:', err);
    }
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    streamingRef.current = null;
    setIsStreaming(false);
    setPipelineState(null);
    setPlanQuestions(null);
    setCollectionId(null);
  }, []);

  // ── Collection /run — chip 클릭 / 슬래시 / (장래엔 자연어도) ──
  // Stage 1~4 통합: intent 파싱 → plan 합성 (prereq 자동 chain) → 실행 → NL 요약.
  // entity 누락 시 question.required → popup → 답변 → prior_entities에 누적해서 재호출.

  type ActiveRun = {
    requirement: string;
    displayTool?: string;
    msgId: string;
    accumulatedEntities: Record<string, unknown>;
    /** chip 클릭으로 시작된 run — Stage 1 LLM 우회. requirement는 chip 라벨일 뿐. */
    forceTarget?: string;
    /** 같은 run 중 인증 안내를 이미 표시했는지 — 여러 step에서 401 떠도 한 번만. */
    authHintShown?: boolean;
    /** step.started의 args_resolved + tool 이름 — 실행 실패 시 어떤 인자가 비었는지 역추적용. */
    lastStepArgs?: Record<string, unknown>;
    lastStepTool?: string;
  };
  type PendingQuestion = {
    missingField: string;
    /** popup의 label string → entity로 넣을 code 값 */
    optionMap: Record<string, string>;
    /** 옵션이 없으면 free-text — 사용자 입력을 그대로 entity 값으로 사용 */
    isFreeText: boolean;
  };
  const activeRunRef = useRef<ActiveRun | null>(null);
  const pendingQuestionRef = useRef<PendingQuestion | null>(null);

  /** 단일 /run 호출 (한 round). question.required 만나면 그 자리에서 끝남 — 사용자 답변 후 다시 호출됨. */
  const _runOnce = useCallback(
    async (run: ActiveRun) => {
      const config = await chrome.runtime.sendMessage({ type: 'GET_CHAT_CONFIG' } satisfies ExtensionMessage);
      if (!config?.serverUrl) {
        addSystemMessage('XGEN에 먼저 로그인해주세요');
        return;
      }
      if (!config.authToken) {
        addSystemMessage(`${config.serverUrl}에 먼저 로그인해주세요`);
        return;
      }
      if (!collectionId) {
        addSystemMessage('현재 사이트에 매칭된 API collection이 없습니다.');
        return;
      }

      const llm_spec = config.provider && config.model
        ? `${config.provider}/${config.model}`
        : undefined;

      // 사용자 현재 탭 host의 fresh 쿠키 수집 — 캡처 시점의 stale 쿠키 대신 사용.
      // 호출 직전마다 새로 읽어서 사용자 세션이 갱신되면 자동 반영됨.
      let liveCookies: string | undefined;
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabUrl = tabs[0]?.url;
        if (tabUrl) {
          const host = new URL(tabUrl).hostname;
          const resp = await chrome.runtime.sendMessage({
            type: 'GET_LIVE_COOKIES', host,
          } satisfies ExtensionMessage);
          if (resp?.ok && typeof resp.cookieHeader === 'string' && resp.cookieHeader) {
            liveCookies = resp.cookieHeader;
          }
        }
      } catch (err) {
        console.warn('[useChat] live cookie collection failed:', err);
      }

      abortRef.current = new AbortController();

      try {
        for await (const ev of streamCollectionRun(
          config.serverUrl, config.authToken, collectionId,
          {
            requirement: run.requirement,
            ...(llm_spec ? { llm_spec } : {}),
            ...(run.forceTarget ? { force_target: run.forceTarget } : {}),
            ...(Object.keys(run.accumulatedEntities).length
              ? { prior_entities: run.accumulatedEntities }
              : {}),
            ...(liveCookies ? { live_cookies: liveCookies } : {}),
          },
          abortRef.current.signal,
        )) {
          if (abortRef.current?.signal.aborted) break;

          switch (ev.type) {
            case 'intent.parsed':
              // 디버깅용 로그만 — UI 노출은 안 함.
              console.log('[run] intent.parsed:', ev);
              break;

            case 'plan.synthesized': {
              // 백엔드 synthesizer가 question.required를 안 띄웠는데도 plan에 빈 args가 박혀있는
              // 경우 (e.g. parse_intent가 빈 값으로 채움) — 실행하면 4xx/5xx로 죽음.
              // 능동적으로 잡아서 사용자한테 직접 물어본다.
              const plan = ev.plan;
              const missing = plan?.steps ? _findFirstMissingArgInPlan(plan) : null;
              if (missing) {
                console.log('[run] plan has missing arg, aborting + asking:', missing);
                abortRef.current?.abort();
                pendingQuestionRef.current = {
                  missingField: missing.field,
                  optionMap: {},
                  isFreeText: true,
                };
                setPlanQuestions([{
                  title: `"${missing.field}" 값이 필요해요`,
                  type: 'single',
                  options: [],
                  allow_custom: true,  // 자유 입력 (popup의 "기타" 칸 활성)
                  skippable: false,
                }]);
                appendAssistantTextTo(
                  run.msgId,
                  `\n_도구 \`${missing.tool}\` 호출에 \`${missing.field}\` 값이 필요해요. 입력해주세요._`,
                );
                // for-await는 abort로 자연스럽게 catch에 떨어짐.
              } else {
                // 항상 로깅 — backend가 args를 어떤 형태로 채우는지 디버깅 신호.
                console.log('[run] plan.synthesized (no missing detected):', JSON.stringify(plan));
              }
              break;
            }

            case 'question.required': {
              // popup으로 전환. label↔code 매핑 보존해서 답변 시 entity로 변환.
              const opts = ev.options ?? [];
              const optionMap: Record<string, string> = {};
              for (const o of opts) {
                if (o && typeof o.label === 'string' && typeof o.code === 'string') {
                  optionMap[o.label] = o.code;
                }
              }
              pendingQuestionRef.current = {
                missingField: ev.missing_field,
                optionMap,
                isFreeText: opts.length === 0,
              };
              const labelText = ev.missing_semantic
                ? `${ev.missing_field} (${ev.missing_semantic})`
                : ev.missing_field;
              setPlanQuestions([{
                title: `"${labelText}" 값이 필요해요`,
                type: 'single',
                options: opts.map((o) => o.label),
                allow_custom: opts.length === 0 || opts.length < 20,  // 옵션 없거나 적으면 자유 입력 허용
                skippable: false,
              }]);
              return;  // 이 round는 여기서 종료. 사용자 답변 후 _runOnce 재호출.
            }

            case 'plan.started':
              console.log('[run] plan.started:', ev);
              break;

            case 'step.started':
              run.lastStepArgs = ev.args_resolved;
              run.lastStepTool = ev.tool;
              console.log('[run] step.started args_resolved:', ev.tool, ev.args_resolved);
              appendToolCallTo(run.msgId, {
                id: ev.step_id,
                tool: ev.tool,
                displayTool: run.displayTool,
                input: JSON.stringify(ev.args_resolved ?? {}),
                status: 'running',
              });
              break;

            case 'step.completed': {
              const previewText = _previewToString(ev.output_preview);
              completeToolCallByIdIn(run.msgId, ev.step_id, previewText, 'done');
              maybeShowAuthHint(run, previewText);
              break;
            }

            case 'step.failed': {
              const errMsg = ev.error?.message ?? 'failed';
              completeToolCallByIdIn(run.msgId, ev.step_id, errMsg, 'error');
              if (maybeShowAuthHint(run, errMsg)) break;
              // HTTP 에러 + step args가 의심스러우면 popup으로 사용자에게 직접 입력받기.
              maybeAskForMissingArg(run, errMsg);
              break;
            }

            case 'plan.completed':
              // response.generated 가 곧 도착하므로 여기선 noop.
              break;

            case 'plan.aborted': {
              const errMsg = ev.error?.message ?? 'unknown';
              if (maybeShowAuthHint(run, errMsg)) break;
              if (!maybeAskForMissingArg(run, errMsg)) {
                appendAssistantTextTo(run.msgId, `\n⚠️ 실행 중단: ${errMsg}`);
              }
              break;
            }

            case 'response.generated':
              // 최종 NL 답변 — assistant 메시지 본문에 추가.
              // 단, popup이 이미 떠있으면(사용자한테 입력 받는 중) Stage 4의 사과 답변은
              // 노이즈만 됨 — 사용자가 popup 답하면 곧 재호출되니까. 스킵.
              if (pendingQuestionRef.current) break;
              if (ev.answer) appendAssistantTextTo(run.msgId, ev.answer);
              break;

            case 'error':
              if (maybeShowAuthHint(run, ev.message)) break;
              if (!maybeAskForMissingArg(run, ev.message)) {
                appendAssistantTextTo(run.msgId, `\n⚠️ ${ev.stage ? `[${ev.stage}] ` : ''}${ev.message}`);
              }
              break;
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // ignore
        } else {
          addSystemMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        abortRef.current = null;
      }
    },
    [collectionId],
  );

  /** 새 run 시작 — chip 클릭 / 슬래시 / 향후 자연어.
   *  forceTarget이 주어지면 backend Stage 1 LLM 우회 (chip 클릭에서 사용). */
  const runCollection = useCallback(
    async (
      requirement: string,
      displayLabel?: string,
      displayTool?: string,
      forceTarget?: string,
    ) => {
      if (isStreaming) return;
      if (!requirement.trim()) return;
      if (!collectionId) {
        addSystemMessage('현재 사이트에 매칭된 API collection이 없어 도구를 호출할 수 없습니다.');
        return;
      }

      // 기존 멀티턴 상태 초기화 — 새 의도가 들어오면 누적 entity는 리셋.
      pendingQuestionRef.current = null;
      setPlanQuestions(null);

      // 사용자 메시지 + assistant 메시지(빈 본문 + toolCall 누적용) 한 쌍 추가.
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: displayLabel || requirement,
        timestamp: Date.now(),
      };
      const assistantMsgId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantMsgId, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [] },
      ]);
      setIsStreaming(true);

      activeRunRef.current = {
        requirement,
        displayTool,
        forceTarget,
        msgId: assistantMsgId,
        accumulatedEntities: {},
      };

      try {
        await _runOnce(activeRunRef.current);
      } finally {
        // popup 떠 있으면 isStreaming 유지 (사용자 답변 대기 중) — 그 외엔 false.
        if (!pendingQuestionRef.current) {
          setIsStreaming(false);
          activeRunRef.current = null;
        }
      }
    },
    [collectionId, isStreaming, _runOnce],
  );

  /**
   * HTTP 에러를 사용자 입력으로 회복 시도. 우선순위로 target 필드 결정:
   *   0) 백엔드 tool_executor의 명시적 "Missing path parameter(s): X" — 가장 확실
   *   1) args 안 빈/placeholder 필드
   *   2) 1번 못 찾았는데 HTTP 에러면 — 패스 (애매하면 자동 popup 안 띄움. 진짜 서버 에러일 수도)
   * 한 run에서 popup이 이미 떠있으면 중복 setState 방지 — true 반환해서 raw 메시지 막음.
   */
  function maybeAskForMissingArg(run: ActiveRun, errText: string | undefined): boolean {
    if (!errText) return false;
    // 백엔드 tool_executor가 사전검증/validation 정규화로 보낸 메시지를 잡음.
    // 매치 패턴: "Missing path parameter(s): X" / "Missing parameter: X" / "Missing parameters: X"
    // (path 단어는 옵셔널 — Spring validation 등 query param 누락도 같은 흐름)
    const missingPathMatch = errText.match(/Missing\s+(?:path\s+)?parameter(?:s|\(s\))?:?\s*([^\s,)]+)/i);
    const isHttpError = /HTTP\s+(?:Error\s+)?\d{3}/i.test(errText);
    if (!missingPathMatch && !isHttpError) return false;
    if (pendingQuestionRef.current) return true;

    let target: string | null = missingPathMatch ? missingPathMatch[1] : null;
    if (!target) target = _findSuspiciousArg(run.lastStepArgs);
    if (!target) return false;

    pendingQuestionRef.current = {
      missingField: target,
      optionMap: {},
      isFreeText: true,
    };
    setPlanQuestions([{
      title: `"${target}" 값을 알려주세요. 호출이 실패했어요.`,
      type: 'single',
      options: [],
      allow_custom: true,
      skippable: false,
    }]);
    appendAssistantTextTo(
      run.msgId,
      `\n_도구 \`${run.lastStepTool ?? ''}\` 호출 실패 — \`${target}\` 값이 필요해요. 입력하시면 다시 시도합니다._`,
    );
    return true;
  }

  /**
   * 401/403 패턴이면 친절한 안내를 한 번 표시하고 true 반환. 호출자는 raw 에러를
   * 띄우지 말지 결정 가능. 한 run 동안 1회만 노출 (run.authHintShown 플래그).
   */
  function maybeShowAuthHint(run: ActiveRun, errText: string | undefined): boolean {
    if (!errText || !_looksLikeAuthError(errText)) return false;
    if (run.authHintShown) return true;  // 이미 안내함 — raw 추가 출력만 막기
    appendAssistantTextTo(
      run.msgId,
      '\n\n⚠️ **호출이 거절됐어요** (401/403 또는 HTML 응답).\n' +
      '두 가지 가능성이 있어요:\n\n' +
      '**1. 진짜 인증이 필요한 경우** (회원/세션 필요한 API)\n' +
      '→ 상단 🔒 **"인증 프로필 생성"** 버튼으로 로그인 정보를 캡처하세요.\n' +
      '이미 만들었는데도 막히면 도구를 재캡처(우클릭 → API 스캔)해서 프로필과 다시 매칭하세요.\n\n' +
      '**2. 비회원도 되는 API인데 서버가 막은 경우** (CSRF/Origin 검사 등)\n' +
      '→ 사이트가 자기 도메인 외부 요청은 차단하는 패턴. 이 경우 백엔드 보안 정책 때문이라 ' +
      '같은 사이트 내 페이지에서 시도하거나, 도구를 다른 형태로 등록해야 할 수 있어요.',
    );
    run.authHintShown = true;
    return true;
  }

  function appendAssistantTextTo(msgId: string, text: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, content: m.content + text } : m)),
    );
  }

  function appendToolCallTo(msgId: string, toolCall: ToolCall) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] } : m,
      ),
    );
  }

  function completeToolCallByIdIn(
    msgId: string, stepId: string, output: string, status: 'done' | 'error',
  ) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              toolCalls: m.toolCalls?.map((tc) =>
                tc.id === stepId ? { ...tc, output, status } : tc,
              ),
            }
          : m,
      ),
    );
  }

  const submitQuestionAnswers = useCallback(
    async (answers: { title: string; answer: string }[]) => {
      setPlanQuestions(null);
      const pending = pendingQuestionRef.current;
      const run = activeRunRef.current;

      // run + pendingQuestion 컨텍스트가 살아있으면 popup → entity 누적 → 재호출.
      if (pending && run && answers.length > 0) {
        const raw = answers[0].answer.trim();
        if (!raw || raw === '건너뜀') {
          // 답변 없음 → run 종료 (popup dismiss와 동일 처리).
          pendingQuestionRef.current = null;
          activeRunRef.current = null;
          setIsStreaming(false);
          return;
        }
        const firstLabel = raw.split(', ')[0];
        const value = pending.optionMap[firstLabel] ?? raw;
        run.accumulatedEntities = { ...run.accumulatedEntities, [pending.missingField]: value };
        pendingQuestionRef.current = null;

        // 사용자 답변을 별도 user 메시지로 추가 + 재호출용 새 assistant 메시지 생성.
        // 한 메시지에 여러 단계가 누적되면 가독성 떨어져서 매 라운드 분리.
        const newAssistantId = crypto.randomUUID();
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'user',
            content: `${pending.missingField}: ${firstLabel}`,
            timestamp: Date.now(),
          },
          {
            id: newAssistantId,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCalls: [],
          },
        ]);
        run.msgId = newAssistantId;
        // 새 라운드 시작이므로 인증 안내 플래그 리셋 (이전 라운드와 분리).
        run.authHintShown = false;

        try {
          await _runOnce(run);
        } finally {
          if (!pendingQuestionRef.current) {
            setIsStreaming(false);
            activeRunRef.current = null;
          }
        }
        return;
      }

      // run 컨텍스트가 없으면 (= ai-chat-stream의 plan_question) 기존 동작: 텍스트로 sendMessage.
      const formatted = answers
        .map((a) => `질문: ${a.title}\n답변: ${a.answer}`)
        .join('\n\n');
      sendMessage(formatted);
    },
    [_runOnce, sendMessage],
  );

  const dismissQuestions = useCallback(() => {
    setPlanQuestions(null);
    if (pendingQuestionRef.current && activeRunRef.current) {
      // 사용자가 popup을 닫으면 run도 종료.
      pendingQuestionRef.current = null;
      activeRunRef.current = null;
      setIsStreaming(false);
    }
  }, []);

  return {
    messages, isStreaming, pageContext, pipelineState,
    planQuestions, submitQuestionAnswers, dismissQuestions,
    sendMessage, stopStream, clearMessages, greetProactive,
    collectionId, runCollection,
  };
}

function _previewToString(preview: unknown): string {
  if (preview == null) return '';
  if (typeof preview === 'string') return preview;
  try {
    return JSON.stringify(preview);
  } catch {
    return String(preview);
  }
}

/**
 * Plan 의 첫 step에서 빈 값(null/undefined/"")인 인자 필드를 찾아 반환.
 * 백엔드 synthesizer가 미해결 entity를 빈 값으로 채워 그대로 실행되는 케이스를 잡는 안전망.
 * 바인딩 표현식("${s1.body.id}" 같은 placeholder)은 다음 step의 binding이므로 통과.
 */
function _findFirstMissingArgInPlan(
  plan: { steps?: { tool: string; args?: Record<string, unknown> }[] },
): { tool: string; field: string } | null {
  for (const step of plan.steps || []) {
    const found = _findSuspiciousArg(step.args);
    if (found) return { tool: step.tool, field: found };
  }
  return null;
}

/**
 * args dict에서 "비어있거나 미해결로 보이는" 첫 필드 키를 반환.
 * - null/undefined
 * - 빈 문자열
 * - placeholder string ("${...}", "{key}")
 * 중첩 객체는 재귀로 검사하되 dotted path("a.b")로 반환.
 */
function _findSuspiciousArg(
  args: Record<string, unknown> | undefined,
  prefix = '',
): string | null {
  if (!args || typeof args !== 'object') return null;
  for (const [k, v] of Object.entries(args)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) return path;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') return path;
      // backend가 binding/placeholder 그대로 보낸 케이스
      if (/^\$\{.+\}$/.test(s)) return path;
      if (/^\{[A-Za-z_][\w-]*\}$/.test(s)) return path;
      continue;
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = _findSuspiciousArg(v as Record<string, unknown>, path);
      if (nested) return nested;
    }
  }
  return null;
}

/** step output preview에서 401/403 패턴 감지. 백엔드는 `{"status": 401, "error": "Unauthorized", ...}` 형태로 보냄. */
function _looksLikeAuthError(text: string): boolean {
  if (!text) return false;
  // status 코드 (JSON 직렬화 결과 또는 dict.toString)
  if (/"status"\s*:\s*40[13]/.test(text)) return true;
  if (/'status'\s*:\s*40[13]/.test(text)) return true;
  // reason 문자열
  if (/unauthorized/i.test(text)) return true;
  if (/forbidden/i.test(text)) return true;
  return false;
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

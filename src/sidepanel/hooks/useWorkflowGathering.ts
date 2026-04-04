import { useState, useCallback, useEffect, useRef } from 'react';
import type { ExtensionMessage } from '../../shared/types';
import {
  GATHERING_TOPICS,
  type WorkflowGatheringContext,
  type WorkflowSpec,
  type CapturedApiSummary,
  type GatheredInfo,
} from '../../shared/workflow-types';

// ── 프롬프트 상수 ──

const INITIAL_PROMPT = `[워크플로우 생성 모드]
당신은 워크플로우 요구사항 수집 전문가입니다.

## 규칙
1. 한 번에 하나의 주제만 질문하세요
2. 사용자 답변을 간단히 요약 확인한 뒤 다음 주제로 넘어가세요
3. 모든 주제가 완료되면 \`\`\`workflow-json\`\`\` 블록으로 최종 JSON을 출력하세요
4. 사용자가 화면을 보여주거나 API가 캡처되면 워크플로우 단계에 반영하세요
5. 사용자가 "잘 모르겠다"고 하면 합리적인 기본값을 제안하세요

## 수집 주제 (순서대로)
1. 목표/목적 — 이 워크플로우가 무엇을 달성하나
2. 데이터 소스 — API, DB, 파일, 웹 등 어디서 데이터를 가져오나
3. 처리 단계 — 어떤 순서로 처리하나, 반복/분기가 있나
4. 출력 형태 — 결과물이 무엇이고 어디에 저장하나
5. 실행 조건 — 수동/스케줄/이벤트 중 무엇인가
6. 인증/접근 — 로그인이 필요한 시스템이 있나
7. 에러 처리 — 실패 시 어떻게 하나

## 최종 JSON 스키마
\`\`\`
{
  "workflow_name": "string",
  "goal": "string",
  "trigger": { "type": "manual|schedule|event", "detail": "string" },
  "steps": [{ "order": 1, "name": "string", "type": "api_call|web_automation|document_analysis|llm_processing|file_operation|notification", "description": "string", "api": { "url": "string", "method": "string" }, "input_from": "string", "output_name": "string" }],
  "data_sources": [{ "type": "api|s3|database|web", "detail": "string" }],
  "outputs": [{ "type": "string", "destination": "string", "format": "string" }],
  "captured_apis": [{ "url": "string", "method": "string", "description": "string" }],
  "auth_profiles_needed": ["string"],
  "error_handling": "string",
  "constraints": ["string"]
}
\`\`\`

첫 번째 질문을 하세요: 이 워크플로우가 무엇을 달성해야 하는지 물어보세요.`;

function buildFollowUpMessage(
  userText: string,
  gathered: GatheredInfo[],
  capturedApis: CapturedApiSummary[],
  topicIndex: number,
): string {
  const gatheredLines =
    gathered.length > 0
      ? gathered.map((g) => `- ${g.topic}: ${g.summary}`).join('\n')
      : '없음';

  const apiLines =
    capturedApis.length > 0
      ? capturedApis.map((a) => `- ${a.method} ${a.url} (${a.status})`).join('\n')
      : '없음';

  const remaining = GATHERING_TOPICS.slice(topicIndex)
    .map((t) => t.label)
    .join(', ');

  const currentTopic =
    topicIndex < GATHERING_TOPICS.length
      ? GATHERING_TOPICS[topicIndex].label
      : '완료';

  return `[워크플로우 생성 모드 — 계속]

## 수집 완료
${gatheredLines}

## 캡처된 API
${apiLines}

## 남은 주제: ${remaining || '없음 (모두 완료)'}
## 현재 주제: ${currentTopic}

## 사용자 답변:
${userText}

위 맥락을 참고하여 현재 주제에 대해 요약 확인하고 다음 주제를 질문하세요.
모든 주제가 완료되면 \`\`\`workflow-json\`\`\` 블록으로 최종 JSON을 출력하세요.`;
}

// ── JSON 추출 ──

const WORKFLOW_JSON_REGEX = /```workflow-json\s*\n([\s\S]*?)\n```/;

function extractWorkflowJson(content: string): WorkflowSpec | null {
  const match = content.match(WORKFLOW_JSON_REGEX);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as WorkflowSpec;
  } catch {
    return null;
  }
}

// ── 캡처된 API 조회 ──

async function fetchCapturedApis(): Promise<CapturedApiSummary[]> {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'PAGE_COMMAND',
      requestId: crypto.randomUUID(),
      action: 'get_captured_apis',
      params: {},
    } satisfies ExtensionMessage);

    if (result?.success && Array.isArray(result.apis)) {
      return (result.apis as any[]).slice(-20).map((a) => ({
        url: a.url,
        method: a.method,
        status: a.responseStatus ?? a.status ?? 0,
      }));
    }
  } catch {
    // 캡처 실패 시 빈 배열
  }
  return [];
}

// ── Hook ──

interface UseWorkflowGatheringOptions {
  addUserMessage: (content: string) => void;
  messages: { role: string; content: string }[];
}

export function useWorkflowGathering({ addUserMessage, messages }: UseWorkflowGatheringOptions) {
  const [context, setContext] = useState<WorkflowGatheringContext>({
    active: false,
    topicIndex: 0,
    gathered: [],
    capturedApis: [],
  });
  const [result, setResult] = useState<WorkflowSpec | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;

  // ── STREAM_DONE 리스너: JSON 탐지 + 주제 진행 ──
  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      if (message.type !== 'STREAM_DONE') return;
      if (!contextRef.current.active) return;

      // 최신 assistant 메시지에서 JSON 탐지
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      if (!lastAssistant) return;

      const spec = extractWorkflowJson(lastAssistant.content);
      if (spec) {
        // 완료: 결과 세팅, 모드 종료
        setResult(spec);
        setContext((prev) => ({ ...prev, active: false }));
        // stop_api_hook
        chrome.runtime.sendMessage({
          type: 'PAGE_COMMAND',
          requestId: crypto.randomUUID(),
          action: 'stop_api_hook',
          params: {},
        } satisfies ExtensionMessage).catch(() => {});
      } else {
        // 다음 주제로 진행
        setContext((prev) => {
          if (prev.topicIndex < GATHERING_TOPICS.length - 1) {
            return { ...prev, topicIndex: prev.topicIndex + 1 };
          }
          return prev;
        });
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [messages]);

  // ── 수집 시작 ──
  const start = useCallback(() => {
    setContext({
      active: true,
      topicIndex: 0,
      gathered: [],
      capturedApis: [],
    });
    setResult(null);

    // API hook 시작
    chrome.runtime.sendMessage({
      type: 'PAGE_COMMAND',
      requestId: crypto.randomUUID(),
      action: 'start_api_hook',
      params: {},
    } satisfies ExtensionMessage).catch(() => {});

    // 초기 프롬프트 전송
    chrome.runtime.sendMessage({
      type: 'SEND_MESSAGE',
      content: INITIAL_PROMPT,
    } satisfies ExtensionMessage).catch(() => {});
  }, []);

  // ── 메시지 전송 (수집 모드) ──
  const sendMessage = useCallback(
    async (userText: string) => {
      if (!userText.trim()) return;

      // UI에 사용자 버블 표시
      addUserMessage(userText);

      // 캡처된 API 최신화
      const apis = await fetchCapturedApis();

      // gathered 업데이트: 현재 주제를 사용자 답변 요약으로 기록
      const currentTopic = GATHERING_TOPICS[contextRef.current.topicIndex];
      const newGathered: GatheredInfo[] = [
        ...contextRef.current.gathered,
        ...(currentTopic
          ? [{ topic: currentTopic.key, summary: userText.slice(0, 150) }]
          : []),
      ];

      setContext((prev) => ({
        ...prev,
        capturedApis: apis,
        gathered: newGathered,
      }));

      // enriched content 빌드 및 전송
      const enrichedContent = buildFollowUpMessage(
        userText,
        newGathered,
        apis,
        contextRef.current.topicIndex,
      );

      chrome.runtime.sendMessage({
        type: 'SEND_MESSAGE',
        content: enrichedContent,
      } satisfies ExtensionMessage).catch(() => {});
    },
    [addUserMessage],
  );

  // ── 취소 ──
  const cancel = useCallback(() => {
    setContext((prev) => ({ ...prev, active: false }));
    chrome.runtime.sendMessage({
      type: 'PAGE_COMMAND',
      requestId: crypto.randomUUID(),
      action: 'stop_api_hook',
      params: {},
    } satisfies ExtensionMessage).catch(() => {});
  }, []);

  // ── 결과 닫기 ──
  const clearResult = useCallback(() => {
    setResult(null);
  }, []);

  return {
    context,
    result,
    start,
    sendMessage,
    cancel,
    clearResult,
  };
}

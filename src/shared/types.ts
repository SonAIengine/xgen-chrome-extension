// ── Token Usage ──

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ── PathFinder ──

export interface SiteInfo {
  status: 'matched' | 'unknown' | 'invalid_url';
  host?: string;
  collection_id?: string;
  name?: string;
  description?: string;
  matched_pattern?: string;
  tool_count?: number;
  ambiguous?: boolean;
}

export interface Chip {
  id: string;
  title: string;
  emoji?: string;
  intent: string;
  requires_confirm?: boolean;
  tool_name?: string;
}

export type PathFinderEvent =
  | { type: 'context'; site: SiteInfo }
  | { type: 'suggestions'; items: Chip[] }
  | { type: 'token'; content: string }
  | { type: 'done' }
  | { type: 'error'; content: string };

// ── Collection /run (NL → intent → plan → exec → response) ──

export interface QuestionOption {
  code: string;
  label: string;
}

/** /run SSE 이벤트 — Stage 1~4 + Plan Runner 이벤트 통합. */
export type CollectionRunEvent =
  | { type: 'intent.parsed'; target?: string; entities?: Record<string, unknown> }
  | { type: 'plan.synthesized'; plan?: { steps?: { id: string; tool: string; args?: Record<string, unknown> }[] } }
  | {
      type: 'question.required';
      missing_field: string;
      missing_semantic?: string;
      field_type?: 'free' | 'enum' | 'from_producer';
      options?: QuestionOption[];
      current_entities?: Record<string, unknown>;
      message?: string;
      source_tool?: string;
    }
  | { type: 'plan.started'; plan_id?: string; goal?: string; step_count?: number }
  | { type: 'step.started'; step_id: string; tool: string; args_resolved?: Record<string, unknown>; index?: number; total?: number }
  | { type: 'step.completed'; step_id: string; tool: string; duration_ms?: number; output_preview?: unknown; output_size?: number }
  | { type: 'step.failed'; step_id: string; tool: string; error?: { message?: string } & Record<string, unknown>; duration_ms?: number }
  | { type: 'plan.completed'; plan_id?: string; output?: unknown; total_duration_ms?: number }
  | { type: 'plan.aborted'; plan_id?: string; failed_step?: string; error?: { message?: string } & Record<string, unknown>; total_duration_ms?: number }
  | { type: 'response.generated'; answer: string }
  | { type: 'error'; stage?: string; message: string };

export interface CollectionRunRequest {
  requirement: string;
  llm_spec?: string;
  top_k?: number;
  prior_entities?: Record<string, unknown>;
  /** chip 클릭처럼 target tool이 이미 결정된 경우. 백엔드는 Stage 1 LLM 우회. */
  force_target?: string;
  /** 호출 시점에 사용자 브라우저가 들고있는 fresh 쿠키 헤더 ("name=value; name2=value2").
   *  캡처된 stale 쿠키 대신 이걸 우선 사용 → 세션/로그인 상태가 항상 사용자 화면과 동기. */
  live_cookies?: string;
  auth_token_override?: string;
  base_url_override?: string;
}

// ── Chat Messages ──

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  tokenUsage?: TokenUsage;
  // PathFinder proactive greeting
  isProactive?: boolean;
  chips?: Chip[];
  siteInfo?: SiteInfo;
}

export interface ToolCall {
  id: string;
  tool: string;
  /** 사용자 노출용 친화 이름 (예: chip.title). 없으면 tool 사용. */
  displayTool?: string;
  input: string;
  output?: string;
  status: 'running' | 'done' | 'error';
}

// ── SSE Events (from backend) ──

export interface PipelineState {
  stage: string;
  is_active: boolean;
  history: string[];
  analysis?: Record<string, unknown>;
  completed_actions?: string[];
}

export interface PlanQuestion {
  title: string;
  type: 'single' | 'multi';
  options: string[];
  allow_custom?: boolean;
  skippable?: boolean;
}

export type SSEEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_start'; tool: string; input: string }
  | { type: 'tool_end'; tool: string; output: string }
  | { type: 'canvas_command'; action: string; params: Record<string, unknown> }
  | { type: 'page_command'; action: string; params: Record<string, unknown>; requestId?: string }
  | { type: 'token_usage'; usage: TokenUsage }
  | { type: 'stage_change'; stage: string; pipeline: PipelineState }
  | { type: 'plan_question'; questions: PlanQuestion[] }
  | { type: 'done'; pipeline?: PipelineState }
  | { type: 'error'; content: string };

// ── API Request ──

export interface AiChatRequest {
  messages: { role: string; content: string }[];
  provider: string;
  model: string;
  canvas_state?: Record<string, unknown>;
  page_context?: PageContext;
  conversation_summary?: string;
  pipeline_stage?: string;
  pipeline_analysis?: Record<string, unknown>;
  pipeline_completed?: string[];
}

// ── Page Agent ──

export type PageType =
  | 'canvas'
  | 'workflows'
  | 'chat'
  | 'admin'
  | 'data'
  | 'models'
  | 'ml-monitoring'
  | 'unknown';

export interface PageContext {
  pageType: PageType;
  url: string;
  title: string;
  elements?: string;             // DOM 평탄화 텍스트 "[0]<button>..." (PageController)
  snapshotId?: string;           // elements 해시 — LLM 도구 호출 시 freshness 검증용
  data: Record<string, unknown>;
  availableActions: string[];
  timestamp: number;
}

export interface PageCommandResult {
  success: boolean;
  action: string;
  result?: unknown;
  pageContext?: PageContext;  // 액션 실행 후 DOM 재스캔 결과
  error?: string;
}

// ── Chrome Extension Messages ──

export type ExtensionMessage =
  | { type: 'SEND_MESSAGE'; content: string; summary?: string }
  | { type: 'STOP_STREAM' }
  | { type: 'STREAM_TOKEN'; content: string }
  | { type: 'TOOL_START'; tool: string; input: string }
  | { type: 'TOOL_END'; tool: string; output: string }
  | { type: 'STREAM_DONE' }
  | { type: 'STREAM_TOKEN_USAGE'; tokenUsage: TokenUsage }
  | { type: 'STREAM_ERROR'; error: string }
  | { type: 'SET_TOKEN'; token: string; origin: string }
  | { type: 'SET_ORIGIN'; origin: string }
  | { type: 'GET_PAGE_CONTEXT' }
  | { type: 'PAGE_CONTEXT_UPDATE'; context: PageContext; tabId?: number }
  | { type: 'PAGE_COMMAND'; requestId: string; action: string; params: Record<string, unknown> }
  | { type: 'PAGE_COMMAND_RESULT'; requestId: string; result: PageCommandResult }
  | { type: 'CANVAS_COMMAND'; requestId: string; action: string; params: Record<string, unknown> }
  | { type: 'CANVAS_RESULT'; requestId: string; result: unknown }
  // ── API Hook (content script → service worker) ──
  | { type: 'API_CAPTURED'; data: import('./api-hook-types').CapturedApi }
  // ── SSE 직접 소비 (sidePanel ↔ SW) ──
  | { type: 'GET_CHAT_CONFIG' }
  | { type: 'CHAT_CONFIG'; serverUrl: string; authToken: string; provider: string; model: string; pageContext: PageContext | null }
  | { type: 'RELAY_COMMAND'; event: SSEEvent }
  | { type: 'COMMAND_RESULT'; requestId: string; result: unknown }
  // ── Element Picker ──
  | { type: 'ELEMENT_PICKER_START' }
  | { type: 'ELEMENT_PICKER_STOP' }
  | { type: 'ELEMENT_PICKER_RESULT'; apis: import('./api-hook-types').CapturedApi[]; elementInfo: { tag: string; text: string; url: string } }
  // ── Capture Session (사용자 클릭 캡처 누적용; AI 자동 탐색은 제외) ──
  | { type: 'START_CAPTURE_SESSION' }
  | { type: 'STOP_CAPTURE_SESSION' }
  | { type: 'CAPTURE_SESSION_STATUS'; active: boolean; tabId?: number; count?: number }
  | { type: 'CAPTURE_SESSION_RESULT'; apis: import('./api-hook-types').CapturedApi[]; tabId: number; durationMs: number }
  /** sidepanel이 stop 이후에 처음 열렸을 때 SW에 캐시된 마지막 결과를 직접 가져오기 위한 query. */
  | { type: 'GET_CAPTURE_RESULT' }
  /** 특정 host의 현재 살아있는 쿠키를 SW에서 chrome.cookies API로 읽어 반환.
   *  collection /run 호출 직전에 사용자 브라우저의 fresh 세션을 외부 API에 전달하기 위함. */
  | { type: 'GET_LIVE_COOKIES'; host: string }
  /** host 도메인에 매칭되는 인증 프로필의 service_id 조회. SessionResultPanel이 collection
   *  등록 시 auth_profile_id를 같이 넘기기 위해 사용. SW의 autoMatchAuthProfile 재사용. */
  | { type: 'LOOKUP_AUTH_PROFILE_FOR_HOST'; host: string }
  // ── Floating Overlay (우클릭 → API 스캔 진입점) ──
  // SW → content: 페이지 위 플로팅 "녹화중" UI 표시/숨김.
  // content → SW: 사용자가 overlay의 정지 버튼 누름.
  | { type: 'SHOW_FLOATING_OVERLAY' }
  | { type: 'HIDE_FLOATING_OVERLAY' }
  | { type: 'STOP_FLOATING_CAPTURE' };

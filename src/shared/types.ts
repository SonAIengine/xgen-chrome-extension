// ── Token Usage ──

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ── Chat Messages ──

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  tokenUsage?: TokenUsage;
}

export interface ToolCall {
  id: string;
  tool: string;
  input: string;
  output?: string;
  status: 'running' | 'done' | 'error';
}

// ── SSE Events (from backend) ──

export type SSEEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_start'; tool: string; input: string }
  | { type: 'tool_end'; tool: string; output: string }
  | { type: 'canvas_command'; action: string; params: Record<string, unknown> }
  | { type: 'page_command'; action: string; params: Record<string, unknown>; requestId?: string }
  | { type: 'token_usage'; usage: TokenUsage }
  | { type: 'done' }
  | { type: 'error'; content: string };

// ── API Request ──

export interface AiChatRequest {
  messages: { role: string; content: string }[];
  provider: string;
  model: string;
  canvas_state?: Record<string, unknown>;
  page_context?: PageContext;
  conversation_summary?: string;
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
  | { type: 'PAGE_CONTEXT_UPDATE'; context: PageContext }
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
  | { type: 'ELEMENT_PICKER_RESULT'; apis: import('./api-hook-types').CapturedApi[]; elementInfo: { tag: string; text: string; url: string } };

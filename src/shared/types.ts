// ── Chat Messages ──

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
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
  | { type: 'page_command'; action: string; params: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; content: string };

// ── API Request ──

export interface AiChatRequest {
  messages: { role: string; content: string }[];
  provider: string;
  model: string;
  canvas_state?: Record<string, unknown>;
  page_context?: PageContext;
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
  data: Record<string, unknown>;
  availableActions: string[];
  timestamp: number;
}

export interface PageCommandResult {
  success: boolean;
  action: string;
  result?: unknown;
  error?: string;
}

// ── Chrome Extension Messages ──

export type ExtensionMessage =
  | { type: 'SEND_MESSAGE'; content: string }
  | { type: 'STREAM_TOKEN'; content: string }
  | { type: 'TOOL_START'; tool: string; input: string }
  | { type: 'TOOL_END'; tool: string; output: string }
  | { type: 'STREAM_DONE' }
  | { type: 'STREAM_ERROR'; error: string }
  | { type: 'SET_TOKEN'; token: string }
  | { type: 'SET_ORIGIN'; origin: string }
  | { type: 'GET_PAGE_CONTEXT' }
  | { type: 'PAGE_CONTEXT_UPDATE'; context: PageContext }
  | { type: 'PAGE_COMMAND'; requestId: string; action: string; params: Record<string, unknown> }
  | { type: 'PAGE_COMMAND_RESULT'; requestId: string; result: PageCommandResult }
  | { type: 'CANVAS_COMMAND'; requestId: string; action: string; params: Record<string, unknown> }
  | { type: 'CANVAS_RESULT'; requestId: string; result: unknown };

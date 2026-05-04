export const DEFAULT_SERVER_URL = 'https://xgen.x2bee.com';
export const API_CHAT_ENDPOINT = '/api/ai-chat/stream';
export const API_PROVIDERS_ENDPOINT = '/api/ai-chat/providers';
export const API_PATHFINDER_RESOLVE = '/api/pathfinder/resolve';
export const API_PATHFINDER_GREET = '/api/pathfinder/greet';
export const API_COLLECTION_RUN = (collectionId: string) =>
  `/api/tools/api-collections/${encodeURIComponent(collectionId)}/run`;
export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

// 백엔드 지원 프로바이더 (GET /api/ai-chat/providers에서 동적 확인 가능)
export const PROVIDERS = {
  anthropic: { label: 'Anthropic', defaultModel: 'claude-sonnet-4-20250514' },
  openai: { label: 'OpenAI', defaultModel: 'gpt-4o' },
  google: { label: 'Google Gemini', defaultModel: 'gemini-2.0-flash' },
  bedrock: { label: 'AWS Bedrock', defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
  vllm: { label: 'vLLM', defaultModel: '' },
} as const;

export const STORAGE_KEYS = {
  SERVER_URL: 'serverUrl',
  PROVIDER: 'provider',
  MODEL: 'model',
  AUTH_TOKEN: 'authToken',
  CHAT_HISTORY: 'chatHistory',
} as const;

import {
  API_CHAT_ENDPOINT,
  API_COLLECTION_RUN,
  API_PATHFINDER_GREET,
  API_PATHFINDER_RESOLVE,
  API_PROVIDERS_ENDPOINT,
} from './constants';
import type {
  AiChatRequest, CollectionRunEvent, CollectionRunRequest,
  PathFinderEvent, SiteInfo, SSEEvent,
} from './types';

export interface ProviderInfo {
  provider: string;
  models: string[];
  available: boolean;
}

export async function fetchProviders(
  serverUrl: string,
  token: string,
): Promise<ProviderInfo[]> {
  const url = `${serverUrl}${API_PROVIDERS_ENDPOINT}`;
  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Providers API error: ${response.status}`);
  }

  return response.json();
}

export async function* streamChat(
  serverUrl: string,
  token: string,
  request: AiChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const url = `${serverUrl}${API_CHAT_ENDPOINT}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      if (data === '[DONE]') return;

      try {
        yield JSON.parse(data) as SSEEvent;
      } catch {
        // skip malformed JSON
      }
    }
  }
}

// ── Collection: /run (Stage 1~4 통합 — NL → intent → plan → exec → response) ──

export async function* streamCollectionRun(
  serverUrl: string,
  token: string,
  collectionId: string,
  body: CollectionRunRequest,
  signal?: AbortSignal,
): AsyncGenerator<CollectionRunEvent> {
  const url = `${serverUrl}${API_COLLECTION_RUN(collectionId)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`collection run error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      try {
        yield JSON.parse(data) as CollectionRunEvent;
      } catch {
        // skip malformed JSON
      }
    }
  }
}

// ── Tool Collections ──

export interface FromTraceTool {
  method: string;
  templatedPath: string;
  pathParams: string[];
  queryParamKeys: string[];
  /** 캡처 시 본 query 값 — 호출 시 default로 사용 (enum/설정 자동 채움). */
  querySample?: Record<string, string>;
  requestBodySample?: unknown;
  responseSample?: unknown;
  label: string;
  sampleCount: number;
}

export interface FromTraceEdge {
  fromToolId: string;
  toToolId: string;
  confidence: number;
  sampleSharedValue?: string;
}

export interface FromTraceRequest {
  host: string;
  tools: FromTraceTool[];
  edges: FromTraceEdge[];
  name?: string;
  authProfileId?: string;
}

export interface FromTraceConflict {
  status: 409;
  collectionId: string;
  name: string;
  message: string;
}

export interface FromTraceSuccess {
  status: 201;
  collection: Record<string, unknown>;
}

export type FromTraceResult = FromTraceSuccess | FromTraceConflict;

export async function createCollectionFromTrace(
  serverUrl: string,
  token: string,
  payload: FromTraceRequest,
): Promise<FromTraceResult> {
  const url = `${serverUrl}/api/tools/api-collections/from-trace`;
  const body: Record<string, unknown> = {
    host: payload.host,
    tools: payload.tools,
    edges: payload.edges,
  };
  if (payload.name) body.name = payload.name;
  if (payload.authProfileId) body.auth_profile_id = payload.authProfileId;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    const detail = await response.json().catch(() => ({}));
    const d = detail?.detail ?? detail;
    return {
      status: 409,
      collectionId: d?.collection_id ?? '',
      name: d?.name ?? '',
      message: d?.message ?? d?.hint ?? `Conflict: ${response.statusText}`,
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Collection create failed: ${response.status} ${text}`);
  }
  const json = await response.json();
  return { status: 201, collection: json };
}

// ── PathFinder ──

export async function resolveSite(
  serverUrl: string,
  token: string,
  url: string,
): Promise<SiteInfo> {
  const endpoint = `${serverUrl}${API_PATHFINDER_RESOLVE}?url=${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`PathFinder resolve error: ${response.status}`);
  }
  return response.json();
}

export async function* streamGreet(
  serverUrl: string,
  token: string,
  url: string,
  options?: { provider?: string; model?: string; topK?: number; signal?: AbortSignal },
): AsyncGenerator<PathFinderEvent> {
  const endpoint = `${serverUrl}${API_PATHFINDER_GREET}`;
  const body: Record<string, unknown> = { url };
  if (options?.provider) body.provider = options.provider;
  if (options?.model) body.model = options.model;
  if (options?.topK) body.top_k = options.topK;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`PathFinder greet error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      try {
        yield JSON.parse(data) as PathFinderEvent;
      } catch {
        // skip malformed JSON
      }
    }
  }
}

import {
  API_CHAT_ENDPOINT,
  API_PATHFINDER_GREET,
  API_PATHFINDER_RESOLVE,
  API_PROVIDERS_ENDPOINT,
} from './constants';
import type { AiChatRequest, PathFinderEvent, SiteInfo, SSEEvent } from './types';

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

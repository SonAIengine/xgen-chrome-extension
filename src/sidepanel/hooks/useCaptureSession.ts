import { useCallback, useEffect, useState } from 'react';
import type { ExtensionMessage } from '../../shared/types';
import type { CapturedApi } from '../../shared/api-hook-types';

export interface SessionResult {
  apis: CapturedApi[];
  tabId: number;
  durationMs: number;
}

export interface CaptureSessionState {
  active: boolean;
  count: number;
  result: SessionResult | null;
  start: () => void;
  stop: () => void;
  dismissResult: () => void;
}

export function useCaptureSession(): CaptureSessionState {
  const [active, setActive] = useState(false);
  const [count, setCount] = useState(0);
  const [result, setResult] = useState<SessionResult | null>(null);

  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      if (message.type === 'CAPTURE_SESSION_STATUS') {
        setActive(message.active);
        setCount(message.count ?? 0);
      } else if (message.type === 'CAPTURE_SESSION_RESULT') {
        setActive(false);
        setCount(0);
        setResult({
          apis: message.apis,
          tabId: message.tabId,
          durationMs: message.durationMs,
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // 사이드패널이 stop 이후에 처음 열린 케이스 — 그때는 broadcast를 놓쳤으니
    // SW에 캐시된 결과를 직접 query. 한 번 읽으면 SW가 소비(null)해서 재마운트 시
    // 옛 결과가 다시 노출되지 않는다.
    chrome.runtime
      .sendMessage({ type: 'GET_CAPTURE_RESULT' } satisfies ExtensionMessage)
      .then((resp: { ok?: boolean; result?: SessionResult | null } | undefined) => {
        if (resp?.result) {
          setActive(false);
          setCount(0);
          setResult(resp.result);
        }
      })
      .catch(() => {});

    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const start = useCallback(() => {
    setResult(null);
    chrome.runtime
      .sendMessage({ type: 'START_CAPTURE_SESSION' } satisfies ExtensionMessage)
      .catch(() => {});
  }, []);

  const stop = useCallback(() => {
    chrome.runtime
      .sendMessage({ type: 'STOP_CAPTURE_SESSION' } satisfies ExtensionMessage)
      .catch(() => {});
  }, []);

  const dismissResult = useCallback(() => setResult(null), []);

  return { active, count, result, start, stop, dismissResult };
}

import { useState, useEffect, useCallback } from 'react';
import type { ExtensionMessage } from '../../shared/types';
import type { CapturedApi } from '../../shared/api-hook-types';

interface PickerResult {
  apis: CapturedApi[];
  elementInfo: { tag: string; text: string; url: string };
}

/**
 * 아이콘 버튼 (toolbar용) — 반환
 * 결과 패널은 renderResultPanel()로 별도 렌더링
 */
export function useElementPicker() {
  const [picking, setPicking] = useState(false);
  const [result, setResult] = useState<PickerResult | null>(null);
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      if (message.type === 'ELEMENT_PICKER_RESULT') {
        setPicking(false);
        setResult({
          apis: message.apis,
          elementInfo: message.elementInfo,
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const togglePicker = useCallback(() => {
    if (picking) {
      setPicking(false);
      chrome.runtime.sendMessage({ type: 'ELEMENT_PICKER_STOP' } as ExtensionMessage);
    } else {
      setPicking(true);
      setResult(null);
      setRegistered(false);
      chrome.runtime.sendMessage({ type: 'ELEMENT_PICKER_START' } satisfies ExtensionMessage);
    }
  }, [picking]);

  const registerApi = useCallback((api: CapturedApi) => {
    const toolName = new URL(api.url).pathname.split('/').filter(Boolean).join('_') || 'api_tool';
    const description = `${api.method} ${new URL(api.url).pathname}`;

    chrome.runtime.sendMessage({
      type: 'SEND_MESSAGE',
      content: `다음 API를 XGEN 도구로 등록해줘:\n- function_name: ${toolName}\n- api_url: ${api.url}\n- api_method: ${api.method}\n- description: ${description}\n- body_type: ${api.contentType || 'application/json'}${api.requestBody ? `\n- request body 예시: ${api.requestBody.slice(0, 300)}` : ''}`,
    } satisfies ExtensionMessage);

    setRegistered(true);
  }, []);

  const closeResult = useCallback(() => {
    setResult(null);
    setRegistered(false);
  }, []);

  return { picking, result, registered, togglePicker, registerApi, closeResult };
}

export function ElementPickerButton() {
  const { picking, togglePicker } = useElementPicker();

  return (
    <button
      onClick={togglePicker}
      className={`p-1 rounded transition-colors ${
        picking
          ? 'text-violet-600 bg-violet-100'
          : 'text-gray-400 hover:text-gray-600'
      }`}
      title={picking ? '요소 선택 취소 (Esc)' : 'API 캡처 — 요소 선택'}
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="22" y1="12" x2="18" y2="12" />
        <line x1="6" y1="12" x2="2" y2="12" />
        <line x1="12" y1="6" x2="12" y2="2" />
        <line x1="12" y1="22" x2="12" y2="18" />
      </svg>
    </button>
  );
}

export function PickerResultPanel({ result, registered, registerApi, closeResult }: {
  result: PickerResult;
  registered: boolean;
  registerApi: (api: CapturedApi) => void;
  closeResult: () => void;
}) {
  return (
    <div className="border-b border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-gray-600">
          캡처 결과
        </span>
        <button onClick={closeResult} className="text-[10px] text-gray-400 hover:text-gray-600">
          닫기
        </button>
      </div>

      <div className="text-[11px] text-gray-500 mb-1.5">
        <span className="font-mono bg-gray-200 px-1 rounded">{result.elementInfo.tag}</span>
        {result.elementInfo.text && (
          <span className="ml-1">"{result.elementInfo.text.slice(0, 20)}"</span>
        )}
      </div>

      {result.apis.filter(a => a.method !== 'NAVIGATION').length === 0 ? (
        <p className="text-[11px] text-gray-400">
          API 요청이 캡처되지 않았습니다.
        </p>
      ) : (
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {result.apis.filter(a => a.method !== 'NAVIGATION').map((api) => (
            <div key={api.id} className="flex items-center gap-1.5 text-[10px]">
              <span className={`font-mono font-bold px-1 py-0.5 rounded ${
                api.method === 'GET' ? 'bg-green-100 text-green-700' :
                api.method === 'POST' ? 'bg-blue-100 text-blue-700' :
                'bg-gray-100 text-gray-600'
              }`}>
                {api.method}
              </span>
              <span className="font-mono text-gray-500 truncate flex-1">
                {(() => { try { return new URL(api.url).pathname; } catch { return api.url; } })()}
              </span>
              <span className="text-gray-300">{api.responseStatus}</span>
              <button
                onClick={() => registerApi(api)}
                disabled={registered}
                className="px-1.5 py-0.5 bg-violet-500 text-white rounded hover:bg-violet-600 disabled:opacity-40 text-[9px] flex-none"
              >
                {registered ? '전송됨' : '등록'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

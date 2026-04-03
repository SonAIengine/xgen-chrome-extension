import { useState, useEffect, useCallback } from 'react';
import type { ExtensionMessage } from '../../shared/types';
import type { CapturedApi } from '../../shared/api-hook-types';

interface PickerResult {
  apis: CapturedApi[];
  elementInfo: { tag: string; text: string; url: string };
}

export function useElementPicker() {
  const [picking, setPicking] = useState(false);
  const [result, setResult] = useState<PickerResult | null>(null);
  const [registered, setRegistered] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [registerError, setRegisterError] = useState('');

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
      setRegistered('idle');
      chrome.runtime.sendMessage({ type: 'ELEMENT_PICKER_START' } satisfies ExtensionMessage);
    }
  }, [picking]);

  const registerApi = useCallback(async (api: CapturedApi) => {
    let pathname: string;
    try { pathname = new URL(api.url).pathname; } catch { pathname = api.url; }
    const toolName = pathname.split('/').filter(Boolean).join('_') || 'api_tool';
    const description = `${api.method} ${pathname}`;

    setRegistered('loading');
    setRegisterError('');

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'PAGE_COMMAND',
        requestId: crypto.randomUUID(),
        action: 'register_tool',
        params: {
          function_name: toolName,
          api_url: api.url,
          api_method: api.method,
          description,
          body_type: api.contentType || 'application/json',
        },
      } satisfies ExtensionMessage);

      if (result && result.success === false) {
        const isAuthError = result.error?.includes('인증이 필요');
        if (isAuthError) {
          // 인증 필요 → AI에게 내부적으로 로그인 유도 메시지 전송 (채팅에 안 보임)
          setRegistered('loading');
          setRegisterError('로그인이 필요합니다');
          chrome.runtime.sendMessage({
            type: 'SEND_MESSAGE',
            content:
              `방금 등록하려는 API(${api.url})에 인증이 필요해. ` +
              `API hook을 시작하고, 이 사이트의 로그인 페이지로 이동해서 사용자에게 로그인을 요청해줘. ` +
              `이미 로그인된 상태면 로그아웃 먼저 하고. ` +
              `사용자가 로그인하면 캡처된 정보로 인증 프로필이 자동 생성되니까, 그 후에 다시 이 API를 register_tool로 등록해줘.`,
          } satisfies ExtensionMessage).catch(() => {});
        } else {
          setRegistered('error');
          setRegisterError(result.error || '등록 실패');
        }
      } else {
        setRegistered('done');
      }
    } catch (err) {
      setRegistered('error');
      setRegisterError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, []);

  const closeResult = useCallback(() => {
    setResult(null);
    setRegistered('idle');
    setRegisterError('');
  }, []);

  return { picking, result, registered, registerError, togglePicker, registerApi, closeResult };
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

export function PickerResultPanel({ result, registered, registerError, registerApi, closeResult }: {
  result: PickerResult;
  registered: 'idle' | 'loading' | 'done' | 'error';
  registerError: string;
  registerApi: (api: CapturedApi) => void;
  closeResult: () => void;
}) {
  const filteredApis = result.apis.filter(a => a.method !== 'NAVIGATION');

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

      {registered === 'loading' && (
        <p className="text-[11px] text-violet-500">등록 중...</p>
      )}
      {registered === 'done' && (
        <p className="text-[11px] text-green-600">등록 완료</p>
      )}
      {registered === 'error' && (
        <p className="text-[11px] text-red-500">등록 실패: {registerError}</p>
      )}

      {registered === 'idle' && (
        <>
          <div className="text-[11px] text-gray-500 mb-1.5">
            <span className="font-mono bg-gray-200 px-1 rounded">{result.elementInfo.tag}</span>
            {result.elementInfo.text && (
              <span className="ml-1">"{result.elementInfo.text.slice(0, 20)}"</span>
            )}
          </div>

          {filteredApis.length === 0 ? (
            <p className="text-[11px] text-gray-400">
              API 요청이 캡처되지 않았습니다.
            </p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {filteredApis.map((api) => (
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
                    className="px-1.5 py-0.5 bg-violet-500 text-white rounded hover:bg-violet-600 text-[9px] flex-none"
                  >
                    등록
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

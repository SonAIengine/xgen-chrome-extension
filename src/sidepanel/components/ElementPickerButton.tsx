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

      if (result && result.success && result.result) {
        const hasAuth = result.result.includes('auth_profile');
        setRegistered('done');
        if (!hasAuth) {
          setRegisterError('인증 프로필 없이 등록됨 — 인증 필요 시 로그인 후 재등록 필요');
        }
        // 1초 후 자동 닫기
        setTimeout(() => { setResult(null); setRegistered('idle'); setRegisterError(''); }, 1000);
      } else if (result && result.success === false) {
        const isAuthError = result.error?.includes('인증이 필요');
        if (isAuthError) {
          // 인증 필요 → AI에게 내부적으로 로그인 유도 메시지 전송 (채팅에 안 보임)
          setRegistered('error');
          setRegisterError('로그인 필요 — 채팅에서 안내를 따라주세요');
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

/** URL 경로에서 사람이 읽기 쉬운 한국어 기능명 생성 */
function describeApi(url: string, method: string): string {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { pathname = url; }

  // 경로 키워드 → 한국어 매핑
  const keywords: Record<string, string> = {
    basket: '장바구니', cart: '장바구니', order: '주문', checkout: '결제',
    search: '검색', goods: '상품', product: '상품', item: '상품',
    member: '회원', user: '사용자', profile: '프로필', account: '계정',
    login: '로그인', auth: '인증', register: '회원가입', signup: '가입',
    category: '카테고리', menu: '메뉴', navigation: '메뉴',
    review: '리뷰', comment: '댓글', board: '게시판', notice: '공지',
    coupon: '쿠폰', point: '포인트', event: '이벤트', promotion: '프로모션',
    delivery: '배송', shipping: '배송', address: '주소',
    payment: '결제', pay: '결제', refund: '환불',
    wish: '찜', favorite: '즐겨찾기', like: '좋아요',
    list: '목록', detail: '상세', info: '정보',
    recent: '최근', history: '이력', log: '기록',
    setting: '설정', config: '설정', preference: '환경설정',
    notification: '알림', message: '메시지',
    image: '이미지', file: '파일', upload: '업로드', download: '다운로드',
    stock: '재고', inventory: '재고', price: '가격',
    store: '매장', shop: '매장', brand: '브랜드',
  };

  const parts = pathname.toLowerCase().split('/').filter(Boolean);

  // 매칭된 키워드 수집
  const matched: string[] = [];
  for (const part of parts) {
    for (const [key, label] of Object.entries(keywords)) {
      if (part.includes(key) && !matched.includes(label)) {
        matched.push(label);
      }
    }
  }

  // 메서드 동사
  const verb = method === 'GET' ? '조회' : method === 'POST' ? '요청' : method === 'PUT' ? '수정' : method === 'DELETE' ? '삭제' : '호출';

  if (matched.length > 0) {
    return `${matched.join(' ')} ${verb}`;
  }

  // 매칭 없으면 마지막 경로 세그먼트를 camelCase/snake_case에서 분리
  const lastPart = parts[parts.length - 1] || '';
  if (lastPart) {
    const words = lastPart
      .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → 분리
      .replace(/[_-]/g, ' ')                  // snake_case, kebab-case → 분리
      .toLowerCase()
      .trim();

    // 분리된 단어에서 키워드 매칭 재시도
    for (const word of words.split(' ')) {
      for (const [key, label] of Object.entries(keywords)) {
        if (word.includes(key) && !matched.includes(label)) {
          matched.push(label);
        }
      }
    }
    if (matched.length > 0) {
      return `${matched.join(' ')} ${verb}`;
    }

    return `${words} ${verb}`;
  }

  return `기능 ${verb}`;
}

export function PickerResultPanel({ result, registered, registerError, registerApi, closeResult }: {
  result: PickerResult;
  registered: 'idle' | 'loading' | 'done' | 'error';
  registerError: string;
  registerApi: (api: CapturedApi) => void;
  closeResult: () => void;
}) {
  // 중복 URL 제거 (같은 URL+method는 하나만)
  const seen = new Set<string>();
  const filteredApis = result.apis.filter(a => {
    if (a.method === 'NAVIGATION') return false;
    const key = `${a.method}:${a.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <div className="border-b border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-gray-600">
          감지된 기능
        </span>
        <button onClick={closeResult} className="text-[10px] text-gray-400 hover:text-gray-600">
          닫기
        </button>
      </div>

      {registered === 'loading' && (
        <p className="text-[11px] text-violet-500">도구로 등록하는 중...</p>
      )}
      {registered === 'done' && (
        <p className="text-[11px] text-green-600">도구 등록 완료!</p>
      )}
      {registered === 'error' && (
        <p className="text-[11px] text-red-500">{registerError.includes('로그인') ? '로그인이 필요합니다' : '등록에 실패했습니다'}</p>
      )}

      {registered === 'idle' && (
        <>
          {result.elementInfo.text && (
            <div className="text-[11px] text-gray-500 mb-1.5">
              "{result.elementInfo.text.slice(0, 25)}" 클릭 시 호출된 기능:
            </div>
          )}

          {filteredApis.length === 0 ? (
            <p className="text-[11px] text-gray-400">
              감지된 기능이 없습니다.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {filteredApis.map((api) => {
                let shortPath: string;
                try {
                  const u = new URL(api.url);
                  const segs = u.pathname.split('/').filter(Boolean);
                  shortPath = '/' + segs.slice(-2).join('/');
                } catch { shortPath = api.url.slice(-30); }

                return (
                  <div key={api.id} className="flex items-center gap-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-gray-700 truncate">
                        {describeApi(api.url, api.method)}
                      </div>
                      <div className="text-[9px] text-gray-400 font-mono truncate">
                        {api.method} {shortPath}
                      </div>
                    </div>
                    <button
                      onClick={() => registerApi(api)}
                      className="px-2 py-1 bg-violet-500 text-white rounded hover:bg-violet-600 text-[10px] flex-none"
                    >
                      등록
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

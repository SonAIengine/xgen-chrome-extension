// 캡처 트레이스 → "도구 + 추정 엣지" 분석기.
// Phase 2: 시간순 + 값 흐름만 사용 (클릭 매핑은 Phase 3+에서 통합).

import type { CapturedApi } from '../../shared/api-hook-types';

// ── 출력 타입 ──

export interface AnalyzedTool {
  id: string;                                   // "GET:host/templated/path"
  method: string;
  host: string;
  templatedPath: string;                        // /products/{id}/info
  rawPaths: string[];                           // 묶인 원본 path 샘플 (debug/preview용)
  sampleCount: number;
  pathParams: string[];                         // ["id"]
  queryParamKeys: string[];                     // 관찰된 쿼리 키 합집합
  /** 캡처 시 본 query 값 — 호출 시 default로 사용 (enum/설정 값 자동 채움). 같은 키가
   *  여러 캡처에서 다른 값이면 첫 값만 보존. ID-like 동적 값도 같이 들어갈 수 있는데,
   *  그땐 호출 시 사용자가 popup에서 override. */
  querySample: Record<string, string>;
  requestBodySample?: unknown;                  // 첫 캡처 body (preview용)
  responseSample?: unknown;                     // 첫 캡처 response (preview용)
  label: string;                                // 사람이 읽는 한국어
  isLowPriority: boolean;                       // 빈 ack 등
}

export interface AnalyzedEdge {
  fromToolId: string;
  toToolId: string;
  source: 'observed';                           // Phase 2는 observed만. inferred(이름매칭)는 Phase 4 이후.
  confidence: number;                           // 같은 (from→to) 쌍에서 값 일치 관찰된 횟수
  sampleSharedValue: string;                    // 어떤 값이 흘렀는지 한 예시
}

export interface DroppedReason {
  reason: string;
  count: number;
}

export interface TraceAnalysis {
  primaryHost: string | null;
  tools: AnalyzedTool[];
  edges: AnalyzedEdge[];
  authCandidates: CapturedApi[];
  dropped: DroppedReason[];
  totalRaw: number;
  keptRaw: number;                              // dedup·노이즈 제거 후 트레이스에 남은 캡처 수
}

// ── 노이즈 패턴 ──

const ANALYTICS_HOST_PATTERNS = [
  /google-analytics\.com$/i, /googletagmanager\.com$/i, /doubleclick\.net$/i,
  /sentry\.io$/i, /sentry-cdn\.com$/i,
  /segment\.com$/i, /segment\.io$/i,
  /amplitude\.com$/i, /mixpanel\.com$/i,
  /hotjar\.com$/i, /clarity\.ms$/i,
  /datadoghq\.com$/i, /newrelic\.com$/i,
  /facebook\.com\/tr/i, /connect\.facebook\.net$/i,
  /tiktok\.com\/api\/v\d\/pixel/i,
  /branch\.io$/i, /braze\.com$/i,
  /optimizely\.com$/i, /launchdarkly\.com$/i,
];

const ANALYTICS_PATH_PATTERNS = [
  /\/(collect|track|beacon|event|pixel|telemetry|metrics|log)(\/|$|\?)/i,
];

const AUTH_PATH_PATTERNS = [
  /\/(login|logout|signin|signout|signup|register)(\/|$|\?)/i,
  /\/(auth|oauth|oidc|sso)(\/|$|\?)/i,
  /\/(token|tokens)(\/|$|\?)/i,
  /\/(session|sessions)(\/|$|\?)/i,
  /\/(refresh|verify)(\/|$|\?)/i,
];

const EMPTY_ACK_BODIES = new Set([
  '', '{}', 'null', 'true', 'false', '1', '0',
  '{"ok":true}', '{"success":true}', '{"status":"ok"}', '{"result":"ok"}',
]);

// ── 유틸 ──

function tryParseUrl(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

function isAnalyticsCall(url: URL): boolean {
  if (ANALYTICS_HOST_PATTERNS.some((p) => p.test(url.host))) return true;
  if (ANALYTICS_PATH_PATTERNS.some((p) => p.test(url.pathname))) return true;
  return false;
}

function isAuthCall(api: CapturedApi, url: URL): boolean {
  if (AUTH_PATH_PATTERNS.some((p) => p.test(url.pathname))) return true;
  // Set-Cookie 응답 + POST/PUT은 인증류일 가능성 높음
  const setCookie = api.responseHeaders?.['set-cookie'] || api.responseHeaders?.['Set-Cookie'];
  if (setCookie && (api.method === 'POST' || api.method === 'PUT')) {
    // body에 token-shape 단어 들어가면 더 확실
    const body = api.responseBody || '';
    if (/access_token|refresh_token|id_token|sessionToken|jwt/i.test(body)) return true;
    // path가 보통 사이트 진입 GET이 아닌 form submit POST면 후보
    if (/login|sign|auth|session/i.test(url.pathname)) return true;
  }
  return false;
}

function isEmptyAck(body: string | null): boolean {
  if (!body) return true;
  return EMPTY_ACK_BODIES.has(body.trim());
}

function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ── path 템플릿화 ──
// 같은 (method, host, segment 개수, 다른 segment 동일) 캡처가 2건+ → 차이 segment를 {paramN}으로
// 추가로 단일 캡처도 shape이 명확한 ID(2자리+ 숫자, UUID, hex+digit)면 공격적으로 치환.
const ID_LIKE = /^(\d+|[0-9a-f]{8,}|[0-9a-f-]{8,}-[0-9a-f-]{4,}-[0-9a-f-]{4,}-[0-9a-f-]{4,}-[0-9a-f-]{8,})$/i;
const HASH_LIKE = /^[a-z0-9_-]{8,}$/i;         // 영문+숫자 섞인 8자리+ (slug일 수도, ID일 수도)
const PURE_NUMERIC = /^\d{2,}$/;               // 단일 캡처에서도 자신있게 ID로 치환할 shape

function isIdLike(seg: string): boolean {
  if (ID_LIKE.test(seg)) return true;
  // 숫자가 섞여 있으면 ID 후보
  if (HASH_LIKE.test(seg) && /\d/.test(seg)) return true;
  return false;
}

// 단일 캡처라도 ID로 단정할 만한 shape인지. 변형 기반 templatize 못 잡은 케이스 보강용.
// "v1", "v2" 같은 버전 segment는 알파+숫자라 안 걸림. "abc-123" 같은 slug도 안 걸림 (보수적).
function isObviousId(seg: string): boolean {
  if (PURE_NUMERIC.test(seg)) return true;
  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  // 16+자리 hex (보통 hash)
  if (/^[0-9a-f]{16,}$/i.test(seg)) return true;
  return false;
}

function aggressiveTemplatize(
  templatedPath: string, existingParams: string[],
): { templatedPath: string; pathParams: string[] } {
  const segs = templatedPath.split('/').filter(Boolean);
  const params = [...existingParams];
  let nextIdx = existingParams.length;
  const out = segs.map((seg) => {
    if (seg.startsWith('{')) return seg;       // 이미 변수
    if (isObviousId(seg)) {
      const name = nextIdx === 0 ? 'id' : `id${nextIdx + 1}`;
      params.push(name);
      nextIdx++;
      return `{${name}}`;
    }
    return seg;
  });
  return { templatedPath: '/' + out.join('/'), pathParams: params };
}

function templatize(method: string, host: string, captures: CapturedApi[]): {
  templatedPath: string;
  pathParams: string[];
  members: CapturedApi[];
} {
  // 같은 segment 개수끼리만 묶음
  const segArr = captures.map((c) => {
    const u = tryParseUrl(c.url);
    return u ? u.pathname.split('/').filter(Boolean) : [];
  });

  if (captures.length === 0) return { templatedPath: '/', pathParams: [], members: [] };

  // 단일 캡처: 공격적 templatize만 적용 (변형 분석 불가)
  if (captures.length === 1) {
    const rawPath = segArr[0].length > 0 ? '/' + segArr[0].join('/') : '/';
    const aggro = aggressiveTemplatize(rawPath, []);
    return { templatedPath: aggro.templatedPath, pathParams: aggro.pathParams, members: captures };
  }

  const segCount = segArr[0].length;
  // 같은 segment 개수 캡처들 사이에서 각 위치별로 일치 여부 검사
  const templated: string[] = [];
  const pathParams: string[] = [];
  let paramIdx = 0;

  for (let i = 0; i < segCount; i++) {
    const segs = segArr.map((arr) => arr[i] ?? '');
    const unique = new Set(segs);
    if (unique.size === 1) {
      templated.push(segs[0]);
    } else {
      // 다양성 있음 — 모두 ID-like일 때만 템플릿화
      const allIdLike = segs.every((s) => isIdLike(s));
      if (allIdLike) {
        const paramName = paramIdx === 0 ? 'id' : `id${paramIdx + 1}`;
        templated.push(`{${paramName}}`);
        pathParams.push(paramName);
        paramIdx++;
      } else {
        // 혼재 — 첫 sample 사용 (이상적 처리는 호출자가 더 좁은 그룹으로 재분할)
        templated.push(segs[0]);
      }
    }
  }
  const variationPath = '/' + templated.join('/');
  // 변형으로 못 잡은 segment에 공격적 치환 한 번 더 적용 (예: 단일 매장 ID `/shop/273`)
  const aggro = aggressiveTemplatize(variationPath, pathParams);
  return { templatedPath: aggro.templatedPath, pathParams: aggro.pathParams, members: captures };
}

// ── 캡처 그룹화 → 도구 ──

function groupForTemplating(method: string, host: string, all: CapturedApi[]): CapturedApi[][] {
  // segment 개수 + 변하지 않는 segment 위치들의 값으로 그룹핑.
  // 1단계: segment 개수로 분할
  const bySegCount = new Map<string, CapturedApi[]>();
  for (const c of all) {
    const u = tryParseUrl(c.url);
    if (!u) continue;
    const segs = u.pathname.split('/').filter(Boolean);
    const key = `${segs.length}`;
    if (!bySegCount.has(key)) bySegCount.set(key, []);
    bySegCount.get(key)!.push(c);
  }
  // 2단계: 같은 segment 개수 안에서 "단어 segment" 위치의 값 같은 것끼리 묶음
  const groups: CapturedApi[][] = [];
  for (const arr of bySegCount.values()) {
    const segArr = arr.map((c) => tryParseUrl(c.url)!.pathname.split('/').filter(Boolean));
    const segCount = segArr[0]?.length ?? 0;
    // 단어 segment 위치 = 모든 캡처에서 ID-like가 아닌 위치
    const wordPositions: number[] = [];
    for (let i = 0; i < segCount; i++) {
      const allWords = segArr.every((s) => !isIdLike(s[i] ?? ''));
      if (allWords) wordPositions.push(i);
    }
    // 단어 segment 값으로 키 만들어 다시 묶음
    const sub = new Map<string, CapturedApi[]>();
    for (let k = 0; k < arr.length; k++) {
      const wordKey = wordPositions.map((p) => segArr[k][p] ?? '').join('|');
      if (!sub.has(wordKey)) sub.set(wordKey, []);
      sub.get(wordKey)!.push(arr[k]);
    }
    for (const g of sub.values()) groups.push(g);
  }
  return groups;
}

const KEYWORD_LABELS: Record<string, string> = {
  basket: '장바구니', cart: '장바구니', order: '주문', checkout: '결제',
  search: '검색', goods: '상품', product: '상품', item: '상품',
  member: '회원', user: '사용자', profile: '프로필', account: '계정',
  category: '카테고리', menu: '메뉴',
  review: '리뷰', comment: '댓글', board: '게시판', notice: '공지',
  coupon: '쿠폰', point: '포인트', event: '이벤트',
  delivery: '배송', shipping: '배송', address: '주소', payment: '결제',
  wish: '찜', favorite: '즐겨찾기', like: '좋아요',
  list: '목록', detail: '상세', info: '정보',
  recent: '최근', notification: '알림', message: '메시지',
  stock: '재고', price: '가격',
  // 보강 키워드 (실사용 캡처에서 자주 빠지던 것들)
  shop: '매장', store: '매장', brand: '브랜드',
  summary: '요약', represent: '대표', recommend: '추천',
  popup: '팝업', banner: '배너', section: '섹션',
  option: '옵션', spec: '스펙',
  cont: '콘텐츠', conts: '콘텐츠', content: '콘텐츠',
  qna: '문의', inquiry: '문의', faq: 'FAQ',
};

// 의미 없는 namespace/version segment — 라벨에서 제외
const NOISE_SEGMENTS = new Set([
  'api', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6',
  'rest', 'public', 'private', 'common', 'core',
  'adv', 'svc', 'service', 'app', 'web', 'mobile',
  'site', 'main', 'sub', 'ext',
]);

function splitCamelKebab(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchKeywords(token: string, matched: string[]): boolean {
  let added = false;
  for (const [k, v] of Object.entries(KEYWORD_LABELS)) {
    if (token.includes(k) && !matched.includes(v)) {
      matched.push(v);
      added = true;
    }
  }
  return added;
}

function describeTool(method: string, templatedPath: string): string {
  // {param} 제거 + noise segment 제거 → 의미 있는 segment만
  const segs = templatedPath
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .filter((s) => !s.startsWith('{'))
    .filter((s) => !NOISE_SEGMENTS.has(s));

  const matched: string[] = [];
  for (const s of segs) {
    // 1) 통째로 키워드 매칭 (`getBasket` → `basket` 매칭)
    const wholeMatched = matchKeywords(s, matched);
    // 2) 못 잡았으면 camelCase/kebab 분리 후 단어별로 매칭
    if (!wholeMatched) {
      for (const w of splitCamelKebab(s)) matchKeywords(w, matched);
    }
  }

  const verb = method === 'GET' ? '조회'
    : method === 'POST' ? '요청'
    : method === 'PUT' ? '수정'
    : method === 'DELETE' ? '삭제'
    : '호출';

  if (matched.length > 0) return `${matched.join(' ')} ${verb}`;

  // Fallback: 마지막 segment를 사람이 읽을 만하게 정리
  const last = segs[segs.length - 1] || '기능';
  const readable = splitCamelKebab(last).join(' ').trim() || last;
  return `${readable} ${verb}`;
}

// ── 폴링 감지 ──
// 같은 (method, full url) 3건 이상이 10초 윈도우 안에 있으면 1건만 남기고 drop
function dropPolling(captures: CapturedApi[]): { kept: CapturedApi[]; droppedCount: number } {
  const sorted = [...captures].sort((a, b) => a.timestamp - b.timestamp);
  const keepFlag = new Array(sorted.length).fill(true);
  const POLL_WINDOW_MS = 10_000;
  const POLL_THRESHOLD = 3;

  for (let i = 0; i < sorted.length; i++) {
    if (!keepFlag[i]) continue;
    const ref = sorted[i];
    let group: number[] = [i];
    for (let j = i + 1; j < sorted.length; j++) {
      if (!keepFlag[j]) continue;
      if (sorted[j].timestamp - ref.timestamp > POLL_WINDOW_MS) break;
      if (sorted[j].method === ref.method && sorted[j].url === ref.url) {
        group.push(j);
      }
    }
    if (group.length >= POLL_THRESHOLD) {
      // 첫 1건만 남기고 나머지 drop
      for (let k = 1; k < group.length; k++) keepFlag[group[k]] = false;
    }
  }
  const kept = sorted.filter((_, idx) => keepFlag[idx]);
  return { kept, droppedCount: sorted.length - kept.length };
}

// ── 값 흐름 엣지 추정 ──

function collectLeafValues(node: unknown, out: Set<string>): void {
  if (node == null) return;
  if (typeof node === 'string') {
    if (node.length >= 5) out.add(node);              // 너무 짧은 값(true, ok 등) 제외
    return;
  }
  if (typeof node === 'number') {
    if (node >= 100) out.add(String(node));           // 너무 작은 숫자 제외 (ID는 보통 큼)
    return;
  }
  if (Array.isArray(node)) { for (const x of node) collectLeafValues(x, out); return; }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) collectLeafValues(v, out);
  }
}

function valuesFromCaptureRequest(api: CapturedApi): Set<string> {
  const out = new Set<string>();
  const u = tryParseUrl(api.url);
  if (u) {
    // path segment + query
    for (const seg of u.pathname.split('/').filter(Boolean)) {
      if (seg.length >= 5 || /^\d{3,}$/.test(seg)) out.add(seg);
    }
    for (const v of u.searchParams.values()) {
      if (v.length >= 5 || /^\d{3,}$/.test(v)) out.add(v);
    }
  }
  collectLeafValues(safeJsonParse(api.requestBody), out);
  return out;
}

function valuesFromCaptureResponse(api: CapturedApi): Set<string> {
  const out = new Set<string>();
  collectLeafValues(safeJsonParse(api.responseBody), out);
  return out;
}

interface CaptureWithTool {
  capture: CapturedApi;
  toolId: string;
}

const EDGE_LOOKAHEAD_MS = 60_000;

function detectEdges(captures: CaptureWithTool[]): AnalyzedEdge[] {
  const sorted = [...captures].sort((a, b) => a.capture.timestamp - b.capture.timestamp);
  const edgeMap = new Map<string, AnalyzedEdge>();

  // 각 캡처 응답 값을 미리 계산
  const responseValues = sorted.map((c) => valuesFromCaptureResponse(c.capture));
  const requestValues = sorted.map((c) => valuesFromCaptureRequest(c.capture));

  for (let i = 0; i < sorted.length; i++) {
    const respVals = responseValues[i];
    if (respVals.size === 0) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].capture.timestamp - sorted[i].capture.timestamp > EDGE_LOOKAHEAD_MS) break;
      if (sorted[i].toolId === sorted[j].toolId) continue; // 자기 자신과의 엣지 스킵
      const reqVals = requestValues[j];
      let shared: string | null = null;
      for (const v of reqVals) {
        if (respVals.has(v)) { shared = v; break; }
      }
      if (!shared) continue;
      const key = `${sorted[i].toolId}=>${sorted[j].toolId}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.confidence++;
      } else {
        edgeMap.set(key, {
          fromToolId: sorted[i].toolId,
          toToolId: sorted[j].toolId,
          source: 'observed',
          confidence: 1,
          sampleSharedValue: shared,
        });
      }
    }
  }

  return [...edgeMap.values()];
}

// ── 메인 ──

export function analyzeTrace(captures: CapturedApi[]): TraceAnalysis {
  const totalRaw = captures.length;
  const dropped: DroppedReason[] = [];
  const addDrop = (reason: string, count: number) => {
    if (count <= 0) return;
    const existing = dropped.find((d) => d.reason === reason);
    if (existing) existing.count += count;
    else dropped.push({ reason, count });
  };

  // 1. NAVIGATION 제외
  let stage = captures.filter((c) => c.method !== 'NAVIGATION');
  addDrop('NAVIGATION 이벤트', captures.length - stage.length);

  // 2. URL 파싱 안 되는 캡처 제외
  const beforeUrlFilter = stage.length;
  stage = stage.filter((c) => tryParseUrl(c.url) !== null);
  addDrop('URL 파싱 실패', beforeUrlFilter - stage.length);

  // 3. 가장 많이 등장한 host를 primary로 선정
  const hostCount = new Map<string, number>();
  for (const c of stage) {
    const h = tryParseUrl(c.url)!.host;
    hostCount.set(h, (hostCount.get(h) ?? 0) + 1);
  }
  const primaryHost = [...hostCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // 4. 인증 호출 분리 (먼저 빼냄 — 아래 노이즈 필터에 안 걸리게)
  const authCandidates: CapturedApi[] = [];
  stage = stage.filter((c) => {
    const u = tryParseUrl(c.url)!;
    if (isAuthCall(c, u)) {
      authCandidates.push(c);
      return false;
    }
    return true;
  });

  // 5. analytics drop
  const beforeAnalytics = stage.length;
  stage = stage.filter((c) => !isAnalyticsCall(tryParseUrl(c.url)!));
  addDrop('analytics/tracking', beforeAnalytics - stage.length);

  // 6. cross-host drop (primary host 외)
  if (primaryHost) {
    const beforeCross = stage.length;
    stage = stage.filter((c) => tryParseUrl(c.url)!.host === primaryHost);
    addDrop(`다른 호스트 (primary=${primaryHost} 아님)`, beforeCross - stage.length);
  }

  // 7. 4xx/5xx drop
  const beforeStatus = stage.length;
  stage = stage.filter((c) => c.responseStatus < 400);
  addDrop('4xx/5xx 응답', beforeStatus - stage.length);

  // 8. 폴링 drop
  const polling = dropPolling(stage);
  stage = polling.kept;
  addDrop('폴링 패턴 (10초 내 동일 호출 3+회)', polling.droppedCount);

  // 9. (method, host) 단위로 묶고, 안에서 다시 path 템플릿화
  const byMethodHost = new Map<string, CapturedApi[]>();
  for (const c of stage) {
    const u = tryParseUrl(c.url)!;
    const k = `${c.method}|${u.host}`;
    if (!byMethodHost.has(k)) byMethodHost.set(k, []);
    byMethodHost.get(k)!.push(c);
  }

  const tools: AnalyzedTool[] = [];
  const captureToolMap: CaptureWithTool[] = [];

  for (const [k, arr] of byMethodHost.entries()) {
    const [method, host] = k.split('|');
    const groups = groupForTemplating(method, host, arr);
    for (const g of groups) {
      const { templatedPath, pathParams, members } = templatize(method, host, g);
      const toolId = `${method}:${host}${templatedPath}`;
      const queryKeys = new Set<string>();
      const querySample: Record<string, string> = {};
      for (const m of members) {
        const u = tryParseUrl(m.url)!;
        for (const key of u.searchParams.keys()) {
          queryKeys.add(key);
          // 첫 본 값을 default로 보존 (이미 있으면 유지).
          if (!(key in querySample)) {
            const v = u.searchParams.get(key);
            if (v !== null) querySample[key] = v;
          }
        }
      }
      const allEmpty = members.every((m) => isEmptyAck(m.responseBody));
      const first = members[0];
      tools.push({
        id: toolId,
        method,
        host,
        templatedPath,
        rawPaths: members.slice(0, 3).map((m) => tryParseUrl(m.url)!.pathname),
        sampleCount: members.length,
        pathParams,
        queryParamKeys: [...queryKeys],
        querySample,
        requestBodySample: safeJsonParse(first.requestBody),
        responseSample: safeJsonParse(first.responseBody),
        label: describeTool(method, templatedPath),
        isLowPriority: allEmpty,
      });
      for (const m of members) captureToolMap.push({ capture: m, toolId });
    }
  }

  // 10. Post-hoc dedup: 공격적 templatize 결과 두 그룹의 path가 같으면 하나로 병합
  const mergedTools: AnalyzedTool[] = [];
  const mergedById = new Map<string, AnalyzedTool>();
  const idRewrite = new Map<string, string>();        // 사라진 toolId → 살아남은 toolId
  for (const t of tools) {
    const existing = mergedById.get(t.id);
    if (existing) {
      existing.sampleCount += t.sampleCount;
      existing.rawPaths.push(...t.rawPaths.slice(0, 3));
      existing.queryParamKeys = [...new Set([...existing.queryParamKeys, ...t.queryParamKeys])];
      // querySample은 첫 본 값 우선 (existing이 먼저). 새로 추가된 키만 t에서 보충.
      for (const [k, v] of Object.entries(t.querySample)) {
        if (!(k in existing.querySample)) existing.querySample[k] = v;
      }
      existing.isLowPriority = existing.isLowPriority && t.isLowPriority;
      // 첫 본 sample이 비어 있으면 두 번째 sample로 보강
      if (existing.requestBodySample == null && t.requestBodySample != null) {
        existing.requestBodySample = t.requestBodySample;
      }
      if (existing.responseSample == null && t.responseSample != null) {
        existing.responseSample = t.responseSample;
      }
      idRewrite.set(t.id, existing.id);
    } else {
      mergedById.set(t.id, t);
      mergedTools.push(t);
    }
  }
  // captureToolMap의 toolId도 rewrite
  for (const ct of captureToolMap) {
    const newId = idRewrite.get(ct.toolId);
    if (newId) ct.toolId = newId;
  }

  // 11. 같은 라벨이 여러 도구에서 나오면 마지막 segment를 disambiguator로 추가
  const labelGroups = new Map<string, AnalyzedTool[]>();
  for (const t of mergedTools) {
    if (!labelGroups.has(t.label)) labelGroups.set(t.label, []);
    labelGroups.get(t.label)!.push(t);
  }
  for (const group of labelGroups.values()) {
    if (group.length <= 1) continue;
    for (const t of group) {
      // 마지막 non-template segment 추출
      const segs = t.templatedPath.split('/').filter(Boolean).filter((s) => !s.startsWith('{'));
      const last = segs[segs.length - 1];
      if (!last) continue;
      const readable = splitCamelKebab(last).join(' ').trim();
      // 이미 라벨에 들어간 단어면 스킵
      if (readable && !t.label.toLowerCase().includes(readable.toLowerCase())) {
        t.label = `${t.label} (${readable})`;
      }
    }
  }

  // 12. 값 흐름 엣지 (rewrite된 toolId 기준)
  const edges = detectEdges(captureToolMap);

  // 정렬: 낮은 우선순위(빈 ack)는 뒤로
  mergedTools.sort((a, b) => {
    if (a.isLowPriority !== b.isLowPriority) return a.isLowPriority ? 1 : -1;
    return b.sampleCount - a.sampleCount;
  });
  edges.sort((a, b) => b.confidence - a.confidence);

  return {
    primaryHost,
    tools: mergedTools,
    edges,
    authCandidates,
    dropped,
    totalRaw,
    keptRaw: stage.length,
  };
}

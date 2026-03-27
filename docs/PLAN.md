# XGEN Chrome Extension — Implementation Plan

## Overview

XGEN AI 어시스턴트를 Chrome Extension으로 구현.
데스크탑 앱(Tauri)의 AI CLI 기능을 브라우저에서 동일하게 제공한다.

백엔드는 xgen-workflow의 `/api/ai-chat/stream` 엔드포인트를 그대로 사용.

## 기존 구현 참고

### 데스크탑 앱 (Tauri) — 이미 동작 중
```
Tauri 앱
├── src-cli/cli.html          → Chrome Extension Side Panel UI로 변환
├── src-tauri/llm_client.rs   → 불필요 (백엔드 API가 LLM 호출)
├── src-tauri/tool_search.rs  → 불필요 (백엔드가 graph-tool-call 사용)
├── patch-canvas-chatbot.js   → Content Script의 canvas-bridge.ts로 변환
└── patch-sidebar-cli.js      → 불필요 (Extension 아이콘으로 접근)
```

### 웹 백엔드 (xgen-workflow feat/ai-chatbot) — 이미 구현됨
```
xgen-workflow/
├── controller/aiChatController.py   → POST /api/ai-chat/stream (SSE)
├── service/ai_chat/
│   ├── ai_chat_service.py           → LangGraph agent + gateway tools
│   └── canvas_tools.py              → canvas_* + navigate tools
└── controller/models/ai_chat.py     → AiChatRequest schema
```

## Design Decisions

### Side Panel vs Popup vs Content Script UI

| 방식 | 장점 | 단점 |
|------|------|------|
| **Side Panel** (선택) | XGEN 페이지와 나란히 표시, 지속적 | Chrome 114+ 필요 |
| Popup | 간단, 호환성 좋음 | 클릭하면 닫힘, 페이지와 동시에 안 보임 |
| Content Script UI | 페이지 내 임베딩 | XGEN CSS 충돌, 유지보수 어려움 |

**Side Panel 선택 이유**: 캔버스 편집하면서 AI 채팅을 동시에 볼 수 있어야 함.

### 캔버스 조작 방식

**데스크탑 앱**: Tauri IPC → canvasRef (같은 프로세스)
**Chrome Extension**: Content Script → XGEN 페이지의 canvasRef 접근

두 가지 방법:
1. **window 전역 변수 노출** — xgen-frontend 패치로 `window.__XGEN_CANVAS_REF__` 노출
2. **CustomEvent 브릿지** — Content Script ↔ XGEN 페이지 간 CustomEvent 통신

**2번 선택**: 프론트엔드 패치 최소화. Content Script가 CustomEvent를 발생시키면, xgen-frontend의 이벤트 핸들러가 canvasRef를 통해 실행.

```javascript
// Content Script → XGEN 페이지
window.dispatchEvent(new CustomEvent('xgen:canvas-command', {
    detail: { requestId, action: 'add_node', params: { node_type: 'agents/xgen' } }
}));

// XGEN 페이지 → Content Script
window.addEventListener('xgen:canvas-result', (e) => {
    const { requestId, result } = e.detail;
    // result를 background SW로 전달
});
```

이 이벤트 핸들러는 xgen-frontend의 `feat/ai-chatbot` 브랜치에서 캔버스 page.tsx에 추가하면 됨.
데스크탑 앱의 Tauri 이벤트(`canvas:command`)와 구조가 동일.

### 인증

XGEN 웹 페이지에 로그인하면 쿠키/localStorage에 access_token이 저장됨.
Content Script가 이 토큰을 읽어서 Background SW로 전달 → API 호출 시 Authorization 헤더에 포함.

```javascript
// Content Script
const token = localStorage.getItem('xgen_access_token')
    || document.cookie.match(/access_token=([^;]+)/)?.[1];
chrome.runtime.sendMessage({ type: 'SET_TOKEN', token });
```

## Implementation Phases

### Phase 1: MVP — 채팅 + API 호출 (Side Panel only)

**목표**: Side Panel에서 채팅, search_tools + call_tool 동작

파일:
```
manifest.json
src/background/service-worker.ts    — SSE 관리
src/sidepanel/index.html
src/sidepanel/App.tsx               — 채팅 UI (cli.html을 React로 변환)
src/sidepanel/hooks/useChat.ts      — 채팅 상태
src/sidepanel/hooks/useSSE.ts       — SSE 스트리밍 파싱
src/shared/types.ts
src/shared/api.ts                   — /api/ai-chat/stream 클라이언트
```

구현 순서:
1. manifest.json (side_panel, permissions)
2. Background service worker (SSE fetch + 메시지 라우팅)
3. Side Panel React 앱 (Vite + React)
4. 채팅 UI (cli.html 기반)
5. SSE 스트리밍 파싱 + 마크다운 렌더링
6. 인증 토큰 자동 추출

### Phase 2: Page Agent + 캔버스 조작 (Content Script)

**목표**: Content Script를 Page Agent로 확장하여 모든 XGEN 페이지의 컨텍스트를 인식하고 조작

#### 핵심 개념: Page Agent

기존 계획은 Content Script가 캔버스 조작만 담당했지만, **Page Agent**로 확장하면:
- AI가 사용자가 보고 있는 페이지를 자동 인식
- 페이지별 데이터(테이블, 폼, 상태)를 추출해 AI 컨텍스트에 포함
- 캔버스뿐 아니라 워크플로우 목록, 설정 페이지 등에서도 DOM 조작 가능

#### 설계 원칙

- **Canvas**: CustomEvent bridge 유지 (React canvasRef 필수)
- **그 외 페이지**: DOM 직접 쿼리 (프론트엔드 패치 불필요)
- **page_context**: canvas_state와 별도 필드로 API에 전달

#### PageHandler 인터페이스

```typescript
type PageType = 'canvas' | 'workflows' | 'chat' | 'admin'
  | 'data' | 'models' | 'ml-monitoring' | 'unknown';

interface PageContext {
  pageType: PageType;
  url: string;
  title: string;
  data: Record<string, any>;       // 페이지별 구조화 데이터
  availableActions: string[];       // 현재 페이지에서 가능한 액션들
  timestamp: number;
}

interface PageHandler {
  readonly pageType: PageType;
  matches(url: URL): boolean;
  extractContext(): PageContext;
  getAvailableActions(): string[];
  executeCommand(action: string, params: Record<string, any>): Promise<PageCommandResult>;
  observe(callback: (context: PageContext) => void): void;
  disconnect(): void;
}
```

#### 파일 구조

```
src/content/
├── index.ts                        — Entry point: TokenExtractor + PageAgent 초기화
├── token-extractor.ts              — 인증 토큰 추출
└── page-agent/
    ├── types.ts                    — PageHandler, PageContext, PageType
    ├── page-detector.ts            — URL → PageType 매핑 + SPA 네비게이션 감지
    ├── page-agent.ts               — 오케스트레이터 (감지→핸들러 선택→메시지 라우팅)
    ├── dom-utils.ts                — 공통 DOM 유틸 (테이블 추출, 폼 읽기 등)
    └── handlers/
        ├── index.ts                — 핸들러 레지스트리
        ├── canvas-handler.ts       — 캔버스 (CustomEvent bridge)
        ├── workflows-handler.ts    — 워크플로우 목록
        ├── data-handler.ts         — 데이터/문서 관리
        ├── admin-handler.ts        — 관리자 설정
        └── generic-handler.ts      — fallback (제목, 헤딩, 테이블 유무)
```

#### Step 1: Page Agent 코어 (2일)

- `types.ts` — PageHandler 인터페이스, PageContext, PageType 정의
- `page-detector.ts` — URL 파싱 → PageType 매핑
  - SPA 네비게이션 감지: MutationObserver(`document.title`) + URL 폴링(500ms)
  - XGEN은 Next.js SPA → isolated world에서 history.pushState 직접 인터셉트 불가
- `page-agent.ts` — 싱글턴 오케스트레이터
  - 페이지 감지 → 핸들러 선택 → observe 시작
  - `chrome.runtime.onMessage` 리슨 (GET_PAGE_CONTEXT, PAGE_COMMAND)
  - URL 변경 시 핸들러 교체, PAGE_CONTEXT_UPDATE 전송

#### Step 2: GenericHandler + CanvasHandler (2일)

- `generic-handler.ts` — 모든 페이지 fallback
  - extractContext: 페이지 제목, 보이는 헤딩들, 테이블 행 수
  - 액션: `navigate`만
- `canvas-handler.ts` — 기존 canvas-bridge 로직을 PageHandler로 래핑
  - CustomEvent 브릿지 유지 (`xgen:canvas-command` / `xgen:canvas-result`)
  - extractContext: CustomEvent로 `get_canvas_state` 호출 → nodes/edges
  - 액션: `add_node`, `remove_node`, `connect`, `disconnect`, `update_node_param`, `save`
- xgen-frontend에 CustomEvent 리스너 추가 (feat/ai-chatbot 브랜치)

#### Step 3: Background SW + Side Panel 통합 (2일)

- Background SW:
  - `GET_PAGE_CONTEXT` 메시지 핸들러 추가
  - AI 요청 전 Content Script에서 page_context 가져와서 API body에 포함
  - SSE `page_command` 이벤트 → Content Script로 라우팅
- Side Panel:
  - `useChat.ts`: 메시지 전송 전 page_context 요청 → 포함
  - `PageIndicator.tsx`: 채팅 헤더에 현재 페이지 타입 배지

#### Step 4: 추가 핸들러 (2일, Phase 3와 병행 가능)

- `workflows-handler.ts` — 워크플로우 테이블 추출, select/open/search 액션
- `data-handler.ts` — 문서/컬렉션 목록 추출
- `admin-handler.ts` — 관리자 설정 폼 읽기

#### Step 5: 백엔드 확장 — xgen-workflow (2일)

- `AiChatRequest`에 `page_context: Optional[dict]` 필드 추가 (하위호환)
- `page_tools.py` 생성 (canvas_tools.py와 동일 패턴):
  - `page_navigate(path)` — 페이지 이동
  - `page_click_element(selector)` — 요소 클릭
  - `page_fill_input(selector, value)` — 입력 필드 채우기
  - `page_search(query)` — 검색창 입력
- 시스템 프롬프트 확장: page_context + 페이지별 사용 가능 도구 안내

### Phase 3: UX 개선

- 마크다운 렌더링 개선
- 다크/라이트 모드
- 대화 히스토리 저장 (chrome.storage)
- 옵션 페이지 (서버 URL, 프로바이더, 모델)
- 키보드 단축키 (Ctrl+Shift+X로 Side Panel 토글)
- 현재 페이지에서 가능한 액션 제안 UI

### Phase 4: Chrome Web Store 배포

- 아이콘/스크린샷 제작
- Privacy policy
- Chrome Web Store 등록
- 자동 업데이트

## manifest.json 구조 (초안)

```json
{
  "manifest_version": 3,
  "name": "XGEN AI Assistant",
  "version": "0.1.0",
  "description": "자연어로 XGEN AI 플랫폼을 제어하는 AI 어시스턴트",
  "permissions": [
    "sidePanel",
    "storage",
    "activeTab",
    "scripting"
  ],
  "host_permissions": [
    "https://xgen.x2bee.com/*"
  ],
  "side_panel": {
    "default_path": "sidepanel/index.html"
  },
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://xgen.x2bee.com/*"],
      "js": ["content/index.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    },
    "default_title": "XGEN AI Assistant"
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

## 메시지 흐름 상세

```
Side Panel                Background SW              Content Script (PageAgent)  XGEN Page
    │                          │                          │                          │
    │── SEND_MESSAGE ─────────→│                          │                          │
    │                          │── GET_PAGE_CONTEXT ─────→│                          │
    │                          │                          │── extractContext() ──────→│
    │                          │                          │←─ DOM data ──────────────│
    │                          │←─ PageContext ───────────│                          │
    │                          │                          │                          │
    │                          │── POST /ai-chat/stream ─→ (백엔드)                  │
    │                          │   { messages, canvas_state, page_context }           │
    │                          │                          │                          │
    │←─ STREAM_TOKEN ──────────│←─ SSE: token             │                          │
    │←─ TOOL_START ────────────│←─ SSE: tool_start        │                          │
    │                          │                          │                          │
    │                          │←─ SSE: canvas_command    │                          │
    │                          │── CANVAS_COMMAND ────────→│                          │
    │                          │                          │── CustomEvent ──────────→│
    │                          │                          │←─ CustomEvent ───────────│
    │                          │←─ CANVAS_RESULT ─────────│                          │
    │                          │                          │                          │
    │                          │←─ SSE: page_command      │                          │
    │                          │── PAGE_COMMAND ──────────→│                          │
    │                          │                          │── DOM 조작 ─────────────→│
    │                          │←─ PAGE_COMMAND_RESULT ───│                          │
    │                          │                          │                          │
    │←─ STREAM_DONE ───────────│←─ SSE: done              │                          │
    │                          │                          │                          │
  [URL 변경 감지]               │                          │                          │
    │                          │←─ PAGE_CONTEXT_UPDATE ───│←─ SPA 네비게이션 ────────│
    │←─ PAGE_CHANGED ──────────│                          │                          │
```

## 예상 일정

| Phase | 기간 | 산출물 |
|-------|------|--------|
| Phase 1 (MVP) | 3-5일 | Side Panel 채팅 + API 호출 동작 |
| Phase 2 Step 1-2 (Page Agent 코어) | 4일 | PageAgent + CanvasHandler + GenericHandler |
| Phase 2 Step 3 (통합) | 2일 | Background SW/Side Panel에 page_context 통합 |
| Phase 2 Step 4 (추가 핸들러) | 2일 | Workflows/Data/Admin 핸들러 |
| Phase 2 Step 5 (백엔드) | 2일 | page_context API + page_tools |
| Phase 3 (UX) | 2-3일 | 히스토리, 옵션, 단축키, 액션 제안 |
| Phase 4 (배포) | 1-2일 | Chrome Web Store |

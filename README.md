# XGEN AI Assistant — Chrome Extension

브라우저에서 자연어로 XGEN AI 플랫폼을 제어하는 Chrome Extension.

## Overview

XGEN 웹 UI(`xgen.x2bee.com`)에서 사이드 패널로 AI 어시스턴트를 열고, 자연어로 워크플로우 관리, 캔버스 조작, 문서 인덱싱, API 호출 등을 수행한다.

데스크탑 앱([xgen_app](https://github.com/PlateerLab/xgen_app))의 AI CLI 기능을 브라우저에서 동일하게 제공.

## Features

- **자연어 API 제어** — "워크플로우 목록 보여줘", "LLM 상태 확인해줘"
- **캔버스 조작** — "노드 추가해줘", "연결해줘", "파라미터 바꿔줘"
- **페이지 인식** — AI가 현재 보고 있는 페이지를 자동 감지, 컨텍스트 반영
- **페이지 조작** — 워크플로우 선택, 검색, 설정 변경 등 DOM 조작
- **문서 인덱싱** — 파일 드래그앤드롭 → 컬렉션 선택 → 인덱싱
- **페이지 이동** — "캔버스 열어줘", "관리자 페이지 가줘"
- **실시간 스트리밍** — SSE 기반 LLM 응답 + 마크다운 렌더링
- **tool result 압축** — 대용량 API 응답 자동 압축 (graph-tool-call v0.19.1)
- **다크/라이트 모드** — 시스템 설정 따라감

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Chrome Browser                                      │
│                                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐  │
│  │  XGEN 웹 페이지       │  │  Extension Side      │  │
│  │  (xgen.x2bee.com)    │  │  Panel                │  │
│  │                      │  │                       │  │
│  │  캔버스 / 워크플로우  │←→│  AI 채팅 UI           │  │
│  │  페이지               │  │  (팝업 or 사이드패널)  │  │
│  └──────────────────────┘  └───────────┬───────────┘  │
│                                        │              │
│  ┌─────────────────────────────────────┘              │
│  │  Background Service Worker                         │
│  │  - SSE 스트리밍 관리                                │
│  │  - 인증 토큰 관리                                   │
│  │  - canvas_command 브릿지                            │
│  └────────────────────────┬──────────────────────────┘│
└───────────────────────────┼──────────────────────────┘
                            │ HTTPS
              ┌─────────────┴─────────────┐
              │  xgen-backend-gateway      │
              │  /api/ai-chat/stream       │
              └─────────────┬─────────────┘
                            │
              ┌─────────────┴─────────────┐
              │  xgen-workflow             │
              │  graph-tool-call + agent   │
              └───────────────────────────┘
```

### 통신 흐름

```
1. 사용자 입력 → Side Panel UI
2. Side Panel → Background SW → Content Script에서 page_context 수집
3. Background SW → POST /api/ai-chat/stream (SSE) { messages, canvas_state, page_context }
4. 백엔드 응답:
   - type: "token"          → Side Panel에 스트리밍 텍스트
   - type: "tool_start"     → 도구 호출 표시
   - type: "canvas_command" → Content Script → CustomEvent → 캔버스 조작
   - type: "page_command"   → Content Script → DOM 조작 (클릭, 입력, 검색 등)
   - type: "done"           → 완료
5. Page Agent: URL 변경 감지 → 핸들러 교체 → page_context 자동 업데이트
```

## Tech Stack

- **Manifest V3** — Chrome Extension 최신 표준
- **TypeScript** — 타입 안전성
- **React** (Side Panel) — 채팅 UI
- **Vite** — 빌드 도구
- **Tailwind CSS** — 스타일링

## Project Structure

```
xgen-chrome-extension/
├── manifest.json              # Extension manifest v3
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── background/
│   │   └── service-worker.ts  # SSE 관리, 메시지 라우팅
│   ├── sidepanel/
│   │   ├── index.html
│   │   ├── App.tsx            # 채팅 UI 메인
│   │   ├── components/
│   │   │   ├── ChatMessage.tsx
│   │   │   ├── ToolCallBadge.tsx
│   │   │   ├── MarkdownRenderer.tsx
│   │   │   └── InputArea.tsx
│   │   └── hooks/
│   │       ├── useChat.ts     # 채팅 상태 관리
│   │       └── useSSE.ts      # SSE 스트리밍
│   ├── content/
│   │   ├── index.ts           # Content script entry point
│   │   ├── token-extractor.ts # 인증 토큰 추출
│   │   └── page-agent/        # Page Agent — 페이지 인식 + DOM 조작
│   │       ├── types.ts       # PageHandler, PageContext 인터페이스
│   │       ├── page-detector.ts # URL → PageType 매핑 + SPA 감지
│   │       ├── page-agent.ts  # 오케스트레이터
│   │       ├── dom-utils.ts   # 공통 DOM 유틸리티
│   │       └── handlers/      # 페이지별 핸들러
│   │           ├── canvas-handler.ts    # 캔버스 (CustomEvent bridge)
│   │           ├── workflows-handler.ts # 워크플로우 목록
│   │           ├── data-handler.ts      # 데이터/문서
│   │           ├── admin-handler.ts     # 관리자 설정
│   │           └── generic-handler.ts   # fallback
│   ├── shared/
│   │   ├── types.ts           # 공통 타입
│   │   ├── api.ts             # API 클라이언트
│   │   └── constants.ts       # 설정
│   └── assets/
│       └── icons/             # 확장 아이콘
├── public/
│   └── icons/                 # 128x128, 48x48, 16x16
└── docs/
    └── PLAN.md
```

## Related Projects

| 프로젝트 | 역할 | 참고 |
|---------|------|------|
| [xgen_app](https://github.com/PlateerLab/xgen_app) | Tauri 데스크탑 앱 (AI CLI 원본 구현) | `src-cli/cli.html`, `src-tauri/src/services/llm_client.rs` |
| [xgen-workflow](https://gitlab.x2bee.com/xgen2.0/xgen-workflow) `feat/ai-chatbot` | 백엔드 AI 챗봇 API (`/api/ai-chat/stream`) | `service/ai_chat/`, `controller/aiChatController.py` |
| [xgen-frontend](https://gitlab.x2bee.com/xgen2.0/xgen-frontend) `feat/ai-chatbot` | 캔버스 canvas_command 핸들러 | `src/app/canvas/page.tsx` |
| [graph-tool-call](https://github.com/SonAIengine/graph-tool-call) | API 검색/실행 엔진 + tool result 압축 | `create_gateway_tools(compress_results=True)` |

### 참고 코드

**AI 챗봇 백엔드 API** (`xgen-workflow/controller/aiChatController.py`):
```python
@router.post("/stream")
async def ai_chat_stream(request: Request, body: AiChatRequest):
    # SSE 스트리밍 — 이 엔드포인트를 Chrome Extension에서 호출
    return StreamingResponse(
        service.chat_stream(messages, provider, model, canvas_state),
        media_type="text/event-stream",
    )
```

**SSE 이벤트 타입** (백엔드 → Extension):
```json
{"type": "token", "content": "워크플로우 목록을..."}
{"type": "tool_start", "tool": "search_tools", "input": "..."}
{"type": "tool_end", "tool": "call_tool", "output": "..."}
{"type": "canvas_command", "action": "add_node", "params": {...}}
{"type": "done"}
{"type": "error", "content": "..."}
```

**AiChatRequest 스키마**:
```json
{
  "messages": [{"role": "user", "content": "워크플로우 목록 보여줘"}],
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "canvas_state": {"nodes": [...], "edges": [...]}
}
```

**캔버스 조작 (Content Script에서 구현 필요)**:
- 데스크탑 앱: Tauri IPC 이벤트 (`canvas:command` → `canvas:result`)
- Chrome Extension: Content Script가 XGEN 페이지의 React 컴포넌트에 접근
- `canvasRef`는 `window.__XGEN_CANVAS_REF__`로 노출하거나, DOM 이벤트 기반으로 브릿지

## Installation (개발)

```bash
git clone https://github.com/SonAIengine/xgen-chrome-extension.git
cd xgen-chrome-extension
npm install
npm run dev
# chrome://extensions → Load unpacked → dist/
```

## Configuration

Extension 옵션 페이지에서 설정:
- **XGEN Server URL**: `https://xgen.x2bee.com` (기본)
- **LLM Provider**: anthropic / openai / google (기본: anthropic)
- **Model**: claude-sonnet-4-20250514 (기본)

인증 토큰은 XGEN 웹 페이지의 쿠키/localStorage에서 자동 추출.

## License

MIT

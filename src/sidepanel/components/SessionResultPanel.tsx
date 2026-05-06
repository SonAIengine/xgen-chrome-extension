import { useMemo, useState } from 'react';
import type { SessionResult } from '../hooks/useCaptureSession';
import { analyzeTrace, type AnalyzedTool, type AnalyzedEdge } from '../lib/trace-analyzer';
import { createCollectionFromTrace } from '../../shared/api';
import type { ExtensionMessage } from '../../shared/types';

interface Props {
  result: SessionResult;
  onDismiss: () => void;
}

type RegisterState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; collectionId: string; toolCount: number }
  | { status: 'conflict'; collectionId: string; message: string }
  | { status: 'error'; message: string };

function methodColor(m: string): string {
  return m === 'GET' ? 'text-blue-600'
    : m === 'POST' ? 'text-green-600'
    : m === 'PUT' ? 'text-yellow-600'
    : m === 'DELETE' ? 'text-red-600'
    : 'text-gray-600';
}

function ToolRow({
  tool, edgesFrom, toolsById, checked, onToggle,
}: {
  tool: AnalyzedTool;
  edgesFrom: AnalyzedEdge[];
  toolsById: Map<string, AnalyzedTool>;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-start gap-1.5 cursor-pointer hover:bg-white px-1 py-1 rounded">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="flex-none mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-gray-800 truncate">
          {tool.label}
          {tool.isLowPriority && <span className="ml-1 text-[9px] text-gray-400">(빈 응답)</span>}
        </div>
        <div className="text-[9px] text-gray-500 font-mono truncate">
          <span className={methodColor(tool.method)}>{tool.method}</span> {tool.templatedPath}
          {tool.sampleCount > 1 && <span className="ml-1 text-gray-400">×{tool.sampleCount}</span>}
        </div>
        {edgesFrom.length > 0 && (
          <div className="text-[9px] text-violet-600 mt-0.5 truncate">
            → 보통 다음으로:{' '}
            {edgesFrom
              .slice(0, 3)
              .map((e) => toolsById.get(e.toToolId)?.label || e.toToolId)
              .join(', ')}
          </div>
        )}
      </div>
    </label>
  );
}

export function SessionResultPanel({ result, onDismiss }: Props) {
  const analysis = useMemo(() => analyzeTrace(result.apis), [result.apis]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(analysis.tools.filter((t) => !t.isLowPriority).map((t) => t.id)),
  );
  const [showDropped, setShowDropped] = useState(false);
  const [registerState, setRegisterState] = useState<RegisterState>({ status: 'idle' });

  const handleRegister = async () => {
    if (!analysis.primaryHost) {
      setRegisterState({ status: 'error', message: 'host를 식별할 수 없어 등록할 수 없습니다.' });
      return;
    }
    setRegisterState({ status: 'loading' });
    try {
      const config = await chrome.runtime.sendMessage({
        type: 'GET_CHAT_CONFIG',
      } satisfies ExtensionMessage);
      if (!config?.serverUrl) {
        setRegisterState({ status: 'error', message: 'XGEN 서버 URL이 설정되지 않았습니다.' });
        return;
      }
      const selectedTools = analysis.tools.filter((t) => selected.has(t.id));
      const selectedEdges = analysis.edges.filter(
        (e) => selected.has(e.fromToolId) && selected.has(e.toToolId),
      );

      // 캡처 도중 자동 등록된 인증 프로필을 collection 등록 시 같이 넘긴다 — 그래야
      // 백엔드가 collection.auth_profile_id를 통해 모든 tool row에 자동 propagate.
      // 이게 빠지면 collection은 만들어져도 tool들의 auth_profile_id가 비어 호출 시 401.
      let authProfileId: string | undefined;
      try {
        const lookup = await chrome.runtime.sendMessage({
          type: 'LOOKUP_AUTH_PROFILE_FOR_HOST',
          host: analysis.primaryHost,
        } satisfies ExtensionMessage);
        if (lookup?.ok && typeof lookup.authProfileId === 'string') {
          authProfileId = lookup.authProfileId;
        }
      } catch (err) {
        console.warn('[SessionResultPanel] auth profile lookup failed:', err);
      }

      const res = await createCollectionFromTrace(config.serverUrl, config.authToken, {
        host: analysis.primaryHost,
        tools: selectedTools.map((t) => ({
          method: t.method,
          templatedPath: t.templatedPath,
          pathParams: t.pathParams,
          queryParamKeys: t.queryParamKeys,
          querySample: t.querySample,
          requestBodySample: t.requestBodySample,
          responseSample: t.responseSample,
          label: t.label,
          sampleCount: t.sampleCount,
        })),
        edges: selectedEdges.map((e) => ({
          fromToolId: e.fromToolId,
          toToolId: e.toToolId,
          confidence: e.confidence,
          sampleSharedValue: e.sampleSharedValue,
        })),
        ...(authProfileId ? { authProfileId } : {}),
      });
      if (res.status === 409) {
        setRegisterState({
          status: 'conflict',
          collectionId: res.collectionId,
          message: res.message,
        });
      } else {
        const col = res.collection as Record<string, unknown>;
        setRegisterState({
          status: 'success',
          collectionId: String(col.collection_id ?? ''),
          toolCount: Number(col.tool_count ?? selectedTools.length),
        });
      }
    } catch (err) {
      setRegisterState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const toolsById = useMemo(() => {
    const m = new Map<string, AnalyzedTool>();
    for (const t of analysis.tools) m.set(t.id, t);
    return m;
  }, [analysis.tools]);

  const edgesByFrom = useMemo(() => {
    const m = new Map<string, AnalyzedEdge[]>();
    for (const e of analysis.edges) {
      if (!m.has(e.fromToolId)) m.set(e.fromToolId, []);
      m.get(e.fromToolId)!.push(e);
    }
    return m;
  }, [analysis.edges]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === analysis.tools.length) setSelected(new Set());
    else setSelected(new Set(analysis.tools.map((t) => t.id)));
  };

  const totalDropped = analysis.dropped.reduce((s, d) => s + d.count, 0);

  return (
    <div className="border-b border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-gray-700">
          캡처 분석 — {analysis.primaryHost ?? '(host 미상)'}
        </span>
        <button
          onClick={onDismiss}
          className="text-[10px] text-gray-400 hover:text-gray-600"
        >
          닫기
        </button>
      </div>

      <div className="text-[10px] text-gray-500 mb-2">
        원본 {analysis.totalRaw}건 · 노이즈 제거 {totalDropped}건 ·
        도구 {analysis.tools.length}개 · 추정 관계 {analysis.edges.length}개
        {analysis.authCandidates.length > 0 && ` · 인증 후보 ${analysis.authCandidates.length}건`}
      </div>

      {/* 도구 목록 */}
      {analysis.tools.length > 0 ? (
        <>
          <div className="flex items-center justify-between mb-1 text-[11px]">
            <span className="font-medium text-gray-600">도구</span>
            <button
              onClick={toggleAll}
              className="text-violet-600 hover:text-violet-700"
            >
              {selected.size === analysis.tools.length ? '전체 해제' : '전체 선택'}
            </button>
          </div>
          <div className="space-y-0.5 max-h-56 overflow-y-auto bg-white rounded border border-gray-200 p-1">
            {analysis.tools.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                edgesFrom={edgesByFrom.get(tool.id) ?? []}
                toolsById={toolsById}
                checked={selected.has(tool.id)}
                onToggle={() => toggle(tool.id)}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="text-[11px] text-gray-400 py-2">
          분석할 도구가 없습니다. 페이지에서 액션(검색·클릭 등)을 수행한 뒤 종료해 주세요.
        </p>
      )}

      {/* 인증 후보 */}
      {analysis.authCandidates.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200">
          <div className="text-[11px] font-medium text-amber-700 mb-1">
            인증 호출 후보 ({analysis.authCandidates.length}건)
          </div>
          <div className="text-[10px] text-gray-500 mb-1">
            로그인/세션 관련 호출입니다. 컬렉션에는 안 들어가고, 인증 프로필 등록에 쓰입니다 (Phase 4).
          </div>
          <div className="text-[10px] text-gray-600 font-mono space-y-0.5 max-h-24 overflow-y-auto">
            {analysis.authCandidates.slice(0, 5).map((a) => (
              <div key={a.id} className="truncate">
                <span className={methodColor(a.method)}>{a.method}</span>{' '}
                {(() => { try { return new URL(a.url).pathname; } catch { return a.url; } })()}
              </div>
            ))}
            {analysis.authCandidates.length > 5 && (
              <div className="text-gray-400">...외 {analysis.authCandidates.length - 5}건</div>
            )}
          </div>
        </div>
      )}

      {/* 노이즈 제거 내역 (접힘) */}
      {totalDropped > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200">
          <button
            onClick={() => setShowDropped(!showDropped)}
            className="text-[10px] text-gray-500 hover:text-gray-700"
          >
            노이즈 제거 내역 {showDropped ? '▾' : '▸'}
          </button>
          {showDropped && (
            <div className="text-[10px] text-gray-500 mt-1 space-y-0.5">
              {analysis.dropped.map((d) => (
                <div key={d.reason}>· {d.reason}: {d.count}건</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 등록 상태 */}
      {registerState.status === 'success' && (
        <div className="mt-2 px-2 py-1.5 bg-green-50 border border-green-200 rounded text-[11px] text-green-700">
          ✓ 컬렉션 등록 완료: <span className="font-mono">{registerState.collectionId}</span>
          {' '}({registerState.toolCount}개 도구)
        </div>
      )}
      {registerState.status === 'conflict' && (
        <div className="mt-2 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-700">
          이 host는 이미 <span className="font-mono">{registerState.collectionId}</span> 컬렉션으로 등록돼 있어요.
          머지 기능(Phase 4)이 추가되기 전까지는 기존 컬렉션을 삭제 후 재등록해 주세요.
        </div>
      )}
      {registerState.status === 'error' && (
        <div className="mt-2 px-2 py-1.5 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">
          등록 실패: {registerState.message}
        </div>
      )}

      {/* 액션 */}
      <div className="mt-3 flex items-center justify-end gap-1.5">
        <span className="text-[10px] text-gray-500 mr-auto">
          {selected.size}/{analysis.tools.length} 선택
        </span>
        <button
          onClick={onDismiss}
          className="text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1"
        >
          {registerState.status === 'success' ? '닫기' : '취소'}
        </button>
        <button
          disabled={
            selected.size === 0 ||
            registerState.status === 'loading' ||
            registerState.status === 'success'
          }
          onClick={handleRegister}
          className="text-[11px] px-2 py-1 bg-violet-500 text-white rounded hover:bg-violet-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {registerState.status === 'loading' ? '등록 중...' : '컬렉션으로 등록'}
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { GATHERING_TOPICS, type WorkflowGatheringContext, type WorkflowSpec } from '../../shared/workflow-types';

// ── 수집 진행 표시 바 ──

export function WorkflowGatheringProgress({
  context,
  onCancel,
}: {
  context: WorkflowGatheringContext;
  onCancel: () => void;
}) {
  const total = GATHERING_TOPICS.length;
  const current = Math.min(context.topicIndex, total - 1);
  const currentLabel = GATHERING_TOPICS[current]?.label ?? '완료';

  return (
    <div className="border-b border-blue-200 bg-blue-50 px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-medium text-blue-700">
          워크플로우 생성 중 — {current + 1}/{total}: {currentLabel}
        </span>
        <div className="flex items-center gap-2">
          {context.capturedApis.length > 0 && (
            <span className="text-[10px] text-blue-500">
              API {context.capturedApis.length}개 캡처
            </span>
          )}
          <button
            onClick={onCancel}
            className="text-[10px] text-blue-400 hover:text-blue-600"
          >
            취소
          </button>
        </div>
      </div>

      {/* 주제별 진행 도트 */}
      <div className="flex gap-1">
        {GATHERING_TOPICS.map((topic, i) => (
          <div
            key={topic.key}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i < context.topicIndex
                ? 'bg-blue-500'
                : i === context.topicIndex
                  ? 'bg-blue-300 animate-pulse'
                  : 'bg-blue-100'
            }`}
            title={topic.label}
          />
        ))}
      </div>
    </div>
  );
}

// ── 결과 표시 패널 ──

const TYPE_BADGES: Record<string, string> = {
  api_call: 'bg-green-100 text-green-700',
  web_automation: 'bg-purple-100 text-purple-700',
  document_analysis: 'bg-yellow-100 text-yellow-700',
  llm_processing: 'bg-blue-100 text-blue-700',
  file_operation: 'bg-orange-100 text-orange-700',
  notification: 'bg-pink-100 text-pink-700',
};

async function getServerUrl(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get('XGEN_SERVER_URL', (data) => {
      resolve(data.XGEN_SERVER_URL || 'https://xgen.x2bee.com');
    });
  });
}

async function getAuthToken(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get('XGEN_AUTH_TOKEN', (data) => {
      resolve(data.XGEN_AUTH_TOKEN || '');
    });
  });
}

export function WorkflowResultPanel({
  spec,
  onClose,
}: {
  spec: WorkflowSpec;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [converting, setConverting] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [convertResult, setConvertResult] = useState<{
    message: string;
    analysis?: { missing: string[]; node_mapping: { step: string; node: string; type: string }[] };
  } | null>(null);

  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(spec, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const convertToWorkflow = async (endpoint: string = '/api/workflow/generate-from-spec') => {
    setConverting('loading');
    try {
      const serverUrl = await getServerUrl();
      const token = await getAuthToken();

      const response = await fetch(`${serverUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(spec),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        setConverting('done');
        setConvertResult({
          message: data.message,
          analysis: data.analysis,
        });
      } else {
        throw new Error(data.message || '변환 실패');
      }
    } catch (err) {
      setConverting('error');
      setConvertResult({
        message: err instanceof Error ? err.message : '알 수 없는 오류',
      });
    }
  };

  return (
    <div className="border-b border-green-200 bg-green-50 px-3 py-2">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-1.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[11px] font-medium text-green-700 hover:text-green-900"
        >
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
          {spec.workflow_name || '워크플로우'}
        </button>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => convertToWorkflow('/api/workflow/generate-from-spec')}
            disabled={converting === 'loading' || converting === 'done'}
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              converting === 'done'
                ? 'bg-green-500 text-white'
                : converting === 'loading'
                  ? 'bg-gray-300 text-gray-500 animate-pulse'
                  : 'bg-gray-500 text-white hover:bg-gray-600'
            }`}
            title="규칙 기반 즉시 변환 (빠름)"
          >
            {converting === 'loading' ? '변환 중...' : converting === 'done' ? '완료' : '빠른 변환'}
          </button>
          <button
            onClick={() => convertToWorkflow('/api/workflow/generate-from-spec-ai')}
            disabled={converting === 'loading' || converting === 'done'}
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              converting === 'done'
                ? 'bg-green-500 text-white'
                : converting === 'loading'
                  ? 'bg-blue-300 text-blue-700 animate-pulse'
                  : converting === 'error'
                    ? 'bg-red-200 text-red-700 hover:bg-red-300'
                    : 'bg-blue-500 text-white hover:bg-blue-600'
            }`}
            title="LLM 기반 AI 최적화 (멀티에이전트 지원)"
          >
            {converting === 'loading' ? '생성 중...' : converting === 'done' ? '완료' : 'AI 최적화'}
          </button>
          <button
            onClick={copyJson}
            className="text-[10px] px-1.5 py-0.5 rounded bg-green-200 text-green-700 hover:bg-green-300"
          >
            {copied ? '복사됨' : 'JSON 복사'}
          </button>
          <button
            onClick={onClose}
            className="text-[10px] text-green-400 hover:text-green-600"
          >
            닫기
          </button>
        </div>
      </div>

      {/* 변환 결과 */}
      {convertResult && (
        <div className={`text-[10px] mb-1.5 px-2 py-1 rounded ${
          converting === 'done' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
        }`}>
          <p>{convertResult.message}</p>
          {convertResult.analysis?.missing && convertResult.analysis.missing.length > 0 && (
            <div className="mt-1">
              <p className="font-medium">확인 필요:</p>
              {convertResult.analysis.missing.map((m, i) => (
                <p key={i} className="ml-2">• {m}</p>
              ))}
            </div>
          )}
          {convertResult.analysis?.node_mapping && (
            <div className="mt-1">
              <p className="font-medium">노드 매핑:</p>
              {convertResult.analysis.node_mapping.map((m, i) => (
                <p key={i} className="ml-2 font-mono">• {m.step} → {m.type}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="space-y-2 text-[10px]">
          {/* 목표 */}
          <p className="text-green-600">{spec.goal}</p>

          {/* 단계 */}
          {spec.steps.length > 0 && (
            <div>
              <p className="text-[9px] font-medium text-green-500 mb-0.5">단계</p>
              <div className="space-y-0.5">
                {spec.steps.map((step) => (
                  <div key={step.order} className="flex items-center gap-1">
                    <span className="text-green-400 w-3 text-right">{step.order}.</span>
                    <span
                      className={`px-1 py-0.5 rounded text-[9px] font-mono ${
                        TYPE_BADGES[step.type] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {step.type}
                    </span>
                    <span className="text-green-700 truncate">{step.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 캡처된 API */}
          {spec.captured_apis.length > 0 && (
            <div>
              <p className="text-[9px] font-medium text-green-500 mb-0.5">
                캡처된 API ({spec.captured_apis.length})
              </p>
              <div className="space-y-0.5">
                {spec.captured_apis.map((api, i) => (
                  <div key={i} className="flex items-center gap-1 font-mono text-green-600">
                    <span className="font-bold">{api.method}</span>
                    <span className="truncate">{api.url}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 트리거 */}
          <div className="flex gap-2 text-green-600">
            <span>실행: {spec.trigger.type}</span>
            {spec.trigger.detail && <span>({spec.trigger.detail})</span>}
          </div>
        </div>
      )}
    </div>
  );
}

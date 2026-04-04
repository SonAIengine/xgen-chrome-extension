// ── 워크플로우 요구사항 수집 타입 ──

export type GatheringTopic =
  | 'goal'
  | 'data_sources'
  | 'steps'
  | 'outputs'
  | 'trigger'
  | 'auth'
  | 'error_handling';

export const GATHERING_TOPICS: { key: GatheringTopic; label: string }[] = [
  { key: 'goal', label: '목표/목적' },
  { key: 'data_sources', label: '데이터 소스' },
  { key: 'steps', label: '처리 단계' },
  { key: 'outputs', label: '출력 형태' },
  { key: 'trigger', label: '실행 조건' },
  { key: 'auth', label: '인증/접근' },
  { key: 'error_handling', label: '에러 처리' },
];

export interface GatheredInfo {
  topic: GatheringTopic;
  summary: string;
}

export interface CapturedApiSummary {
  url: string;
  method: string;
  status: number;
}

export interface WorkflowGatheringContext {
  active: boolean;
  topicIndex: number;
  gathered: GatheredInfo[];
  capturedApis: CapturedApiSummary[];
}

export interface WorkflowSpec {
  workflow_name: string;
  goal: string;
  trigger: { type: string; detail: string };
  steps: {
    order: number;
    name: string;
    type: string;
    description: string;
    api?: { url: string; method: string; auth_profile_id?: string };
    input_from?: string;
    output_name?: string;
  }[];
  data_sources: { type: string; detail: string }[];
  outputs: { type: string; destination: string; format: string }[];
  captured_apis: { url: string; method: string; description: string }[];
  auth_profiles_needed: string[];
  error_handling: string;
  constraints: string[];
}

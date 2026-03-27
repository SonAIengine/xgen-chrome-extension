import type { PageContext } from '../../shared/types';

interface Props {
  pageContext: PageContext | null;
}

const PAGE_LABELS: Record<string, string> = {
  canvas: 'Canvas',
  workflows: 'Workflows',
  chat: 'Chat',
  admin: 'Admin',
  data: 'Data',
  models: 'Models',
  'ml-monitoring': 'ML Monitoring',
  unknown: 'Page',
};

export function PageIndicator({ pageContext }: Props) {
  if (!pageContext) return null;

  const label = PAGE_LABELS[pageContext.pageType] ?? pageContext.pageType;

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      {label}
    </span>
  );
}

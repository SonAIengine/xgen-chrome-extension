import type { PageHandler } from '../types';
import { CanvasHandler } from './canvas-handler';
import { WorkflowsHandler } from './workflows-handler';
import { DataHandler } from './data-handler';
import { AdminHandler } from './admin-handler';
import { GenericHandler } from './generic-handler';

// Order matters: first match wins, GenericHandler is always last (fallback)
export function createHandlerRegistry(): PageHandler[] {
  return [
    new CanvasHandler(),
    new WorkflowsHandler(),
    new DataHandler(),
    new AdminHandler(),
    new GenericHandler(), // fallback
  ];
}

import { PageAgent } from './page-agent/page-agent';
import { extractAndSendToken, watchTokenChanges } from './token-extractor';

// Initialize token extraction
extractAndSendToken();
watchTokenChanges();

// Initialize Page Agent
const pageAgent = new PageAgent();
pageAgent.start();

console.log('[XGEN Extension] Content script loaded');

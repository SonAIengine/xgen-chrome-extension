import { PageAgent } from './page-agent/page-agent';
import { extractAndSendToken, watchTokenChanges } from './token-extractor';
import { injectCursorOverride } from './cursor-override';
import { startPicker, stopPicker } from './element-picker';
import type { ExtensionMessage } from '../shared/types';

// Initialize token extraction
extractAndSendToken();
watchTokenChanges();

// Initialize Page Agent
const pageAgent = new PageAgent();
pageAgent.start();

// Inject cursor style override
injectCursorOverride();

// Element Picker 메시지 처리
chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === 'ELEMENT_PICKER_START') {
    startPicker();
  } else if (message.type === 'ELEMENT_PICKER_STOP') {
    stopPicker();
  }
});

console.log('[XGEN Extension] Content script loaded');

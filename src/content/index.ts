import { PageAgent } from './page-agent/page-agent';
import { extractAndSendToken, watchTokenChanges } from './token-extractor';
import { injectCursorOverride } from './cursor-override';
import { startPicker, stopPicker } from './element-picker';
import { showOverlay, hideOverlay, updateCount } from './floating-overlay';
import type { ExtensionMessage } from '../shared/types';

// Initialize token extraction
extractAndSendToken();
watchTokenChanges();

// Initialize Page Agent
const pageAgent = new PageAgent();
pageAgent.start();

// Inject cursor style override
injectCursorOverride();

// Element Picker / Floating Overlay 메시지 처리
chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  switch (message.type) {
    case 'ELEMENT_PICKER_START':
      startPicker();
      break;
    case 'ELEMENT_PICKER_STOP':
      stopPicker();
      break;
    case 'SHOW_FLOATING_OVERLAY':
      showOverlay();
      break;
    case 'HIDE_FLOATING_OVERLAY':
      hideOverlay();
      break;
    case 'CAPTURE_SESSION_STATUS':
      // SW가 sidepanel + 모든 active tab에 브로드캐스트. overlay 떠있으면 count 반영.
      if (message.active === false) {
        hideOverlay();
      } else if (typeof message.count === 'number') {
        updateCount(message.count);
      }
      break;
  }
});

console.log('[XGEN Extension] Content script loaded');

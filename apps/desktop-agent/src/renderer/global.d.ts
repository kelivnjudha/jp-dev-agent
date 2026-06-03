import type { JadeAgentBridge } from '../preload/preload.js';

declare global {
  interface Window {
    jadeAgent: JadeAgentBridge;
  }
}

export {};

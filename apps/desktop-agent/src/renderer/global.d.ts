import type { JadeAgentBridge } from '../preload/preload.cjs';

declare global {
  interface Window {
    jadeAgent: JadeAgentBridge;
  }
}

export {};

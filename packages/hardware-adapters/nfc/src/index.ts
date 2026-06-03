export interface NfcReaderSummary {
  id: string;
  label: string;
  vendor?: string;
}

export interface NfcCardDetectedEvent {
  readerId: string;
  safeCardPrefix: string;
  detectedAt: string;
}

export interface NfcReaderStatus {
  connected: boolean;
  active: boolean;
  message: string;
  readerCount: number;
}

export interface NfcReaderAdapter {
  listReaders(): Promise<NfcReaderSummary[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
  onCardDetected(handler: (event: NfcCardDetectedEvent) => void): () => void;
  getStatus(): Promise<NfcReaderStatus>;
}

export class PlaceholderNfcReaderAdapter implements NfcReaderAdapter {
  private handlers = new Set<(event: NfcCardDetectedEvent) => void>();

  async listReaders(): Promise<NfcReaderSummary[]> {
    return [];
  }

  async start(): Promise<void> {
    // Real NFC reader integration is deferred.
  }

  async stop(): Promise<void> {
    // Real NFC reader integration is deferred.
  }

  onCardDetected(handler: (event: NfcCardDetectedEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async getStatus(): Promise<NfcReaderStatus> {
    return {
      connected: false,
      active: false,
      message: 'NFC reader placeholder only.',
      readerCount: 0,
    };
  }
}

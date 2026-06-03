export interface PrinterSummary {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface PrinterStatus {
  connected: boolean;
  message: string;
  printerCount: number;
}

export interface PrintReceiptInput {
  receiptId: string;
  branchId: string;
  html?: string;
  text?: string;
}

export interface PrinterAdapter {
  listPrinters(): Promise<PrinterSummary[]>;
  printReceipt(input: PrintReceiptInput): Promise<{ ok: boolean; message: string }>;
  getStatus(): Promise<PrinterStatus>;
}

export class PlaceholderPrinterAdapter implements PrinterAdapter {
  async listPrinters(): Promise<PrinterSummary[]> {
    return [];
  }

  async printReceipt(): Promise<{ ok: boolean; message: string }> {
    return {
      ok: false,
      message: 'Printer bridge is not implemented in this scaffold.',
    };
  }

  async getStatus(): Promise<PrinterStatus> {
    return {
      connected: false,
      message: 'Printer bridge placeholder only.',
      printerCount: 0,
    };
  }
}

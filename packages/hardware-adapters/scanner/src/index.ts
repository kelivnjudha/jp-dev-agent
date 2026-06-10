import { createHash, randomUUID } from 'node:crypto';

import type {
  ScanEvent,
  ScanSource,
  ScanSymbology,
  ScanValidationErrorCode,
  ScanValidationResult,
  ScannerStatus,
} from '@jade-dev-agent/protocol';

const DEFAULT_MAX_SCAN_LENGTH = 256;
const DUPLICATE_WINDOW_MS = 1_000;
const RATE_LIMIT_WINDOW_MS = 1_000;
const RATE_LIMIT_MAX_ACCEPTED = 5;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const EDGE_TERMINATOR_PATTERN = /^[\r\n\t\s]+|[\r\n\t\s]+$/g;

type AimPrefixHint = 'EAN_UPC' | 'CODE128' | 'QR' | 'UNKNOWN';

export interface ScanValidationOptions {
  source?: ScanSource;
  now?: Date;
  maxLength?: number;
  includeValue?: boolean;
}

export interface SafeScannerLogEvent {
  scanId: string;
  source: ScanSource;
  symbology: ScanSymbology | null;
  valueLength: number;
  valueHashPrefix: string | null;
  outcome: 'ACCEPTED' | ScanValidationErrorCode;
}

export interface ScannerAdapter {
  validateInput(input: unknown): Promise<ScanValidationResult>;
  getStatus(): Promise<ScannerStatus>;
}

export interface WedgeScannerHarnessOptions {
  includeValue?: boolean;
  now?: () => Date;
  safeLog?: (event: SafeScannerLogEvent) => void;
}

interface ParsedCapture {
  value: string;
  hint: AimPrefixHint;
}

interface ScanCore {
  event: ScanEvent;
  normalizedValue: string;
}

const aimPrefixHints: Record<string, AimPrefixHint> = {
  ']E0': 'EAN_UPC',
  ']E4': 'EAN_UPC',
  ']C0': 'CODE128',
  ']C1': 'CODE128',
  ']Q1': 'QR',
  ']Q3': 'QR',
};

export class WedgeScannerHarnessAdapter implements ScannerAdapter {
  private acceptedScans: Array<{ valueHashPrefix: string; capturedAtMs: number }> = [];
  private lastScanAt: string | null = null;
  private lastOutcome: 'ACCEPTED' | ScanValidationErrorCode | null = null;
  private duplicateCount = 0;
  private errorCount = 0;

  constructor(private readonly options: WedgeScannerHarnessOptions = {}) {}

  async validateInput(input: unknown): Promise<ScanValidationResult> {
    const now = this.options.now?.() ?? new Date();
    const baseResult = validateScanPayload(input, {
      source: 'WEDGE',
      now,
      includeValue: this.options.includeValue === true,
    });
    const result = baseResult.ok
      ? this.applyDebounceAndRateLimit(baseResult, now)
      : baseResult;

    this.updateStatus(result);
    this.options.safeLog?.(buildSafeScannerLogEvent(result));
    return result;
  }

  async getStatus(): Promise<ScannerStatus> {
    return {
      enabled: true,
      source: 'WEDGE',
      lastScanAt: this.lastScanAt,
      lastOutcome: this.lastOutcome,
      duplicateCount: this.duplicateCount,
      errorCount: this.errorCount,
    };
  }

  private applyDebounceAndRateLimit(
    result: ScanValidationResult & { ok: true },
    now: Date,
  ): ScanValidationResult {
    const capturedAtMs = now.getTime();
    this.acceptedScans = this.acceptedScans.filter(
      (entry) => capturedAtMs - entry.capturedAtMs <= RATE_LIMIT_WINDOW_MS,
    );

    const duplicate = this.acceptedScans.find(
      (entry) =>
        entry.valueHashPrefix === result.event.valueHashPrefix
        && capturedAtMs - entry.capturedAtMs <= DUPLICATE_WINDOW_MS,
    );
    if (duplicate) {
      return buildValidationError({
        code: 'SCAN_DUPLICATE',
        capturedAt: result.event.capturedAt,
        source: result.event.source,
        valueLength: result.event.valueLength,
        valueHashPrefix: result.event.valueHashPrefix,
      });
    }

    if (this.acceptedScans.length >= RATE_LIMIT_MAX_ACCEPTED) {
      return buildValidationError({
        code: 'SCAN_RATE_LIMITED',
        capturedAt: result.event.capturedAt,
        source: result.event.source,
        valueLength: result.event.valueLength,
        valueHashPrefix: result.event.valueHashPrefix,
      });
    }

    this.acceptedScans.push({
      valueHashPrefix: result.event.valueHashPrefix,
      capturedAtMs,
    });
    return result;
  }

  private updateStatus(result: ScanValidationResult): void {
    this.lastScanAt = result.ok ? result.event.capturedAt : result.capturedAt;
    this.lastOutcome = result.ok ? 'ACCEPTED' : result.code;
    if (!result.ok) {
      this.errorCount += 1;
      if (result.code === 'SCAN_DUPLICATE') {
        this.duplicateCount += 1;
      }
    }
  }
}

export function validateScanPayload(
  input: unknown,
  options: ScanValidationOptions = {},
): ScanValidationResult {
  const source = options.source ?? 'WEDGE';
  const capturedAt = (options.now ?? new Date()).toISOString();
  const normalizedInput = normalizeScannerInput(input);
  if (!normalizedInput) {
    return buildValidationError({
      code: 'SCAN_EMPTY',
      capturedAt,
      source,
      valueLength: 0,
      valueHashPrefix: null,
    });
  }

  if (normalizedInput.length > (options.maxLength ?? DEFAULT_MAX_SCAN_LENGTH)) {
    return buildValidationError({
      code: 'SCAN_TOO_LONG',
      capturedAt,
      source,
      valueLength: normalizedInput.length,
      valueHashPrefix: hashPrefix(normalizedInput),
    });
  }

  if (CONTROL_CHAR_PATTERN.test(normalizedInput)) {
    return buildValidationError({
      code: 'SCAN_CONTROL_CHARS',
      capturedAt,
      source,
      valueLength: normalizedInput.length,
      valueHashPrefix: hashPrefix(normalizedInput),
    });
  }

  if (!PRINTABLE_ASCII_PATTERN.test(normalizedInput)) {
    return buildValidationError({
      code: 'SCAN_INVALID_CHARSET',
      capturedAt,
      source,
      valueLength: normalizedInput.length,
      valueHashPrefix: hashPrefix(normalizedInput),
    });
  }

  const parsed = parseAimPrefix(normalizedInput);
  if (!parsed.value) {
    return buildValidationError({
      code: 'SCAN_EMPTY',
      capturedAt,
      source,
      valueLength: 0,
      valueHashPrefix: null,
    });
  }

  const inferred = inferSymbology(parsed);
  if (!inferred.ok) {
    return buildValidationError({
      code: inferred.code,
      capturedAt,
      source,
      valueLength: parsed.value.length,
      valueHashPrefix: hashPrefix(parsed.value),
    });
  }

  return {
    ok: true,
    event: buildScanEvent({
      normalizedValue: parsed.value,
      capturedAt,
      source,
      symbology: inferred.symbology,
      includeValue: options.includeValue === true,
    }),
  };
}

export function buildSafeScannerLogEvent(result: ScanValidationResult): SafeScannerLogEvent {
  if (result.ok) {
    return {
      scanId: result.event.scanId,
      source: result.event.source,
      symbology: result.event.symbology,
      valueLength: result.event.valueLength,
      valueHashPrefix: result.event.valueHashPrefix,
      outcome: 'ACCEPTED',
    };
  }

  return {
    scanId: 'rejected',
    source: result.source,
    symbology: null,
    valueLength: result.valueLength,
    valueHashPrefix: result.valueHashPrefix,
    outcome: result.code,
  };
}

function normalizeScannerInput(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(EDGE_TERMINATOR_PATTERN, '');
}

function parseAimPrefix(value: string): ParsedCapture {
  if (!value.startsWith(']') || value.length < 4) {
    return { value, hint: 'UNKNOWN' };
  }

  const prefix = value.slice(0, 3);
  const hint = aimPrefixHints[prefix];
  if (!hint) return { value, hint: 'UNKNOWN' };
  return {
    value: value.slice(3),
    hint,
  };
}

function inferSymbology(
  parsed: ParsedCapture,
):
  | { ok: true; symbology: ScanSymbology }
  | { ok: false; code: ScanValidationErrorCode } {
  if (parsed.hint === 'QR') return { ok: true, symbology: 'QR' };
  if (parsed.hint === 'CODE128') return { ok: true, symbology: 'CODE128' };

  if (/^\d+$/.test(parsed.value)) {
    if (parsed.value.length === 13) {
      return validateEanCheckDigit(parsed.value)
        ? { ok: true, symbology: 'EAN13' }
        : { ok: false, code: 'SCAN_EAN_CHECK_DIGIT_INVALID' };
    }
    if (parsed.value.length === 8) {
      return validateEanCheckDigit(parsed.value)
        ? { ok: true, symbology: 'EAN8' }
        : { ok: false, code: 'SCAN_EAN_CHECK_DIGIT_INVALID' };
    }
    if (parsed.value.length === 12) {
      return validateEanCheckDigit(parsed.value)
        ? { ok: true, symbology: 'UPCA' }
        : { ok: false, code: 'SCAN_EAN_CHECK_DIGIT_INVALID' };
    }
    if (parsed.value.length === 6) {
      return { ok: true, symbology: 'UPCE' };
    }
  }

  if (parsed.hint === 'EAN_UPC') {
    return { ok: false, code: 'SCAN_UNSUPPORTED_FORMAT' };
  }

  return { ok: true, symbology: 'CODE128' };
}

function validateEanCheckDigit(value: string): boolean {
  const digits = [...value].map((digit) => Number(digit));
  if (digits.some((digit) => !Number.isInteger(digit))) return false;
  const checkDigit = digits.at(-1);
  if (checkDigit === undefined) return false;
  const body = digits.slice(0, -1).reverse();
  const sum = body.reduce((total, digit, index) => {
    const weight = index % 2 === 0 ? 3 : 1;
    return total + digit * weight;
  }, 0);
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function buildScanEvent({
  normalizedValue,
  capturedAt,
  source,
  symbology,
  includeValue,
}: {
  normalizedValue: string;
  capturedAt: string;
  source: ScanSource;
  symbology: ScanSymbology;
  includeValue: boolean;
}): ScanEvent {
  const event: ScanEvent = {
    type: 'SCAN',
    scanId: randomUUID(),
    capturedAt,
    source,
    symbology,
    valueLength: normalizedValue.length,
    valueHashPrefix: hashPrefix(normalizedValue),
  };
  if (includeValue) {
    event.value = normalizedValue;
  }
  return event;
}

function buildValidationError({
  code,
  capturedAt,
  source,
  valueLength,
  valueHashPrefix,
}: {
  code: ScanValidationErrorCode;
  capturedAt: string;
  source: ScanSource;
  valueLength: number;
  valueHashPrefix: string | null;
}): ScanValidationResult {
  return {
    ok: false,
    code,
    capturedAt,
    source,
    valueLength,
    valueHashPrefix,
  };
}

function hashPrefix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

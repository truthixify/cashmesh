import { type UnixTimestamp, unixTimestamp } from "@cashmesh/domain";

import { normalizeCashuMintUrl } from "./mint-url";
import {
  CASHU_STELLAR_METHOD,
  CashuStellarMeltQuoteError,
  type CashuStellarMeltQuoteV1,
  createCashuStellarMeltQuoteRequestV1,
  createCashuStellarMeltQuoteV1,
  MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS,
} from "./stellar-melt-quote";

export const DEFAULT_CASHU_STELLAR_MELT_QUOTE_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_CASHU_STELLAR_MELT_QUOTE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_CASHU_STELLAR_MELT_QUOTE_RESPONSE_BYTES = 65_536;
export const MAX_CASHU_STELLAR_MELT_QUOTE_RESPONSE_BYTES = 262_144;

export interface CashuStellarMeltQuoteClientOptions {
  readonly clock?: () => number;
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface CreateCashuStellarMeltQuoteClientInput {
  readonly amount: number;
  readonly request: string;
  readonly signal?: AbortSignal;
}

export interface CashuStellarMeltQuoteCheckOptions {
  readonly signal?: AbortSignal;
}

export type CashuStellarMeltQuoteClientErrorCode =
  | "invalid_clock"
  | "invalid_configuration"
  | "invalid_request"
  | "invalid_response"
  | "network_error"
  | "quote_expired"
  | "quote_response_mismatch"
  | "request_aborted"
  | "request_timeout"
  | "response_too_large"
  | "unexpected_status";

export class CashuStellarMeltQuoteClientError extends Error {
  override readonly name = "CashuStellarMeltQuoteClientError";

  constructor(
    readonly code: CashuStellarMeltQuoteClientErrorCode,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export class CashuStellarMeltQuoteClient {
  readonly mintUrl: string;

  private readonly clock: () => number;
  private readonly fetch: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly requestTimeoutMs: number;

  constructor(mintUrl: string, options: CashuStellarMeltQuoteClientOptions = {}) {
    try {
      this.mintUrl = normalizeCashuMintUrl(mintUrl);
    } catch {
      throw invalidConfiguration();
    }
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw invalidConfiguration();
    }
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_CASHU_STELLAR_MELT_QUOTE_RESPONSE_BYTES;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_CASHU_STELLAR_MELT_QUOTE_REQUEST_TIMEOUT_MS;
    if (
      typeof this.clock !== "function" ||
      typeof this.fetch !== "function" ||
      !isBoundedPositiveInteger(
        this.maxResponseBytes,
        MAX_CASHU_STELLAR_MELT_QUOTE_RESPONSE_BYTES,
      ) ||
      !isBoundedPositiveInteger(
        this.requestTimeoutMs,
        MAX_CASHU_STELLAR_MELT_QUOTE_REQUEST_TIMEOUT_MS,
      )
    ) {
      throw invalidConfiguration();
    }
  }

  async create(input: CreateCashuStellarMeltQuoteClientInput): Promise<CashuStellarMeltQuoteV1> {
    const request = validateCreateInput(input);
    const startedAt = this.readClock();
    const response = await this.requestJson(
      `/v1/melt/quote/${CASHU_STELLAR_METHOD}`,
      "POST",
      {
        amount: request.amount,
        request: request.request,
        unit: request.unit,
      },
      input.signal,
    );
    const observedAt = this.readClock();
    if (observedAt < startedAt) {
      throw invalidClock();
    }

    const quote = parseCashuStellarMeltQuoteResponse(response, this.mintUrl, observedAt);
    if (quote.amount !== request.amount || quote.request !== request.request) {
      throw quoteResponseMismatch();
    }
    if (quote.state !== "UNPAID") {
      throw new CashuStellarMeltQuoteClientError(
        "invalid_response",
        "A newly created Cashu Stellar melt quote was not unpaid.",
      );
    }
    if (quote.expiry <= observedAt) {
      throw new CashuStellarMeltQuoteClientError(
        "quote_expired",
        "The Cashu Stellar melt quote expired before it could be accepted.",
      );
    }
    if (quote.expiry - startedAt > MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS) {
      throw new CashuStellarMeltQuoteClientError(
        "invalid_response",
        "The Cashu Stellar melt quote expiry exceeds the configured profile.",
      );
    }
    return quote;
  }

  async check(
    quote: CashuStellarMeltQuoteV1,
    options: CashuStellarMeltQuoteCheckOptions = {},
  ): Promise<CashuStellarMeltQuoteV1> {
    const expected = validateCheckInput(quote, options, this.mintUrl);
    const startedAt = this.readClock();
    if (startedAt < expected.observedAt) {
      throw invalidClock();
    }
    const response = await this.requestJson(
      `/v1/melt/quote/${CASHU_STELLAR_METHOD}/${expected.quoteId}`,
      "GET",
      undefined,
      options.signal,
    );
    const observedAt = this.readClock();
    if (observedAt < startedAt) {
      throw invalidClock();
    }

    const observed = parseCashuStellarMeltQuoteResponse(response, this.mintUrl, observedAt);
    if (!cashuStellarMeltQuoteTermsMatch(expected, observed)) {
      throw quoteResponseMismatch();
    }
    if (expected.state === "PAID" && observed.state !== "PAID") {
      throw quoteResponseMismatch();
    }
    return observed;
  }

  private readClock(): UnixTimestamp {
    try {
      return unixTimestamp(this.clock());
    } catch {
      throw invalidClock();
    }
  }

  private async requestJson(
    path: string,
    method: "GET" | "POST",
    body: Readonly<Record<string, unknown>> | undefined,
    externalSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (externalSignal?.aborted) {
      throw requestAborted();
    }

    const endpoint = `${this.mintUrl}${path}`;
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
    const signal =
      externalSignal === undefined
        ? timeoutController.signal
        : AbortSignal.any([externalSignal, timeoutController.signal]);

    try {
      const response = await raceWithAbort(
        this.fetch(endpoint, {
          ...(body !== undefined && { body: JSON.stringify(body) }),
          cache: "no-store",
          credentials: "omit",
          headers: {
            accept: "application/json",
            ...(body !== undefined && { "content-type": "application/json" }),
          },
          method,
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal,
        }),
        signal,
      );
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        cancelResponseBody(response);
        throw new CashuStellarMeltQuoteClientError(
          "invalid_response",
          "Cashu Stellar melt quote response did not come from the requested endpoint.",
        );
      }
      if (!response.ok) {
        cancelResponseBody(response);
        throw new CashuStellarMeltQuoteClientError(
          "unexpected_status",
          "Cashu Stellar melt quote endpoint returned an unsuccessful status.",
          response.status,
        );
      }

      const responseBody = await readBoundedResponseBody(response, this.maxResponseBytes, signal);
      try {
        return JSON.parse(responseBody) as unknown;
      } catch {
        throw new CashuStellarMeltQuoteClientError(
          "invalid_response",
          "Cashu Stellar melt quote endpoint returned invalid JSON.",
        );
      }
    } catch (error) {
      if (externalSignal?.aborted) {
        throw requestAborted();
      }
      if (timeoutController.signal.aborted) {
        throw new CashuStellarMeltQuoteClientError(
          "request_timeout",
          "Cashu Stellar melt quote request timed out.",
        );
      }
      if (error instanceof CashuStellarMeltQuoteClientError) {
        throw error;
      }
      throw new CashuStellarMeltQuoteClientError(
        "network_error",
        "Cashu Stellar melt quote endpoint is unavailable.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateCreateInput(
  input: CreateCashuStellarMeltQuoteClientInput,
): ReturnType<typeof createCashuStellarMeltQuoteRequestV1> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (input.signal !== undefined && !(input.signal instanceof AbortSignal))
  ) {
    throw invalidRequest();
  }
  try {
    return createCashuStellarMeltQuoteRequestV1(input);
  } catch {
    throw invalidRequest();
  }
}

function validateCheckInput(
  quote: CashuStellarMeltQuoteV1,
  options: CashuStellarMeltQuoteCheckOptions,
  mintUrl: string,
): CashuStellarMeltQuoteV1 {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    throw invalidRequest();
  }
  try {
    const normalized = createCashuStellarMeltQuoteV1(quote);
    if (normalized.mintUrl !== mintUrl) {
      throw invalidRequest();
    }
    return normalized;
  } catch (error) {
    if (error instanceof CashuStellarMeltQuoteClientError) {
      throw error;
    }
    throw invalidRequest();
  }
}

export function parseCashuStellarMeltQuoteResponse(
  value: unknown,
  mintUrl: string,
  observedAt: UnixTimestamp,
): CashuStellarMeltQuoteV1 {
  const response = objectRecord(value);
  if (response === undefined || hasUnsupportedChange(response.change)) {
    throw invalidResponse();
  }
  try {
    return createCashuStellarMeltQuoteV1({
      amount: response.amount as number,
      expiry: response.expiry as number,
      feeReserve: response.fee_reserve === undefined ? 0 : (response.fee_reserve as number),
      method: response.method as string,
      mintUrl,
      observedAt,
      quoteId: response.quote as string,
      request: response.request as string,
      state: response.state as string,
      unit: response.unit as string,
    });
  } catch (error) {
    if (error instanceof CashuStellarMeltQuoteError) {
      throw invalidResponse();
    }
    throw error;
  }
}

function hasUnsupportedChange(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  return !Array.isArray(value) || value.length !== 0;
}

export function cashuStellarMeltQuoteTermsMatch(
  expected: CashuStellarMeltQuoteV1,
  observed: CashuStellarMeltQuoteV1,
): boolean {
  return (
    observed.amount === expected.amount &&
    observed.expiry === expected.expiry &&
    observed.feeReserve === expected.feeReserve &&
    observed.method === expected.method &&
    observed.mintUrl === expected.mintUrl &&
    observed.quoteId === expected.quoteId &&
    observed.request === expected.request &&
    observed.unit === expected.unit
  );
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^[0-9]+$/.test(contentLength) &&
    BigInt(contentLength) > BigInt(maximumBytes)
  ) {
    cancelResponseBody(response);
    throw responseTooLarge();
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await readWithAbort(reader, signal);
    if (result.done) {
      break;
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      cancelReader(reader);
      throw responseTooLarge();
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new CashuStellarMeltQuoteClientError(
      "invalid_response",
      "Cashu Stellar melt quote endpoint returned invalid text.",
    );
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return raceWithAbort(reader.read(), signal, () => {
    cancelReader(reader, signal.reason);
  });
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason;
  }

  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(signal.reason);
      try {
        onAbort?.();
      } catch {
        // Cancellation is best-effort after the caller-visible abort.
      }
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abort !== undefined) {
      signal.removeEventListener("abort", abort);
    }
  }
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Cancellation must not delay or replace the primary transport error.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation must not delay or replace the primary transport error.
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isBoundedPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function invalidClock(): CashuStellarMeltQuoteClientError {
  return new CashuStellarMeltQuoteClientError(
    "invalid_clock",
    "Cashu Stellar melt quote observation clock is invalid.",
  );
}

function invalidConfiguration(): CashuStellarMeltQuoteClientError {
  return new CashuStellarMeltQuoteClientError(
    "invalid_configuration",
    "Cashu Stellar melt quote client configuration is invalid.",
  );
}

function invalidRequest(): CashuStellarMeltQuoteClientError {
  return new CashuStellarMeltQuoteClientError(
    "invalid_request",
    "Cashu Stellar melt quote request is invalid.",
  );
}

function invalidResponse(): CashuStellarMeltQuoteClientError {
  return new CashuStellarMeltQuoteClientError(
    "invalid_response",
    "Cashu Stellar melt quote endpoint returned an invalid response.",
  );
}

function quoteResponseMismatch(): CashuStellarMeltQuoteClientError {
  return new CashuStellarMeltQuoteClientError(
    "quote_response_mismatch",
    "Cashu Stellar melt quote response changed immutable quote terms.",
  );
}

function requestAborted(): CashuStellarMeltQuoteClientError {
  return new CashuStellarMeltQuoteClientError(
    "request_aborted",
    "Cashu Stellar melt quote request was aborted.",
  );
}

function responseTooLarge(): CashuStellarMeltQuoteClientError {
  return new CashuStellarMeltQuoteClientError(
    "response_too_large",
    "Cashu Stellar melt quote response exceeds the transport limit.",
  );
}

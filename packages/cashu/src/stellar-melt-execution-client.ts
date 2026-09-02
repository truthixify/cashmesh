import {
  type MinorUnitAmount,
  minorUnits,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";

import {
  type CashuBearerMeltInputV1,
  CashuBearerProofBundleV1,
  withCashuBearerMeltInputsV1,
} from "./bearer-proof-bundle";
import { normalizeCashuMintUrl } from "./mint-url";
import {
  CASHU_STELLAR_METHOD,
  type CashuStellarMeltQuoteId,
  type CashuStellarMeltQuoteV1,
  createCashuStellarMeltQuoteV1,
} from "./stellar-melt-quote";
import {
  cashuStellarMeltQuoteTermsMatch,
  parseCashuStellarMeltQuoteResponse,
} from "./stellar-melt-quote-client";

export const CASHU_STELLAR_MELT_DISPATCH_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CASHU_STELLAR_MELT_EXECUTION_TIMEOUT_MS = 5_000;
export const MAX_CASHU_STELLAR_MELT_EXECUTION_TIMEOUT_MS = 30_000;
export const DEFAULT_CASHU_STELLAR_MELT_EXECUTION_RESPONSE_BYTES = 65_536;
export const MAX_CASHU_STELLAR_MELT_EXECUTION_RESPONSE_BYTES = 262_144;

const DISPATCH_FINGERPRINT_DOMAIN = "cashmesh.cashu.stellar-melt-dispatch.v1";
const TEXT_ENCODER = new TextEncoder();

declare const cashuStellarMeltDispatchFingerprintBrand: unique symbol;

export type CashuStellarMeltDispatchFingerprint = string & {
  readonly [cashuStellarMeltDispatchFingerprintBrand]: true;
};

export interface CashuStellarMeltExecutionClientOptions {
  readonly clock?: () => number;
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface CashuStellarMeltDispatchV1 {
  readonly dispatchFingerprint: CashuStellarMeltDispatchFingerprint;
  readonly expiresAt: UnixTimestamp;
  readonly method: typeof CASHU_STELLAR_METHOD;
  readonly mintUrl: string;
  readonly quoteId: CashuStellarMeltQuoteId;
  readonly schemaVersion: typeof CASHU_STELLAR_MELT_DISPATCH_SCHEMA_VERSION;
}

export interface ExecuteCashuStellarMeltInputV1 {
  readonly authorize: (dispatch: CashuStellarMeltDispatchV1) => boolean | Promise<boolean>;
  readonly bearerProofs: CashuBearerProofBundleV1;
  readonly inputFee: number;
  readonly quote: CashuStellarMeltQuoteV1;
  readonly signal?: AbortSignal;
}

export interface CashuStellarMeltExecutionResultV1 {
  readonly dispatch: CashuStellarMeltDispatchV1;
  readonly quote: CashuStellarMeltQuoteV1;
}

export type CashuStellarMeltExecutionClientErrorCode =
  | "dispatch_not_authorized"
  | "input_amount_mismatch"
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
  | "unexpected_status"
  | "unsupported_fee_reserve";

export class CashuStellarMeltExecutionClientError extends Error {
  override readonly name = "CashuStellarMeltExecutionClientError";

  constructor(
    readonly code: CashuStellarMeltExecutionClientErrorCode,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export class CashuStellarMeltExecutionClient {
  readonly mintUrl: string;

  private readonly clock: () => number;
  private readonly fetch: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly requestTimeoutMs: number;

  constructor(mintUrl: string, options: CashuStellarMeltExecutionClientOptions = {}) {
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
      options.maxResponseBytes ?? DEFAULT_CASHU_STELLAR_MELT_EXECUTION_RESPONSE_BYTES;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_CASHU_STELLAR_MELT_EXECUTION_TIMEOUT_MS;
    if (
      typeof this.clock !== "function" ||
      typeof this.fetch !== "function" ||
      globalThis.crypto?.subtle === undefined ||
      !isBoundedPositiveInteger(
        this.maxResponseBytes,
        MAX_CASHU_STELLAR_MELT_EXECUTION_RESPONSE_BYTES,
      ) ||
      !isBoundedPositiveInteger(this.requestTimeoutMs, MAX_CASHU_STELLAR_MELT_EXECUTION_TIMEOUT_MS)
    ) {
      throw invalidConfiguration();
    }
  }

  async execute(input: ExecuteCashuStellarMeltInputV1): Promise<CashuStellarMeltExecutionResultV1> {
    const validated = validateExecutionInput(input, this.mintUrl);
    if (validated.signal?.aborted) {
      throw requestAborted();
    }
    const preparedAt = this.readClock();
    requireDispatchableQuote(validated.quote, preparedAt);

    try {
      return withCashuBearerMeltInputsV1(validated.bearerProofs, async (inputs) => {
        requireExactInputAmount(inputs, validated.quote.amount, validated.inputFee);
        const endpoint = `${this.mintUrl}/v1/melt/${CASHU_STELLAR_METHOD}`;
        const requestBody = JSON.stringify({
          quote: validated.quote.quoteId,
          inputs,
          prefer_async: true,
        });
        const dispatch = await createDispatch(validated.quote, endpoint, requestBody);
        if (validated.signal?.aborted) {
          throw requestAborted();
        }
        if ((await validated.authorize(dispatch)) !== true) {
          throw new CashuStellarMeltExecutionClientError(
            "dispatch_not_authorized",
            "Cashu Stellar melt dispatch was not authorized.",
          );
        }
        if (validated.signal?.aborted) {
          throw requestAborted();
        }

        const dispatchedAt = this.readClock();
        if (dispatchedAt < preparedAt) {
          throw invalidClock();
        }
        if (dispatchedAt >= validated.quote.expiry) {
          throw quoteExpired();
        }

        const response = await this.requestJson(endpoint, requestBody, validated.signal);
        const observedAt = this.readClock();
        if (observedAt < dispatchedAt) {
          throw invalidClock();
        }
        const observed = parseExecutionResponse(response, this.mintUrl, observedAt);
        if (!cashuStellarMeltQuoteTermsMatch(validated.quote, observed)) {
          throw new CashuStellarMeltExecutionClientError(
            "quote_response_mismatch",
            "Cashu Stellar melt response changed immutable quote terms.",
          );
        }
        return Object.freeze({ dispatch, quote: observed });
      });
    } catch {
      throw invalidRequest();
    }
  }

  private readClock(): UnixTimestamp {
    try {
      return unixTimestamp(this.clock());
    } catch {
      throw invalidClock();
    }
  }

  private async requestJson(
    endpoint: string,
    body: string,
    externalSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (externalSignal?.aborted) {
      throw requestAborted();
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
    const signal =
      externalSignal === undefined
        ? timeoutController.signal
        : AbortSignal.any([externalSignal, timeoutController.signal]);

    try {
      const response = await raceWithAbort(
        this.fetch(endpoint, {
          body,
          cache: "no-store",
          credentials: "omit",
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal,
        }),
        signal,
      );
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        cancelResponseBody(response);
        throw invalidResponse();
      }
      if (!response.ok) {
        cancelResponseBody(response);
        throw new CashuStellarMeltExecutionClientError(
          "unexpected_status",
          "Cashu Stellar melt endpoint returned an unsuccessful status.",
          response.status,
        );
      }

      const responseBody = await readBoundedResponseBody(response, this.maxResponseBytes, signal);
      try {
        return JSON.parse(responseBody) as unknown;
      } catch {
        throw invalidResponse();
      }
    } catch (error) {
      if (externalSignal?.aborted) {
        throw requestAborted();
      }
      if (timeoutController.signal.aborted) {
        throw new CashuStellarMeltExecutionClientError(
          "request_timeout",
          "Cashu Stellar melt request timed out.",
        );
      }
      if (error instanceof CashuStellarMeltExecutionClientError) {
        throw error;
      }
      throw new CashuStellarMeltExecutionClientError(
        "network_error",
        "Cashu Stellar melt endpoint is unavailable.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface ValidatedExecutionInput {
  readonly authorize: ExecuteCashuStellarMeltInputV1["authorize"];
  readonly bearerProofs: CashuBearerProofBundleV1;
  readonly inputFee: MinorUnitAmount;
  readonly quote: CashuStellarMeltQuoteV1;
  readonly signal?: AbortSignal;
}

function validateExecutionInput(
  input: ExecuteCashuStellarMeltInputV1,
  mintUrl: string,
): ValidatedExecutionInput {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    typeof input.authorize !== "function" ||
    !(input.bearerProofs instanceof CashuBearerProofBundleV1) ||
    (input.signal !== undefined && !(input.signal instanceof AbortSignal))
  ) {
    throw invalidRequest();
  }

  let quote: CashuStellarMeltQuoteV1;
  let inputFee: MinorUnitAmount;
  try {
    quote = createCashuStellarMeltQuoteV1(input.quote);
    inputFee = minorUnits(input.inputFee);
  } catch {
    throw invalidRequest();
  }
  if (
    quote.mintUrl !== mintUrl ||
    input.bearerProofs?.mintUrl !== mintUrl ||
    input.bearerProofs.unit !== quote.unit
  ) {
    throw invalidRequest();
  }
  if (quote.feeReserve !== 0) {
    throw new CashuStellarMeltExecutionClientError(
      "unsupported_fee_reserve",
      "Cashu Stellar melt execution does not support fee reserves or change.",
    );
  }
  return {
    authorize: input.authorize,
    bearerProofs: input.bearerProofs,
    inputFee,
    quote,
    ...(input.signal !== undefined && { signal: input.signal }),
  };
}

function requireDispatchableQuote(quote: CashuStellarMeltQuoteV1, now: UnixTimestamp): void {
  if (quote.observedAt > now) {
    throw invalidClock();
  }
  if (quote.state !== "UNPAID") {
    throw invalidRequest();
  }
  if (now >= quote.expiry) {
    throw quoteExpired();
  }
}

function requireExactInputAmount(
  inputs: readonly CashuBearerMeltInputV1[],
  amount: MinorUnitAmount,
  inputFee: MinorUnitAmount,
): void {
  let total = 0;
  for (const input of inputs) {
    total += input.amount;
    if (!Number.isSafeInteger(total)) {
      throw inputAmountMismatch();
    }
  }
  if (!Number.isSafeInteger(amount + inputFee) || total !== amount + inputFee) {
    throw inputAmountMismatch();
  }
}

async function createDispatch(
  quote: CashuStellarMeltQuoteV1,
  endpoint: string,
  requestBody: string,
): Promise<CashuStellarMeltDispatchV1> {
  const fingerprintMaterial = JSON.stringify({
    body: requestBody,
    domain: DISPATCH_FINGERPRINT_DOMAIN,
    method: "POST",
    url: endpoint,
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(fingerprintMaterial),
  );
  const dispatchFingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("") as CashuStellarMeltDispatchFingerprint;
  return Object.freeze({
    dispatchFingerprint,
    expiresAt: quote.expiry,
    method: CASHU_STELLAR_METHOD,
    mintUrl: quote.mintUrl,
    quoteId: quote.quoteId,
    schemaVersion: CASHU_STELLAR_MELT_DISPATCH_SCHEMA_VERSION,
  });
}

function parseExecutionResponse(
  response: unknown,
  mintUrl: string,
  observedAt: UnixTimestamp,
): CashuStellarMeltQuoteV1 {
  try {
    return parseCashuStellarMeltQuoteResponse(response, mintUrl, observedAt);
  } catch {
    throw invalidResponse();
  }
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
    throw invalidResponse();
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

function isBoundedPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function invalidClock(): CashuStellarMeltExecutionClientError {
  return new CashuStellarMeltExecutionClientError(
    "invalid_clock",
    "Cashu Stellar melt execution clock is invalid.",
  );
}

function invalidConfiguration(): CashuStellarMeltExecutionClientError {
  return new CashuStellarMeltExecutionClientError(
    "invalid_configuration",
    "Cashu Stellar melt execution client configuration is invalid.",
  );
}

function invalidRequest(): CashuStellarMeltExecutionClientError {
  return new CashuStellarMeltExecutionClientError(
    "invalid_request",
    "Cashu Stellar melt execution request is invalid.",
  );
}

function invalidResponse(): CashuStellarMeltExecutionClientError {
  return new CashuStellarMeltExecutionClientError(
    "invalid_response",
    "Cashu Stellar melt endpoint returned an invalid response.",
  );
}

function inputAmountMismatch(): CashuStellarMeltExecutionClientError {
  return new CashuStellarMeltExecutionClientError(
    "input_amount_mismatch",
    "Cashu Stellar melt inputs do not exactly cover the quote and input fee.",
  );
}

function quoteExpired(): CashuStellarMeltExecutionClientError {
  return new CashuStellarMeltExecutionClientError(
    "quote_expired",
    "Cashu Stellar melt quote expired before dispatch.",
  );
}

function requestAborted(): CashuStellarMeltExecutionClientError {
  return new CashuStellarMeltExecutionClientError(
    "request_aborted",
    "Cashu Stellar melt request was aborted.",
  );
}

function responseTooLarge(): CashuStellarMeltExecutionClientError {
  return new CashuStellarMeltExecutionClientError(
    "response_too_large",
    "Cashu Stellar melt response exceeds the transport limit.",
  );
}

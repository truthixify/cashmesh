import { normalizeCashuMintUrl } from "./mint-url";
import { type CashuProofY, cashuProofY } from "./proof-reference";
import { MAX_CASHU_PROOF_STATES_PER_SNAPSHOT } from "./proof-state";

export const DEFAULT_CASHU_PROOF_STATE_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_CASHU_PROOF_STATE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_CASHU_PROOF_STATE_RESPONSE_BYTES = 262_144;
export const MAX_CASHU_PROOF_STATE_RESPONSE_BYTES = 1_048_576;

export interface CashuProofStateReadOptions {
  readonly signal?: AbortSignal;
}

export interface CashuMintProofStateSource {
  readonly mintUrl: string;
  checkProofStates(
    proofYs: readonly string[],
    options?: CashuProofStateReadOptions,
  ): Promise<unknown>;
}

export interface CashuMintProofStateHttpClientOptions {
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
}

export type CashuMintProofStateHttpErrorCode =
  | "invalid_configuration"
  | "invalid_request"
  | "invalid_response"
  | "network_error"
  | "request_aborted"
  | "request_timeout"
  | "response_too_large"
  | "unexpected_status";

export class CashuMintProofStateHttpError extends Error {
  override readonly name = "CashuMintProofStateHttpError";

  constructor(
    readonly code: CashuMintProofStateHttpErrorCode,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export class CashuMintProofStateHttpClient implements CashuMintProofStateSource {
  readonly mintUrl: string;

  private readonly fetch: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly requestTimeoutMs: number;

  constructor(mintUrl: string, options: CashuMintProofStateHttpClientOptions = {}) {
    try {
      this.mintUrl = normalizeCashuMintUrl(mintUrl);
    } catch {
      throw invalidConfiguration();
    }
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw invalidConfiguration();
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_CASHU_PROOF_STATE_RESPONSE_BYTES;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_CASHU_PROOF_STATE_REQUEST_TIMEOUT_MS;
    if (
      typeof this.fetch !== "function" ||
      !isBoundedPositiveInteger(this.maxResponseBytes, MAX_CASHU_PROOF_STATE_RESPONSE_BYTES) ||
      !isBoundedPositiveInteger(this.requestTimeoutMs, MAX_CASHU_PROOF_STATE_REQUEST_TIMEOUT_MS)
    ) {
      throw invalidConfiguration();
    }
  }

  async checkProofStates(
    proofYs: readonly string[],
    options: CashuProofStateReadOptions = {},
  ): Promise<unknown> {
    const requestYs = validateRequest(proofYs, options);
    if (options.signal?.aborted) {
      throw requestAborted();
    }

    const endpoint = `${this.mintUrl}/v1/checkstate`;
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
    const signal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]);

    try {
      const response = await raceWithAbort(
        this.fetch(endpoint, {
          body: JSON.stringify({ Ys: requestYs }),
          cache: "no-store",
          credentials: "omit",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal,
        }),
        signal,
      );
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        cancelResponseBody(response);
        throw new CashuMintProofStateHttpError(
          "invalid_response",
          "Cashu proof-state response did not come from the requested endpoint.",
        );
      }
      if (!response.ok) {
        cancelResponseBody(response);
        throw new CashuMintProofStateHttpError(
          "unexpected_status",
          "Cashu proof-state endpoint returned an unsuccessful status.",
          response.status,
        );
      }

      const body = await readBoundedResponseBody(response, this.maxResponseBytes, signal);
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new CashuMintProofStateHttpError(
          "invalid_response",
          "Cashu proof-state endpoint returned invalid JSON.",
        );
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw requestAborted();
      }
      if (timeoutController.signal.aborted) {
        throw new CashuMintProofStateHttpError(
          "request_timeout",
          "Cashu proof-state request timed out.",
        );
      }
      if (error instanceof CashuMintProofStateHttpError) {
        throw error;
      }
      throw new CashuMintProofStateHttpError(
        "network_error",
        "Cashu proof-state endpoint is unavailable.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateRequest(
  proofYs: readonly string[],
  options: CashuProofStateReadOptions,
): readonly CashuProofY[] {
  if (
    !Array.isArray(proofYs) ||
    proofYs.length === 0 ||
    proofYs.length > MAX_CASHU_PROOF_STATES_PER_SNAPSHOT ||
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    throw invalidRequest();
  }
  try {
    const seen = new Set<CashuProofY>();
    const normalized = Array.from(proofYs, (value) => {
      const y = cashuProofY(value);
      if (seen.has(y)) {
        throw invalidRequest();
      }
      seen.add(y);
      return y;
    });
    return Object.freeze(normalized);
  } catch (error) {
    if (error instanceof CashuMintProofStateHttpError) {
      throw error;
    }
    throw invalidRequest();
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
    throw new CashuMintProofStateHttpError(
      "invalid_response",
      "Cashu proof-state endpoint returned invalid text.",
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

function isBoundedPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function invalidConfiguration(): CashuMintProofStateHttpError {
  return new CashuMintProofStateHttpError(
    "invalid_configuration",
    "Cashu proof-state HTTP client configuration is invalid.",
  );
}

function invalidRequest(): CashuMintProofStateHttpError {
  return new CashuMintProofStateHttpError(
    "invalid_request",
    "Cashu proof-state request is invalid.",
  );
}

function requestAborted(): CashuMintProofStateHttpError {
  return new CashuMintProofStateHttpError(
    "request_aborted",
    "Cashu proof-state request was aborted.",
  );
}

function responseTooLarge(): CashuMintProofStateHttpError {
  return new CashuMintProofStateHttpError(
    "response_too_large",
    "Cashu proof-state response exceeds the transport limit.",
  );
}

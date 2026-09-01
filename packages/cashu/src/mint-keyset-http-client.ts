import { normalizeCashuMintUrl } from "./mint-url";

export const DEFAULT_CASHU_KEYSET_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_CASHU_KEYSET_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_CASHU_KEYSET_RESPONSE_BYTES = 262_144;
export const MAX_CASHU_KEYSET_RESPONSE_BYTES = 1_048_576;

const KEYSET_ID_PATTERN = /^(?:00[0-9a-f]{14}|01[0-9a-f]{64})$/;

export interface CashuKeysetReadOptions {
  readonly signal?: AbortSignal;
}

export interface CashuMintKeysetSource {
  readonly mintUrl: string;
  getKeys(keysetId: string, options?: CashuKeysetReadOptions): Promise<unknown>;
  getKeysets(options?: CashuKeysetReadOptions): Promise<unknown>;
}

export interface CashuMintKeysetHttpClientOptions {
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
}

export type CashuMintKeysetHttpErrorCode =
  | "invalid_configuration"
  | "invalid_response"
  | "network_error"
  | "request_aborted"
  | "request_timeout"
  | "response_too_large"
  | "unexpected_status";

export class CashuMintKeysetHttpError extends Error {
  override readonly name = "CashuMintKeysetHttpError";

  constructor(
    readonly code: CashuMintKeysetHttpErrorCode,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export class CashuMintKeysetHttpClient implements CashuMintKeysetSource {
  readonly mintUrl: string;

  private readonly fetch: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly requestTimeoutMs: number;

  constructor(mintUrl: string, options: CashuMintKeysetHttpClientOptions = {}) {
    try {
      this.mintUrl = normalizeCashuMintUrl(mintUrl);
    } catch {
      throw invalidConfiguration();
    }
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw invalidConfiguration();
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_CASHU_KEYSET_RESPONSE_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CASHU_KEYSET_REQUEST_TIMEOUT_MS;
    if (
      typeof this.fetch !== "function" ||
      !isBoundedPositiveInteger(this.maxResponseBytes, MAX_CASHU_KEYSET_RESPONSE_BYTES) ||
      !isBoundedPositiveInteger(this.requestTimeoutMs, MAX_CASHU_KEYSET_REQUEST_TIMEOUT_MS)
    ) {
      throw invalidConfiguration();
    }
  }

  async getKeysets(options: CashuKeysetReadOptions = {}): Promise<unknown> {
    return this.getJson("/v1/keysets", options);
  }

  async getKeys(keysetId: string, options: CashuKeysetReadOptions = {}): Promise<unknown> {
    if (!KEYSET_ID_PATTERN.test(keysetId)) {
      throw invalidConfiguration();
    }
    return this.getJson(`/v1/keys/${keysetId}`, options);
  }

  private async getJson(path: string, options: CashuKeysetReadOptions): Promise<unknown> {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw invalidConfiguration();
    }
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      throw invalidConfiguration();
    }
    if (options.signal?.aborted) {
      throw new CashuMintKeysetHttpError("request_aborted", "Cashu keyset request was aborted.");
    }

    const endpoint = `${this.mintUrl}${path}`;
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
    const signal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]);

    try {
      const response = await raceWithAbort(
        this.fetch(endpoint, {
          cache: "no-store",
          credentials: "omit",
          headers: { accept: "application/json" },
          method: "GET",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal,
        }),
        signal,
      );
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        cancelResponseBody(response);
        throw new CashuMintKeysetHttpError(
          "invalid_response",
          "Cashu keyset response did not come from the requested endpoint.",
        );
      }
      if (!response.ok) {
        cancelResponseBody(response);
        throw new CashuMintKeysetHttpError(
          "unexpected_status",
          "Cashu keyset endpoint returned an unsuccessful status.",
          response.status,
        );
      }

      const body = await readBoundedResponseBody(response, this.maxResponseBytes, signal);
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new CashuMintKeysetHttpError(
          "invalid_response",
          "Cashu keyset endpoint returned invalid JSON.",
        );
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new CashuMintKeysetHttpError("request_aborted", "Cashu keyset request was aborted.");
      }
      if (timeoutController.signal.aborted) {
        throw new CashuMintKeysetHttpError("request_timeout", "Cashu keyset request timed out.");
      }
      if (error instanceof CashuMintKeysetHttpError) {
        throw error;
      }
      throw new CashuMintKeysetHttpError("network_error", "Cashu keyset endpoint is unavailable.");
    } finally {
      clearTimeout(timeout);
    }
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
    throw new CashuMintKeysetHttpError(
      "invalid_response",
      "Cashu keyset endpoint returned invalid text.",
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

function invalidConfiguration(): CashuMintKeysetHttpError {
  return new CashuMintKeysetHttpError(
    "invalid_configuration",
    "Cashu keyset HTTP client configuration is invalid.",
  );
}

function responseTooLarge(): CashuMintKeysetHttpError {
  return new CashuMintKeysetHttpError(
    "response_too_large",
    "Cashu keyset response exceeds the transport limit.",
  );
}

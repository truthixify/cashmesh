import { type UnixTimestamp, unixTimestamp } from "@cashmesh/domain";

import {
  type CashuKeysetSnapshotEntryInputV1,
  CashuKeysetSnapshotError,
  type CashuKeysetSnapshotV1,
  createCashuKeysetSnapshotV1,
  MAX_CASHU_KEYSETS_PER_SNAPSHOT,
} from "./keyset-snapshot";
import {
  type CashuKeysetReadOptions,
  CashuMintKeysetHttpError,
  type CashuMintKeysetSource,
} from "./mint-keyset-http-client";
import { normalizeCashuMintUrl } from "./mint-url";

export const MAX_CASHU_KEYSET_METADATA_ENTRIES = 256;
export const CASHU_KEYSET_OBSERVATION_CONCURRENCY = 4;

const KEYSET_ID_PATTERN = /^(?:00[0-9a-f]{14}|01[0-9a-f]{64})$/;
const UNIT_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const MAX_UNIT_LENGTH = 32;

interface KeysetMetadata {
  readonly active: boolean;
  readonly finalExpiry?: number;
  readonly id: string;
  readonly inputFeePpk: number;
  readonly unit: string;
}

export interface CashuKeysetObserverOptions {
  readonly clock?: () => number;
}

export interface ObserveCashuKeysetsInput {
  readonly signal?: AbortSignal;
  readonly unit: string;
}

export type CashuKeysetObservationErrorCode =
  | "invalid_clock"
  | "invalid_keyset_response"
  | "invalid_mint"
  | "invalid_observation_input"
  | "keyset_limit_exceeded"
  | "keyset_metadata_changed"
  | "keyset_response_mismatch"
  | "keyset_unit_not_found"
  | "observation_aborted"
  | "source_unavailable";

export class CashuKeysetObservationError extends Error {
  override readonly name = "CashuKeysetObservationError";

  constructor(
    readonly code: CashuKeysetObservationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class CashuKeysetObserver {
  private readonly clock: () => number;
  private readonly mintUrl: string;

  constructor(
    private readonly source: CashuMintKeysetSource,
    options: CashuKeysetObserverOptions = {},
  ) {
    try {
      this.mintUrl = normalizeCashuMintUrl(source.mintUrl);
    } catch {
      throw new CashuKeysetObservationError("invalid_mint", "Cashu keyset source mint is invalid.");
    }
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw invalidObservationInput();
    }
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
    if (typeof this.clock !== "function") {
      throw invalidObservationInput();
    }
  }

  async observe(input: ObserveCashuKeysetsInput): Promise<CashuKeysetSnapshotV1> {
    const unit = parseUnit(input);
    if (input.signal?.aborted) {
      throw observationAborted();
    }
    const startedAt = this.readClock();
    const observationController = new AbortController();
    const signal =
      input.signal === undefined
        ? observationController.signal
        : AbortSignal.any([input.signal, observationController.signal]);
    const requestOptions = { signal } satisfies CashuKeysetReadOptions;

    try {
      const initialMetadata = await this.readMetadata(unit, requestOptions, input.signal);
      const entries = await mapWithConcurrency(
        initialMetadata,
        CASHU_KEYSET_OBSERVATION_CONCURRENCY,
        async (metadata) => this.readKeyset(metadata, requestOptions, input.signal),
      );
      const finalMetadata = await this.readMetadata(unit, requestOptions, input.signal);
      if (!equalMetadata(initialMetadata, finalMetadata)) {
        throw new CashuKeysetObservationError(
          "keyset_metadata_changed",
          "Cashu keyset metadata changed during observation.",
        );
      }

      const observedAt = this.readClock();
      if (observedAt < startedAt) {
        throw new CashuKeysetObservationError(
          "invalid_clock",
          "Cashu keyset observation clock moved backwards.",
        );
      }
      try {
        return createCashuKeysetSnapshotV1({
          keysets: entries,
          mintUrl: this.mintUrl,
          observedAt,
        });
      } catch (error) {
        if (error instanceof CashuKeysetSnapshotError) {
          throw invalidKeysetResponse();
        }
        throw error;
      }
    } catch (error) {
      observationController.abort();
      throw error;
    }
  }

  private readClock(): UnixTimestamp {
    try {
      return unixTimestamp(this.clock());
    } catch {
      throw new CashuKeysetObservationError(
        "invalid_clock",
        "Cashu keyset observation clock is invalid.",
      );
    }
  }

  private async readMetadata(
    unit: string,
    options: CashuKeysetReadOptions,
    callerSignal: AbortSignal | undefined,
  ): Promise<readonly KeysetMetadata[]> {
    const response = await readSource(() => this.source.getKeysets(options), callerSignal);
    return parseMetadataResponse(response, unit);
  }

  private async readKeyset(
    metadata: KeysetMetadata,
    options: CashuKeysetReadOptions,
    callerSignal: AbortSignal | undefined,
  ): Promise<CashuKeysetSnapshotEntryInputV1> {
    const response = await readSource(
      () => this.source.getKeys(metadata.id, options),
      callerSignal,
    );
    return parseKeysResponse(response, metadata);
  }
}

function parseUnit(input: ObserveCashuKeysetsInput): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidObservationInput();
  }
  if (
    typeof input.unit !== "string" ||
    input.unit.length > MAX_UNIT_LENGTH ||
    input.unit !== input.unit.trim() ||
    !UNIT_PATTERN.test(input.unit)
  ) {
    throw invalidObservationInput();
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    throw invalidObservationInput();
  }
  return input.unit;
}

function parseMetadataResponse(value: unknown, unit: string): readonly KeysetMetadata[] {
  const response = objectRecord(value);
  if (response === undefined || !Array.isArray(response.keysets)) {
    throw invalidKeysetResponse();
  }
  if (response.keysets.length > MAX_CASHU_KEYSET_METADATA_ENTRIES) {
    throw new CashuKeysetObservationError(
      "keyset_limit_exceeded",
      "Cashu mint returned too many keyset metadata entries.",
    );
  }

  const selected: KeysetMetadata[] = [];
  const responseIds = new Set<string>();
  for (const value of response.keysets) {
    const entry = objectRecord(value);
    if (
      entry === undefined ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entry.id.length > 128 ||
      typeof entry.unit !== "string" ||
      entry.unit.length > MAX_UNIT_LENGTH ||
      !UNIT_PATTERN.test(entry.unit) ||
      responseIds.has(entry.id)
    ) {
      throw invalidKeysetResponse();
    }
    responseIds.add(entry.id);
    if (entry.unit !== unit) {
      continue;
    }
    const metadata = parseMetadata(entry);
    selected.push(metadata);
  }

  if (selected.length === 0) {
    throw new CashuKeysetObservationError(
      "keyset_unit_not_found",
      "Cashu mint did not return keysets for the requested unit.",
    );
  }
  if (selected.length > MAX_CASHU_KEYSETS_PER_SNAPSHOT) {
    throw new CashuKeysetObservationError(
      "keyset_limit_exceeded",
      "Cashu mint returned too many keysets for the requested unit.",
    );
  }

  selected.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return Object.freeze(selected);
}

function parseMetadata(value: Record<string, unknown>): KeysetMetadata {
  if (
    typeof value.id !== "string" ||
    !KEYSET_ID_PATTERN.test(value.id) ||
    typeof value.unit !== "string" ||
    value.unit.length > MAX_UNIT_LENGTH ||
    !UNIT_PATTERN.test(value.unit) ||
    typeof value.active !== "boolean"
  ) {
    throw invalidKeysetResponse();
  }
  const inputFeePpk = optionalNonNegativeInteger(value.input_fee_ppk, 0);
  const finalExpiry = optionalNonNegativeInteger(value.final_expiry, undefined);
  return Object.freeze({
    active: value.active,
    ...(finalExpiry !== undefined && finalExpiry !== 0 && { finalExpiry }),
    id: value.id,
    inputFeePpk,
    unit: value.unit,
  });
}

function parseKeysResponse(
  value: unknown,
  expected: KeysetMetadata,
): CashuKeysetSnapshotEntryInputV1 {
  const response = objectRecord(value);
  if (response === undefined || !Array.isArray(response.keysets) || response.keysets.length !== 1) {
    throw invalidKeysetResponse();
  }
  const keyset = objectRecord(response.keysets[0]);
  if (
    keyset === undefined ||
    keyset.id !== expected.id ||
    keyset.unit !== expected.unit ||
    objectRecord(keyset.keys) === undefined
  ) {
    throw keysetResponseMismatch();
  }
  if (keyset.active !== undefined && keyset.active !== expected.active) {
    throw keysetResponseMismatch();
  }
  if (
    keyset.input_fee_ppk !== undefined &&
    optionalNonNegativeInteger(keyset.input_fee_ppk, 0) !== expected.inputFeePpk
  ) {
    throw keysetResponseMismatch();
  }
  if (keyset.final_expiry !== undefined) {
    const responseExpiry = optionalNonNegativeInteger(keyset.final_expiry, undefined);
    const normalizedExpiry = responseExpiry === 0 ? undefined : responseExpiry;
    if (normalizedExpiry !== expected.finalExpiry) {
      throw keysetResponseMismatch();
    }
  }

  return Object.freeze({
    active: expected.active,
    ...(expected.finalExpiry !== undefined && { finalExpiry: expected.finalExpiry }),
    id: expected.id,
    inputFeePpk: expected.inputFeePpk,
    keys: keyset.keys as Record<string, string>,
    unit: expected.unit,
  });
}

function optionalNonNegativeInteger<T>(value: unknown, fallback: T): number | T {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidKeysetResponse();
  }
  return value as number;
}

function equalMetadata(left: readonly KeysetMetadata[], right: readonly KeysetMetadata[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.active === other.active &&
        entry.finalExpiry === other.finalExpiry &&
        entry.id === other.id &&
        entry.inputFeePpk === other.inputFeePpk &&
        entry.unit === other.unit
      );
    })
  );
}

async function readSource(
  read: () => Promise<unknown>,
  callerSignal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    return await read();
  } catch (error) {
    if (callerSignal?.aborted) {
      throw observationAborted();
    }
    if (error instanceof CashuKeysetObservationError || error instanceof CashuMintKeysetHttpError) {
      throw error;
    }
    throw new CashuKeysetObservationError(
      "source_unavailable",
      "Cashu keyset source is unavailable.",
    );
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await transform(value);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalidObservationInput(): CashuKeysetObservationError {
  return new CashuKeysetObservationError(
    "invalid_observation_input",
    "Cashu keyset observation input is invalid.",
  );
}

function invalidKeysetResponse(): CashuKeysetObservationError {
  return new CashuKeysetObservationError(
    "invalid_keyset_response",
    "Cashu mint returned invalid keyset data.",
  );
}

function keysetResponseMismatch(): CashuKeysetObservationError {
  return new CashuKeysetObservationError(
    "keyset_response_mismatch",
    "Cashu key response does not match its keyset metadata.",
  );
}

function observationAborted(): CashuKeysetObservationError {
  return new CashuKeysetObservationError(
    "observation_aborted",
    "Cashu keyset observation was aborted.",
  );
}

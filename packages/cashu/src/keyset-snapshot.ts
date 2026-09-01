import { type UnixTimestamp, unixTimestamp } from "@cashmesh/domain";
import { Keyset, pointFromHex } from "@cashu/cashu-ts";

import { normalizeCashuMintUrl } from "./mint-url";

export const CASHU_KEYSET_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const MAX_CASHU_KEYSETS_PER_SNAPSHOT = 64;
export const MAX_CASHU_KEYS_PER_KEYSET = 256;

const KEYSET_ID_PATTERN = /^(?:00[0-9a-f]{14}|01[0-9a-f]{64})$/;
const KEY_AMOUNT_PATTERN = /^[1-9][0-9]*$/;
const SECP_PUBLIC_KEY_PATTERN = /^(?:02|03)[0-9a-f]{64}$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_U64_DIGITS = 20;
const MAX_UNIT_LENGTH = 32;
const UNIT_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

export interface CashuKeysetSnapshotEntryInputV1 {
  readonly active: boolean;
  readonly finalExpiry?: number | null;
  readonly id: string;
  readonly inputFeePpk?: number | null;
  readonly keys: Readonly<Record<string, string>>;
  readonly unit: string;
}

export interface CashuKeysetSnapshotEntryV1 {
  readonly active: boolean;
  readonly finalExpiry?: UnixTimestamp;
  readonly id: string;
  readonly inputFeePpk: number;
  readonly keys: Readonly<Record<string, string>>;
  readonly unit: string;
}

export interface CreateCashuKeysetSnapshotInputV1 {
  readonly keysets: readonly CashuKeysetSnapshotEntryInputV1[];
  readonly mintUrl: string;
  readonly observedAt: number;
  readonly schemaVersion?: number;
}

export interface CashuKeysetSnapshotV1 {
  readonly keysets: readonly CashuKeysetSnapshotEntryV1[];
  readonly mintUrl: string;
  readonly observedAt: UnixTimestamp;
  readonly schemaVersion: typeof CASHU_KEYSET_SNAPSHOT_SCHEMA_VERSION;
}

export type CashuKeysetSnapshotErrorCode =
  | "duplicate_keyset"
  | "empty_keyset_set"
  | "invalid_keyset"
  | "invalid_mint"
  | "invalid_observed_at"
  | "invalid_snapshot"
  | "keyset_limit_exceeded"
  | "unsupported_keyset_version";

export class CashuKeysetSnapshotError extends Error {
  override readonly name = "CashuKeysetSnapshotError";

  constructor(
    readonly code: CashuKeysetSnapshotErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function createCashuKeysetSnapshotV1(
  input: CreateCashuKeysetSnapshotInputV1,
): CashuKeysetSnapshotV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CashuKeysetSnapshotError(
      "invalid_snapshot",
      "Cashu keyset snapshot input must be an object.",
    );
  }
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== CASHU_KEYSET_SNAPSHOT_SCHEMA_VERSION
  ) {
    throw new CashuKeysetSnapshotError(
      "invalid_snapshot",
      "Cashu keyset snapshot schema version is unsupported.",
    );
  }

  let mintUrl: string;
  try {
    mintUrl = normalizeCashuMintUrl(input.mintUrl);
  } catch {
    throw new CashuKeysetSnapshotError("invalid_mint", "Cashu keyset mint URL is invalid.");
  }

  let observedAt: UnixTimestamp;
  try {
    observedAt = unixTimestamp(input.observedAt);
  } catch {
    throw new CashuKeysetSnapshotError(
      "invalid_observed_at",
      "Cashu keyset observation time is invalid.",
    );
  }

  if (!Array.isArray(input.keysets)) {
    throw new CashuKeysetSnapshotError(
      "invalid_snapshot",
      "Cashu keyset snapshot entries must be an array.",
    );
  }
  if (input.keysets.length === 0) {
    throw new CashuKeysetSnapshotError(
      "empty_keyset_set",
      "Cashu keyset snapshot must contain at least one keyset.",
    );
  }
  if (input.keysets.length > MAX_CASHU_KEYSETS_PER_SNAPSHOT) {
    throw new CashuKeysetSnapshotError(
      "keyset_limit_exceeded",
      "Cashu keyset snapshot contains too many keysets.",
    );
  }

  const keysetIds = new Set<string>();
  const keysets = input.keysets.map((entry) => {
    const keyset = normalizeKeyset(entry);
    if (keysetIds.has(keyset.id)) {
      throw new CashuKeysetSnapshotError(
        "duplicate_keyset",
        "Cashu keyset snapshot contains a duplicate keyset.",
      );
    }
    keysetIds.add(keyset.id);
    return keyset;
  });
  keysets.sort((left, right) => {
    if (left.id < right.id) {
      return -1;
    }
    if (left.id > right.id) {
      return 1;
    }
    return 0;
  });

  return Object.freeze({
    keysets: Object.freeze(keysets),
    mintUrl,
    observedAt,
    schemaVersion: CASHU_KEYSET_SNAPSHOT_SCHEMA_VERSION,
  });
}

function normalizeKeyset(input: CashuKeysetSnapshotEntryInputV1): CashuKeysetSnapshotEntryV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidKeyset();
  }
  if (typeof input.id !== "string" || !KEYSET_ID_PATTERN.test(input.id)) {
    if (typeof input.id === "string" && /^(?:02[0-9a-f]{64}|[A-Za-z0-9+_/-]{12})$/.test(input.id)) {
      throw new CashuKeysetSnapshotError(
        "unsupported_keyset_version",
        "Cashu keyset version is not supported by this profile.",
      );
    }
    throw invalidKeyset();
  }
  if (
    typeof input.unit !== "string" ||
    input.unit.length > MAX_UNIT_LENGTH ||
    input.unit !== input.unit.trim() ||
    !UNIT_PATTERN.test(input.unit)
  ) {
    throw invalidKeyset();
  }
  if (typeof input.active !== "boolean") {
    throw invalidKeyset();
  }

  const inputFeePpk = input.inputFeePpk ?? 0;
  if (!Number.isSafeInteger(inputFeePpk) || inputFeePpk < 0) {
    throw invalidKeyset();
  }
  const finalExpiry = normalizeFinalExpiry(input.finalExpiry);
  const keys = normalizeKeys(input.keys);
  const keysetDto = {
    active: input.active,
    ...(finalExpiry !== undefined && { final_expiry: finalExpiry }),
    id: input.id,
    input_fee_ppk: inputFeePpk,
    keys,
    unit: input.unit,
  };
  if (!Keyset.verifyKeysetId(keysetDto)) {
    throw invalidKeyset();
  }

  return Object.freeze({
    active: input.active,
    ...(finalExpiry !== undefined && { finalExpiry }),
    id: input.id,
    inputFeePpk,
    keys,
    unit: input.unit,
  });
}

function normalizeFinalExpiry(value: number | null | undefined): UnixTimestamp | undefined {
  if (value === undefined || value === null || value === 0) {
    return undefined;
  }
  try {
    return unixTimestamp(value);
  } catch {
    throw invalidKeyset();
  }
}

function normalizeKeys(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidKeyset();
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_CASHU_KEYS_PER_KEYSET) {
    throw invalidKeyset();
  }

  const normalized = entries.map(([amount, publicKey]) => {
    if (
      amount.length > MAX_U64_DIGITS ||
      !KEY_AMOUNT_PATTERN.test(amount) ||
      BigInt(amount) > MAX_U64 ||
      typeof publicKey !== "string" ||
      publicKey.length !== 66
    ) {
      throw invalidKeyset();
    }
    const canonicalPublicKey = publicKey.toLowerCase();
    if (!SECP_PUBLIC_KEY_PATTERN.test(canonicalPublicKey)) {
      throw invalidKeyset();
    }
    try {
      pointFromHex(canonicalPublicKey);
    } catch {
      throw invalidKeyset();
    }
    return [amount, canonicalPublicKey] as const;
  });
  normalized.sort(([left], [right]) => (BigInt(left) < BigInt(right) ? -1 : 1));

  return Object.freeze(Object.fromEntries(normalized));
}

function invalidKeyset(): CashuKeysetSnapshotError {
  return new CashuKeysetSnapshotError("invalid_keyset", "Cashu keyset snapshot entry is invalid.");
}

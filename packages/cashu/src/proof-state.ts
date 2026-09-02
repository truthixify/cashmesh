import { type UnixTimestamp, unixTimestamp } from "@cashmesh/domain";

import { normalizeCashuMintUrl } from "./mint-url";
import { type CashuProofY, cashuProofY } from "./proof-reference";

export const CASHU_PROOF_STATE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const MAX_CASHU_PROOF_STATES_PER_SNAPSHOT = 128;

export type CashuProofStateValue = "PENDING" | "SPENT" | "UNSPENT";

export interface CashuProofStateEntryInputV1 {
  readonly state: string;
  readonly y: string;
}

export interface CashuProofStateEntryV1 {
  readonly state: CashuProofStateValue;
  readonly y: CashuProofY;
}

export interface CreateCashuProofStateSnapshotInputV1 {
  readonly mintUrl: string;
  readonly observedAt: number;
  readonly schemaVersion?: number;
  readonly states: readonly CashuProofStateEntryInputV1[];
}

export interface CashuProofStateSnapshotV1 {
  readonly mintUrl: string;
  readonly observedAt: UnixTimestamp;
  readonly schemaVersion: typeof CASHU_PROOF_STATE_SNAPSHOT_SCHEMA_VERSION;
  readonly states: readonly CashuProofStateEntryV1[];
}

export type CashuProofStateSnapshotErrorCode =
  | "duplicate_proof"
  | "empty_proof_set"
  | "invalid_mint"
  | "invalid_observed_at"
  | "invalid_proof_state"
  | "invalid_snapshot"
  | "proof_limit_exceeded";

export class CashuProofStateSnapshotError extends Error {
  override readonly name = "CashuProofStateSnapshotError";

  constructor(
    readonly code: CashuProofStateSnapshotErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function createCashuProofStateSnapshotV1(
  input: CreateCashuProofStateSnapshotInputV1,
): CashuProofStateSnapshotV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidSnapshot();
  }
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== CASHU_PROOF_STATE_SNAPSHOT_SCHEMA_VERSION
  ) {
    throw invalidSnapshot();
  }

  let mintUrl: string;
  try {
    mintUrl = normalizeCashuMintUrl(input.mintUrl);
  } catch {
    throw new CashuProofStateSnapshotError(
      "invalid_mint",
      "Cashu proof-state mint URL is invalid.",
    );
  }

  let observedAt: UnixTimestamp;
  try {
    observedAt = unixTimestamp(input.observedAt);
  } catch {
    throw new CashuProofStateSnapshotError(
      "invalid_observed_at",
      "Cashu proof-state observation time is invalid.",
    );
  }

  if (!Array.isArray(input.states)) {
    throw invalidSnapshot();
  }
  if (input.states.length === 0) {
    throw new CashuProofStateSnapshotError(
      "empty_proof_set",
      "Cashu proof-state snapshot must contain at least one proof.",
    );
  }
  if (input.states.length > MAX_CASHU_PROOF_STATES_PER_SNAPSHOT) {
    throw new CashuProofStateSnapshotError(
      "proof_limit_exceeded",
      "Cashu proof-state snapshot contains too many proofs.",
    );
  }

  const proofYs = new Set<CashuProofY>();
  const states = Array.from(input.states, (inputState) => {
    const state = createState(inputState);
    if (proofYs.has(state.y)) {
      throw new CashuProofStateSnapshotError(
        "duplicate_proof",
        "Cashu proof-state snapshot contains a duplicate proof.",
      );
    }
    proofYs.add(state.y);
    return state;
  });
  states.sort((left, right) => (left.y < right.y ? -1 : left.y > right.y ? 1 : 0));

  return Object.freeze({
    mintUrl,
    observedAt,
    schemaVersion: CASHU_PROOF_STATE_SNAPSHOT_SCHEMA_VERSION,
    states: Object.freeze(states),
  });
}

function createState(input: CashuProofStateEntryInputV1): CashuProofStateEntryV1 {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (input.state !== "UNSPENT" && input.state !== "PENDING" && input.state !== "SPENT") ||
    typeof input.y !== "string"
  ) {
    throw invalidProofState();
  }
  try {
    return Object.freeze({ state: input.state, y: cashuProofY(input.y) });
  } catch {
    throw invalidProofState();
  }
}

function invalidProofState(): CashuProofStateSnapshotError {
  return new CashuProofStateSnapshotError(
    "invalid_proof_state",
    "Cashu proof-state snapshot entry is invalid.",
  );
}

function invalidSnapshot(): CashuProofStateSnapshotError {
  return new CashuProofStateSnapshotError(
    "invalid_snapshot",
    "Cashu proof-state snapshot input is invalid.",
  );
}

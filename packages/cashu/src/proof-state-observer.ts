import { type UnixTimestamp, unixTimestamp } from "@cashmesh/domain";

import {
  CashuMintProofStateHttpError,
  type CashuMintProofStateSource,
  type CashuProofStateReadOptions,
} from "./mint-proof-state-http-client";
import { normalizeCashuMintUrl } from "./mint-url";
import { type CashuProofReferenceV1, createCashuProofReferenceV1 } from "./proof-reference";
import {
  type CashuProofStateEntryInputV1,
  CashuProofStateSnapshotError,
  type CashuProofStateSnapshotV1,
  createCashuProofStateSnapshotV1,
  MAX_CASHU_PROOF_STATES_PER_SNAPSHOT,
} from "./proof-state";

export interface CashuProofStateObserverOptions {
  readonly clock?: () => number;
}

export interface ObserveCashuProofStatesInput {
  readonly proofReferences: readonly CashuProofReferenceV1[];
  readonly signal?: AbortSignal;
}

export type CashuProofStateObservationErrorCode =
  | "invalid_clock"
  | "invalid_mint"
  | "invalid_observation_input"
  | "invalid_state_response"
  | "observation_aborted"
  | "proof_limit_exceeded"
  | "source_unavailable"
  | "state_response_mismatch";

export class CashuProofStateObservationError extends Error {
  override readonly name = "CashuProofStateObservationError";

  constructor(
    readonly code: CashuProofStateObservationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class CashuProofStateObserver {
  private readonly clock: () => number;
  readonly mintUrl: string;

  constructor(
    private readonly source: CashuMintProofStateSource,
    options: CashuProofStateObserverOptions = {},
  ) {
    try {
      this.mintUrl = normalizeCashuMintUrl(source.mintUrl);
    } catch {
      throw new CashuProofStateObservationError(
        "invalid_mint",
        "Cashu proof-state source mint is invalid.",
      );
    }
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw invalidObservationInput();
    }
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
    if (typeof this.clock !== "function") {
      throw invalidObservationInput();
    }
  }

  async observe(input: ObserveCashuProofStatesInput): Promise<CashuProofStateSnapshotV1> {
    const references = validateInput(input);
    if (input.signal?.aborted) {
      throw observationAborted();
    }
    const startedAt = this.readClock();
    const requestOptions = {
      ...(input.signal !== undefined && { signal: input.signal }),
    } satisfies CashuProofStateReadOptions;
    const response = await readSource(
      () =>
        this.source.checkProofStates(
          references.map((proof) => proof.y),
          requestOptions,
        ),
      input.signal,
    );
    const states = parseStateResponse(response, references);
    const observedAt = this.readClock();
    if (observedAt < startedAt) {
      throw new CashuProofStateObservationError(
        "invalid_clock",
        "Cashu proof-state observation clock moved backwards.",
      );
    }
    try {
      return createCashuProofStateSnapshotV1({
        mintUrl: this.mintUrl,
        observedAt,
        states,
      });
    } catch (error) {
      if (error instanceof CashuProofStateSnapshotError) {
        throw invalidStateResponse();
      }
      throw error;
    }
  }

  private readClock(): UnixTimestamp {
    try {
      return unixTimestamp(this.clock());
    } catch {
      throw new CashuProofStateObservationError(
        "invalid_clock",
        "Cashu proof-state observation clock is invalid.",
      );
    }
  }
}

function validateInput(input: ObserveCashuProofStatesInput): readonly CashuProofReferenceV1[] {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !Array.isArray(input.proofReferences) ||
    input.proofReferences.length === 0 ||
    (input.signal !== undefined && !(input.signal instanceof AbortSignal))
  ) {
    throw invalidObservationInput();
  }
  if (input.proofReferences.length > MAX_CASHU_PROOF_STATES_PER_SNAPSHOT) {
    throw new CashuProofStateObservationError(
      "proof_limit_exceeded",
      "Cashu proof-state observation contains too many proofs.",
    );
  }
  try {
    const proofYs = new Set<string>();
    const references = Array.from(input.proofReferences, (proof) => {
      const reference = createCashuProofReferenceV1(proof);
      if (proofYs.has(reference.y)) {
        throw invalidObservationInput();
      }
      proofYs.add(reference.y);
      return reference;
    });
    references.sort((left, right) => (left.y < right.y ? -1 : left.y > right.y ? 1 : 0));
    return Object.freeze(references);
  } catch (error) {
    if (error instanceof CashuProofStateObservationError) {
      throw error;
    }
    throw invalidObservationInput();
  }
}

function parseStateResponse(
  value: unknown,
  references: readonly CashuProofReferenceV1[],
): readonly CashuProofStateEntryInputV1[] {
  const response = objectRecord(value);
  if (response === undefined || !Array.isArray(response.states)) {
    throw invalidStateResponse();
  }
  if (response.states.length !== references.length) {
    throw stateResponseMismatch();
  }
  return Array.from(response.states, (value, index) => {
    const state = objectRecord(value);
    const expected = references[index];
    if (state === undefined || expected === undefined || state.Y !== expected.y) {
      throw stateResponseMismatch();
    }
    if (
      (state.state !== "UNSPENT" && state.state !== "PENDING" && state.state !== "SPENT") ||
      (state.witness !== undefined && state.witness !== null && typeof state.witness !== "string")
    ) {
      throw invalidStateResponse();
    }
    return Object.freeze({ state: state.state, y: expected.y });
  });
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
    if (
      error instanceof CashuProofStateObservationError ||
      error instanceof CashuMintProofStateHttpError
    ) {
      throw error;
    }
    throw new CashuProofStateObservationError(
      "source_unavailable",
      "Cashu proof-state source is unavailable.",
    );
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalidObservationInput(): CashuProofStateObservationError {
  return new CashuProofStateObservationError(
    "invalid_observation_input",
    "Cashu proof-state observation input is invalid.",
  );
}

function invalidStateResponse(): CashuProofStateObservationError {
  return new CashuProofStateObservationError(
    "invalid_state_response",
    "Cashu mint returned invalid proof-state data.",
  );
}

function stateResponseMismatch(): CashuProofStateObservationError {
  return new CashuProofStateObservationError(
    "state_response_mismatch",
    "Cashu proof-state response does not match the requested proofs.",
  );
}

function observationAborted(): CashuProofStateObservationError {
  return new CashuProofStateObservationError(
    "observation_aborted",
    "Cashu proof-state observation was aborted.",
  );
}

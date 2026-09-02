import { createHash } from "node:crypto";
import {
  CASHU_STELLAR_MELT_QUOTE_SCHEMA_VERSION,
  type CashuStellarMeltQuoteRequestV1,
  type CashuStellarMeltQuoteState,
  type CashuStellarMeltQuoteV1,
  createCashuStellarMeltQuoteRequestV1,
  createCashuStellarMeltQuoteV1,
  MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS,
  normalizeCashuMintUrl,
} from "@cashmesh/cashu";
import {
  type InvoiceId,
  invoiceId,
  type OperatorId,
  operatorId,
  type PaymentId,
  paymentId,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";

import {
  CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
  type CashuStellarMeltQuoteAttemptId,
  cashuStellarMeltQuoteAttemptId,
} from "./cashu-stellar-melt-quote-repository";

export interface CashuStellarMeltQuoteAttemptRecord {
  readonly amount: string;
  readonly attempt_fingerprint: string;
  readonly attempt_id: string;
  readonly invoice_id: string;
  readonly method: string;
  readonly mint_url: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly request: string;
  readonly schema_version: number;
  readonly started_at: string;
  readonly unit: string;
}

export interface CashuStellarMeltQuoteOutcomeRecord {
  readonly ambiguity_reason: string | null;
  readonly attempt_id: string;
  readonly expiry: string | null;
  readonly fee_reserve: string | null;
  readonly mint_url: string;
  readonly outcome_fingerprint: string;
  readonly outcome_kind: string;
  readonly payment_id: string;
  readonly quote_id: string | null;
  readonly recorded_at: string;
  readonly schema_version: number;
}

export interface CashuStellarMeltQuoteObservationRecord {
  readonly attempt_id: string;
  readonly mint_url: string;
  readonly observed_at: string;
  readonly payment_id: string;
  readonly quote_id: string;
  readonly schema_version: number;
  readonly snapshot_fingerprint: string;
  readonly state: string;
}

export interface StoredCashuStellarMeltQuoteAttempt {
  readonly attemptFingerprint: string;
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly invoiceId: InvoiceId;
  readonly mintUrl: string;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly request: CashuStellarMeltQuoteRequestV1;
  readonly schemaVersion: typeof CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION;
  readonly startedAt: UnixTimestamp;
}

export interface StoredCashuStellarMeltQuotedEvidence {
  readonly attempt: StoredCashuStellarMeltQuoteAttempt;
  readonly observations: readonly CashuStellarMeltQuoteV1[];
  readonly recordedAt: UnixTimestamp;
}

export function mapCashuStellarMeltQuoteAttemptRecord(
  row: CashuStellarMeltQuoteAttemptRecord,
): StoredCashuStellarMeltQuoteAttempt {
  const request = createCashuStellarMeltQuoteRequestV1({
    amount: parseSafeInteger(row.amount),
    request: row.request,
  });
  const attempt = {
    attemptId: cashuStellarMeltQuoteAttemptId(row.attempt_id),
    invoiceId: invoiceId(row.invoice_id),
    mintUrl: normalizeCashuMintUrl(row.mint_url),
    operatorId: operatorId(row.operator_id),
    paymentId: paymentId(row.payment_id),
    request,
    schemaVersion: CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
    startedAt: unixTimestamp(parseSafeInteger(row.started_at)),
  };
  if (
    row.schema_version !== CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION ||
    row.method !== request.method ||
    row.unit !== request.unit ||
    row.mint_url !== attempt.mintUrl ||
    createCashuStellarMeltQuoteAttemptFingerprint(attempt) !== row.attempt_fingerprint
  ) {
    throw new Error("Stored Cashu Stellar melt quote attempt is invalid.");
  }
  return Object.freeze({ ...attempt, attemptFingerprint: row.attempt_fingerprint });
}

export function createCashuStellarMeltQuoteAttemptFingerprint(
  attempt: Omit<StoredCashuStellarMeltQuoteAttempt, "attemptFingerprint">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        amount: attempt.request.amount,
        attemptId: attempt.attemptId,
        invoiceId: attempt.invoiceId,
        method: attempt.request.method,
        mintUrl: attempt.mintUrl,
        operatorId: attempt.operatorId,
        paymentId: attempt.paymentId,
        request: attempt.request.request,
        schemaVersion: attempt.schemaVersion,
        startedAt: attempt.startedAt,
        unit: attempt.request.unit,
      }),
    )
    .digest("hex");
}

export function mapCashuStellarMeltQuotedEvidenceRecord(
  attemptRow: CashuStellarMeltQuoteAttemptRecord,
  outcome: CashuStellarMeltQuoteOutcomeRecord,
  observationRows: readonly CashuStellarMeltQuoteObservationRecord[],
): StoredCashuStellarMeltQuotedEvidence {
  const attempt = mapCashuStellarMeltQuoteAttemptRecord(attemptRow);
  if (
    outcome.attempt_id !== attempt.attemptId ||
    outcome.payment_id !== attempt.paymentId ||
    outcome.mint_url !== attempt.mintUrl ||
    outcome.schema_version !== attempt.schemaVersion ||
    outcome.outcome_kind !== "quoted" ||
    outcome.ambiguity_reason !== null ||
    outcome.quote_id === null
  ) {
    throw new Error("Stored Cashu Stellar melt quoted outcome is invalid.");
  }

  const recordedAt = unixTimestamp(parseSafeInteger(outcome.recorded_at));
  const expiry = parseSafeInteger(outcome.expiry ?? "");
  const feeReserve = parseSafeInteger(outcome.fee_reserve ?? "");
  const observations = observationRows.map((row) =>
    mapCashuStellarMeltQuoteObservationRecord(attempt, outcome, row, expiry, feeReserve),
  );
  const first = observations[0];
  if (
    first === undefined ||
    first.observedAt !== recordedAt ||
    first.state !== "UNPAID" ||
    recordedAt < attempt.startedAt ||
    first.expiry <= first.observedAt ||
    first.expiry - attempt.startedAt > MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS ||
    createCashuStellarMeltQuotedOutcomeFingerprint(attempt, first) !== outcome.outcome_fingerprint
  ) {
    throw new Error("Stored Cashu Stellar melt quoted outcome is invalid.");
  }
  for (let position = 1; position < observations.length; position += 1) {
    const previous = observations[position - 1];
    const current = observations[position];
    if (
      previous === undefined ||
      current === undefined ||
      current.observedAt <= previous.observedAt ||
      (previous.state === "PAID" && current.state !== "PAID")
    ) {
      throw new Error("Stored Cashu Stellar melt quote observation history is invalid.");
    }
  }
  return Object.freeze({
    attempt,
    observations: Object.freeze(observations),
    recordedAt,
  });
}

export function createCashuStellarMeltQuotedOutcomeFingerprint(
  attempt: StoredCashuStellarMeltQuoteAttempt,
  quote: CashuStellarMeltQuoteV1,
): string {
  return sha256({
    amount: quote.amount,
    attemptFingerprint: attempt.attemptFingerprint,
    attemptId: attempt.attemptId,
    expiry: quote.expiry,
    feeReserve: quote.feeReserve,
    kind: "quoted",
    method: quote.method,
    mintUrl: quote.mintUrl,
    paymentId: attempt.paymentId,
    quoteId: quote.quoteId,
    recordedAt: quote.observedAt,
    request: quote.request,
    schemaVersion: attempt.schemaVersion,
    unit: quote.unit,
  });
}

export function createCashuStellarMeltQuoteObservationFingerprint(
  attempt: StoredCashuStellarMeltQuoteAttempt,
  quote: CashuStellarMeltQuoteV1,
): string {
  return sha256({
    amount: quote.amount,
    attemptId: attempt.attemptId,
    expiry: quote.expiry,
    feeReserve: quote.feeReserve,
    method: quote.method,
    mintUrl: quote.mintUrl,
    observedAt: quote.observedAt,
    operatorId: attempt.operatorId,
    paymentId: attempt.paymentId,
    quoteId: quote.quoteId,
    request: quote.request,
    schemaVersion: quote.schemaVersion,
    state: quote.state,
    unit: quote.unit,
  });
}

function mapCashuStellarMeltQuoteObservationRecord(
  attempt: StoredCashuStellarMeltQuoteAttempt,
  outcome: CashuStellarMeltQuoteOutcomeRecord,
  row: CashuStellarMeltQuoteObservationRecord,
  expiry: number,
  feeReserve: number,
): CashuStellarMeltQuoteV1 {
  if (
    row.attempt_id !== attempt.attemptId ||
    row.payment_id !== attempt.paymentId ||
    row.mint_url !== attempt.mintUrl ||
    row.quote_id !== outcome.quote_id ||
    row.schema_version !== CASHU_STELLAR_MELT_QUOTE_SCHEMA_VERSION
  ) {
    throw new Error("Stored Cashu Stellar melt quote observation is invalid.");
  }
  const quote = createCashuStellarMeltQuoteV1({
    amount: attempt.request.amount,
    expiry,
    feeReserve,
    method: attempt.request.method,
    mintUrl: attempt.mintUrl,
    observedAt: parseSafeInteger(row.observed_at),
    quoteId: row.quote_id,
    request: attempt.request.request,
    schemaVersion: row.schema_version,
    state: parseQuoteState(row.state),
    unit: attempt.request.unit,
  });
  if (
    createCashuStellarMeltQuoteObservationFingerprint(attempt, quote) !== row.snapshot_fingerprint
  ) {
    throw new Error("Stored Cashu Stellar melt quote observation fingerprint is invalid.");
  }
  return quote;
}

function parseQuoteState(value: string): CashuStellarMeltQuoteState {
  if (value !== "UNPAID" && value !== "PENDING" && value !== "PAID") {
    throw new Error("Stored Cashu Stellar melt quote state is invalid.");
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseSafeInteger(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Stored integer field is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Stored integer field exceeds safe bounds.");
  }
  return parsed;
}

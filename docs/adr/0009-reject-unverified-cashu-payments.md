# ADR-0009: Reject Unverified Cashu Payment Payloads

**Status:** Accepted

**Date:** 2026-09-01

## Context

NUT-18 HTTP transport sends a JSON `PaymentRequestPayload` containing an invoice identifier, mint,
unit, and bearer proofs. The payee must validate those proofs before accepting the payment. Normal
JavaScript JSON parsing can also lose precision for proof amounts above the safe-integer limit, and an
unbounded proof array creates a resource-exhaustion path before operator validation begins.

CashMesh has durable invoice and request issuance but does not yet have keyset discovery, input-fee
calculation, DLEQ validation, proof reservation, spent-state observation, operator redemption, or the
atomic paid-invoice journal transaction. Returning a successful HTTP status before those boundaries
exist would tell a wallet that an unverified bearer transfer completed.

## Decision

Expose `POST /v1/cashu/payments` with an encapsulated raw `application/json` parser. Limit the body to
64 KiB and 128 proofs. Decode the raw text through the pinned cashu-ts NUT-18 decoder, sum proof amounts
with exact integers, enforce CashMesh safe-integer bounds, normalize the HTTPS mint URL, and return only
an immutable envelope containing invoice ID, mint, unit, proof count, and gross amount. Do not return,
persist, or log memo, secret, signature, DLEQ, witness, or undeclared fields.

Resolve the globally unique invoice ID and bind the envelope to the persisted request. Enforce the
server clock against `[createdAt, expiresAt)`, exact unit, strict mint allowlist, and the necessary but
insufficient condition that gross proof value is at least the invoice amount.

Every request remains non-accepting. A payload that passes these checks returns
`503 proof_validation_unavailable`; no path returns 2xx, reserves a proof, calls an operator, changes
invoice state, or credits a merchant. Parser and semantic failures return explicit non-success statuses
without echoing payload data.

## Consequences

- The advertised HTTP path understands the standard NUT-18 payload without pretending checkout works.
- Existing invoice and policy routes keep normal JSON parsing; the precision-preserving parser is
  encapsulated to the bearer-proof route.
- Unknown payer metadata is discarded and bearer fields do not cross the adapter boundary.
- Gross amount validation rejects definite underpayment but cannot establish net value because input
  fees and keyset data are not loaded.
- A wallet integration can exercise delivery and rejection behavior, but no locally issued request is
  payable yet.
- The next acceptance capability must durably reserve proof secrets before any network effect and
  atomically commit verified payment, invoice state, and the balanced merchant journal.

## Revisit When

Replace the terminal rejection only when keyset and DLEQ validation, exact input fees, spent-state
handling, proof reservation, operator settlement, replay constraints, and accounting persistence are
implemented with restart and ambiguity tests. Revisit the resource bounds only with measured wallet
interoperability evidence.

ADR-0010 adds deterministic offline keyset, DLEQ, and input-fee validation without changing this
endpoint's terminal rejection.

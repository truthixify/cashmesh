# ADR-0014: Observe Cashu Proof State Through a Bounded Read Client

**Status:** Accepted

**Date:** 2026-09-02

## Context

Offline signature and DLEQ validation proves that a configured mint signed a Cashu proof, while local
proof-reference reservation prevents two CashMesh payments from claiming the same `(mint URL, Y)`.
Neither establishes the proof state currently asserted by the mint. NUT-07 exposes that assertion at
`POST /v1/checkstate` and defines `UNSPENT`, `PENDING`, and `SPENT` states for the submitted proof
points.

The query is privacy-sensitive even though it contains no bearer proof: a mint sees the exact `Y`
values queried together and the observation time. The response is also untrusted network input. It can
be oversized, malformed, redirected, reordered, stalled, or include a spending-condition witness that
CashMesh does not need at this boundary. An `UNSPENT` response can become stale immediately, and a
dishonest or faulty mint can report an incorrect state.

## Decision

Define a `CashuMintProofStateSource` port in `packages/cashu` that accepts only proof `Y` values. The
observer accepts previously sanitized proof references, validates and sorts at most 128 unique curve
points, and submits no amount, keyset ID, secret, signature, DLEQ value, witness, invoice identifier,
merchant identifier, or raw payload.

Provide a concrete HTTP client for one server-owned, normalized HTTPS mint URL. It sends one
credential-free JSON `POST` to the exact `/v1/checkstate` path with `{ "Ys": [...] }`. Disable
redirects, cache reuse, ambient credentials, and referrer metadata. Make no automatic retry and attach
no NUT-21 or NUT-22 credential. Apply a five-second default timeout with a 30-second hard ceiling and a
256 KiB default response limit with a one MiB hard ceiling, including chunked response bodies.

Require the response to contain exactly one state for each requested `Y`, in request order as required
by NUT-07. Reject missing, additional, reordered, or substituted entries and any state outside
`UNSPENT`, `PENDING`, or `SPENT`. Accept a missing, null, or string witness only to validate the wire
shape, then discard it. Timestamp the immutable version `1` snapshot only after the complete response
has been validated and reject a clock that moved backwards.

This capability is a read-only observation. Do not persist or schedule it, submit bearer proofs,
change a local reservation, infer a reservation release, call a swap or melt endpoint, transition an
invoice, write a merchant journal, or enable a successful payment response.

## Consequences

- A successful snapshot records the exact state asserted by one configured mint for one bounded proof
  set at the completion time; it does not prove mint honesty, solvency, future state, or payment.
- Deterministic ordering makes response binding reviewable, but querying a group of `Y` values reveals
  that grouping and timing to the mint. The request and snapshot must not enter logs, metrics, traces,
  support artifacts, or merchant-facing responses.
- A `PENDING` response is not authority to release or consume the sticky local reservation. Ambiguous
  operator effects still require a later explicit recovery state machine.
- A direct caller can distinguish sanitized transport and protocol failures, while no response body or
  underlying network error is included in those failures.
- Mocked transport tests establish bounds and parsing behavior without contacting a live mint or
  demonstrating redemption.

## Revisit When

Add durable proof-state evidence with explicit freshness and allowed-transition rules before wiring
the observer into payment orchestration. Design encrypted bearer-proof custody and operator effects
separately. The reservation lifecycle must define pre-dispatch cancellation, pending and ambiguous
effects, confirmed consumption, and evidence-backed release before an invoice can become paid. Review
NUT-21 and NUT-22 authentication in a separate credential-handling decision before protected mints are
supported.

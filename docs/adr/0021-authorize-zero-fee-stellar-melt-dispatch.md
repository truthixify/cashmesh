# ADR-0021: Authorize Bounded Zero-Fee Stellar Melt Dispatch

**Status:** Accepted

**Date:** 2026-09-02

## Context

CashMesh can validate and encrypt bearer proofs, persist one Stellar melt quote attempt, and bind a
fresh lifecycle effect to matching `UNPAID` quote evidence. It still needs a narrow operator adapter
that turns those already validated records into the exact NUT-05 execution request. Allowing that
adapter to send before the lifecycle write would make a process crash indistinguishable from an
unrecorded payout and would let replay create another remote effect.

NUT-05 requires the input proofs to cover the quote amount, its fee reserve, and NUT-02 input fees.
When a fee reserve can produce change, NUT-08 recovery requires the client to retain the corresponding
blinding data. CashMesh has no durable blinded-output record yet. Sending extra value without that
record could make recoverable e-cash inaccessible after a crash.

## Decision

Add a bounded `stellar` melt execution client for one configured HTTPS mint. It sends one exact
`POST /v1/melt/stellar` request containing the quote ID, canonically ordered proof inputs, and
`prefer_async: true`. It omits credentials, referrers, redirects, automatic retries, DLEQ values,
witnesses, and outputs. Time and response bytes are bounded.

Require an `UNPAID`, unexpired quote whose mint and unit match the live custody bundle. Accept only a
zero fee reserve. Require the proof total to equal the quote amount plus the explicit, previously
validated NUT-02 input fee exactly. The future coordinator remains responsible for loading that fee
from the payment's validated keyset evidence rather than accepting it from an HTTP caller.

Compute a SHA-256 dispatch fingerprint over a domain-separated canonical record containing the exact
normalized endpoint, HTTP method, and request-body bytes. Expose only that fingerprint and redacted
quote identity to an authorization callback. The callback must return exactly `true` before the client
can call the mint. The coordinator may return `true` only after a lifecycle `startEffect` call inserts
a matching effect with `replayed: false`; replay is recovery-only.

Recheck cancellation, clock monotonicity, and quote expiry after authorization and before the network
call. Treat every request as a single attempt. A timeout, abort, invalid response, unsuccessful HTTP
status, or clock failure after authorization does not permit another call. The coordinator must retain
the effect and persist pending or attention state while recovery observes the quote and proofs.

Project a successful response onto the complete common quote fields, require immutable terms to match,
discard payment preimages and undeclared fields, and reject nonempty change. `UNPAID`, `PENDING`, and
`PAID` remain operator observations; none alone marks a merchant invoice paid or proves exact proof
consumption.

## Consequences

- Bearer proofs are projected through a package-private callback and never added to the root package
  API, dispatch metadata, result, error text, or telemetry.
- The request fingerprint is deterministic for the exact mint, quote, and ordered proof bundle.
- An authorization refusal occurs before this adapter's mint call; any failure after authorization
  must be handled conservatively even when the adapter knows it did not reach `fetch`.
- Zero rail fee is a temporary safety boundary, not a claim that Stellar settlement has no cost.
- The adapter is dispatch-capable if invoked with real bearer proofs. The acquirer API does not yet
  invoke it, authenticate a protected mint, coordinate lifecycle transitions, or accept payment.
- Mocked HTTP tests prove request construction and failure behavior, not compatibility with a running
  mint or movement of funded value.

## Revisit When

Add durable NUT-08 blinded outputs and change recovery before accepting a nonzero fee reserve. Add
protected-mint authentication only through a separately reviewed credential boundary. Automatic retry
requires an operator-advertised, independently verified idempotency contract such as an applicable
NUT-19 profile; ordinary transport failure is not sufficient.

The next dependency-ordered capability is the acquirer melt coordinator that loads quote, fee,
lifecycle, and custody state; authorizes only a fresh effect; and records every returned or ambiguous
outcome without retry.

## References

- [ADR-0016: Manage Cashu Proof-Reservation Lifecycle](0016-manage-cashu-proof-reservation-lifecycle.md)
- [ADR-0017: Protect Cashu Bearer Proofs in Encrypted Custody](0017-protect-cashu-bearer-proof-custody.md)
- [ADR-0018: Bind Stellar Melt Quote Terms Before Dispatch](0018-bound-stellar-melt-quotes.md)
- [ADR-0020: Require Quote Evidence for Melt Effects](0020-require-quote-evidence-for-melt-effects.md)
- [Cashu NUT-02 keyset fees](https://github.com/cashubtc/nuts/blob/main/02.md)
- [Cashu NUT-05 melt quotes and execution](https://github.com/cashubtc/nuts/blob/main/05.md)
- [Cashu NUT-08 fee-return change](https://github.com/cashubtc/nuts/blob/main/08.md)
- [Cashu NUT-19 cached responses](https://github.com/cashubtc/nuts/blob/main/19.md)

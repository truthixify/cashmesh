# ADR-0018: Bind Stellar Melt Quote Terms Before Dispatch

**Status:** Accepted

**Date:** 2026-09-02

## Context

CashMesh can reserve and encrypt Cashu proofs and can persist a melt effect with a quote identifier and
expiry. It still needs a controlled way to obtain that quote from the selected operator. Current
NUT-05 separates custom-method quote creation and checking from the later request that presents bearer
proofs. Treating those operations as one step would expose proofs before the quote terms are validated
and would mix recoverable quote state with payout dispatch.

Quote creation is itself remote state. Repeating it after a timeout can create abandoned duplicate
quotes, while accepting changed amount, request, fee, unit, method, or expiry fields during a later
check could rebind a local effect. A quote state is also only a mint assertion: `PAID` does not prove
that the exact reserved inputs are spent, and `UNPAID` before expiry does not prove they are releasable.
NUT-08 change is recovery-critical when it exists, but CashMesh does not yet create or persist the
matching blinded-output state.

## Decision

Add a versioned Stellar melt-quote model and a bounded client for one server-configured Cashu mint.
The client uses only `POST /v1/melt/quote/stellar` and
`GET /v1/melt/quote/stellar/{quote_id}`. It sends no credentials, follows no redirects, applies time
and response-size limits, supports caller cancellation, and never retries automatically. NUT-19
response caching is not assumed or used.

Validate quote requests against the experimental CashMesh testnet profile before network access:
method `stellar`, unit `usdc`, 1 through 25,000 integer cents, the exact testnet network passphrase and
Circle testnet USDC issuer, the supported SEP-0007 parameter set, an exact-cent decimal amount, and a
checksum-valid Stellar account or muxed-account destination. Preserve the original URI bytes for
request and response binding. Merchant or settlement configuration remains responsible for choosing
the destination; syntactic validity does not authorize an arbitrary payout address.

Require a newly created response to contain the current NUT-05 common fields, a canonical UUIDv7 quote
identifier, the exact method, unit, request, and amount, a nonnegative safe-integer fee reserve or its
defined zero default, `UNPAID` state, and a future expiry no more than 900 seconds after creation. CDK
`0.18.0-rc.3` generates UUIDv7 identifiers for new quotes. Older injected UUID fixtures are not
accepted at this new observation boundary.

Check a quote only from its complete prior validated snapshot. The quote identifier, request, amount,
fee reserve, method, unit, mint, and expiry are immutable. `PENDING` may return to `UNPAID` after a
failed attempt, but an observed `PAID` state is terminal for this client. Drop undeclared and
method-specific response fields, including payment preimages. Reject any nonempty NUT-08 change rather
than lose value without the output data needed to unblind and recover it.

The client does not persist quote creation intent or snapshots, apply operator fee policy, authenticate
a protected mint, access bearer custody, create NUT-08 outputs, execute a melt, consume or release a
reservation, transition an invoice, or write a merchant journal. A later coordinator must durably bind
the validated quote to one reservation and effect before decrypting proofs.

## Consequences

- Quote terms can be reviewed and persisted before any bearer value is exposed to the operator.
- A timeout can leave an unused quote at the mint. The caller must observe or abandon that attempt; it
  must not turn an uncertain creation into an automatic second POST.
- Strict current-field and UUIDv7 validation intentionally rejects older or nonconforming mint
  responses, including responses that omit `method`.
- The mint learns the Stellar destination, amount, request metadata, timing, and later quote checks.
  Quote identifiers and full SEP-0007 requests are correlation-sensitive and must not enter telemetry.
- A fee reserve is recorded as an operator quote term, not accepted as merchant policy. Caps and fee
  disclosure remain coordinator responsibilities.
- `PAID` remains insufficient for accounting. Consumption still requires matching effect evidence and
  a later exact all-`SPENT` NUT-07 snapshot.

## Revisit When

Add durable quote creation and observation storage, protected-mint authentication, or the melt dispatch
coordinator. NUT-08 output data must be persisted before a request can produce change. Enable a retry
only after the exact endpoint and request are durably identified and the selected mint explicitly
advertises compatible NUT-19 caching semantics.

## References

- [Cashu NUT-05 melt quotes and execution](https://github.com/cashubtc/nuts/blob/main/05.md)
- [Cashu NUT-08 fee-return change](https://github.com/cashubtc/nuts/blob/main/08.md)
- [Cashu NUT-19 cached responses](https://github.com/cashubtc/nuts/blob/main/19.md)
- [SEP-0007 URI scheme](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md)

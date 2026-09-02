# ADR-0023: Atomically Account Confirmed Stellar Melt Payments

**Status:** Accepted

**Date:** 2026-09-02

## Context

CashMesh can persist an issued invoice, validated proof reservation, encrypted bearer custody,
Stellar melt quote history, one durable operator effect, and exact NUT-07 proof-state observations.
The melt coordinator may return a `PAID` observation, but that observation alone does not establish
which reserved proofs were spent or create a merchant liability. Conversely, recording a consumed
lifecycle before its paid invoice and journal would delete current custody without durable merchant
accounting.

The current custom `stellar` profile is pinned to testnet Circle USDC. A caller-selected ledger asset
would permit an otherwise valid melt to be mislabeled. Trusted-hold swap success also cannot be
accepted yet because CashMesh has no durable custody model for the replacement proofs returned by a
NUT-03 swap.

## Decision

Add one internal PostgreSQL repository operation for immediate-conversion Stellar melts. It requires
the exact effect-bound quote observation to be persisted as `PAID` and an exact all-`SPENT` snapshot
for the reserved proof set. The proof observation must be at or after the `PAID` observation, at or
before the lifecycle event time, and before the invoice expiry. The issued route must be
`immediate_conversion`. Acceptance reconstructs the complete stored quote attempt and verifies its
schema, request, method, unit, amount, network, asset, identities, and fingerprint before trusting the
observation.

Bind each newly issued request to the exact ordered route policy with a SHA-256 fingerprint covering
the invoice, encoded request, transport, and every route's operator, mint, mode, tier, and reason.
Acceptance reconstructs the issued request and verifies that fingerprint before using a normalized
route. Store the expected route count and reject post-issuance insertion, update, or deletion.

Derive the debit account from the pinned profile as
`settlement_asset:stellar-testnet-usdc-circle`; the caller cannot choose it. Use the all-`SPENT`
observation time as `paidAt` and the terminal lifecycle event time as the journal effective time.

In one database transaction:

- insert one immutable journal header and its exact balanced postings;
- transition the matching invoice from `open` to `paid`;
- append the `consumed` lifecycle event linked to that journal; and
- let the terminal-event trigger delete current encrypted bearer custody.

Database uniqueness, foreign keys, append-only triggers, and deferred constraint triggers repeat the
invoice, reservation, effect, route, quote, proof-state, journal, and lifecycle relationships below
the repository. Exact retries return the stored lifecycle and reconstructed accounting; changed
accounting terms fail. Multi-query reads use a repeatable-read snapshot so a concurrent acceptance is
seen wholly before or wholly after commit.

Keep spent proof and invoice claims after consumption. They remain permanent local replay barriers.
Do not expose this operation through the public payment route yet. Do not accept swap success until
replacement-proof custody and its recovery rules exist.

The stored SEP-0007 request is validated for network, asset, amount, and destination syntax, but the
current quote boundary does not prove that its destination came from server-owned settlement policy.
Keep accounting internal until quote creation binds an authorized destination; a valid arbitrary
destination must never be enough to credit a CashMesh-controlled settlement asset.

The accounting migration takes access-exclusive locks on invoice creation, invoices, issued requests,
routes, reservations, and lifecycle events in application write order before inspecting legacy state.
It fails when legacy `consumed` history, any reservation not proven `released`, or any pre-fingerprint
issued request exists. Historical journal identity, fee, asset terms, and route policy cannot be
inferred safely, so such deployments require retirement or a reviewed backfill rather than fabricated
accounting. The migration cannot report success while leaving an issued invoice unreadable or
non-payable.

## Consequences

- A consumed Stellar melt cannot commit without its paid invoice and exact balanced journal, and the
  accounting cannot commit without the matching consumed event.
- Current bearer ciphertext deletion rolls back if any accounting or lifecycle invariant fails.
- Concurrent exact acceptance converges on one journal; conflicting identifiers or terms fail.
- The persisted asset is bound to the only Stellar profile currently accepted by the quote client.
- A mutable normalized route cannot silently become trusted accounting policy after issuance.
- Upgrade cannot strand a legacy in-flight payment or silently retire a legacy issued invoice behind
  the new accounting boundary.
- Late all-`SPENT` evidence at or after invoice expiry remains unresolved instead of auto-fulfilling.
- This proves repository atomicity with local PostgreSQL and mocked operator evidence. It does not
  prove mint honesty, live Stellar settlement, merchant authentication, or an end-to-end payable
  checkout.
- Fees remain an internal server-side accounting input until merchant fee policy is persisted.

## Revisit When

Add a recovery coordinator that observes the bound quote and proof set without redispatch, then calls
this operation with deterministic identifiers. Bind quote destinations to server-owned merchant or
settlement configuration before wiring that coordinator to accounting. Add a versioned
settlement-asset registry before supporting another network or asset. Extend acceptance to
trusted-hold swaps only after replacement proofs, output amounts, fees, and recovery data are durably
bound before bearer input is spent.

## References

- [ADR-0005: Pair Invoice Acceptance with a Balanced Journal](0005-atomic-merchant-accounting.md)
- [ADR-0016: Manage Cashu Proof-Reservation Lifecycle](0016-manage-cashu-proof-reservation-lifecycle.md)
- [ADR-0017: Protect Cashu Bearer Proofs in Encrypted Custody](0017-protect-cashu-bearer-proof-custody.md)
- [ADR-0020: Require Quote Evidence for Melt Effects](0020-require-quote-evidence-for-melt-effects.md)
- [ADR-0022: Coordinate One Fresh Stellar Melt Dispatch](0022-coordinate-fresh-stellar-melt-dispatch.md)

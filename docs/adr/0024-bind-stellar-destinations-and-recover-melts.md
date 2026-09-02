# ADR-0024: Bind Stellar Destinations and Recover Melts Without Redispatch

**Status:** Accepted; scheduling boundary extended by ADR-0025

**Date:** 2026-09-02

## Context

CashMesh can authorize and persist one Stellar melt dispatch, but every later call to that dispatch
path is deliberately recovery-only. It cannot safely decide whether to accept or release the payment
from the original response alone. Recovery needs a fresh view of both the existing NUT-05 quote and
the exact reserved proofs through NUT-07, without reopening bearer custody or creating another melt.

The accounting operation in ADR-0023 derives the canonical Stellar testnet USDC asset account. Its
remaining prerequisite was proving that the SEP-0007 payment destination came from CashMesh-owned
configuration. A checksum-valid caller-selected address is not authorization to debit that asset.

## Decision

Require one server-owned Stellar settlement destination when constructing the acquirer service.
Production reads it from `CASHMESH_STELLAR_SETTLEMENT_DESTINATION`; local development uses an explicit
non-secret test address. Invoice issuance persists that destination on every accepted operator route
and includes it in the immutable route-set fingerprint. A Stellar quote attempt is valid only when its
SEP-0007 destination exactly matches the selected `immediate_conversion` route. Its own immutable
fingerprint also includes the destination.

PostgreSQL repeats the binding with required destination columns, an exact route foreign key, and a
quote-attempt trigger that rejects trusted-hold or mismatched routes. Migration 11 refuses every
pre-existing issued request because ownership of a historical destination cannot be inferred. Such a
deployment must retire those records or perform an explicitly reviewed backfill before upgrading.

Add an internal recovery coordinator with no executor or custody dependency. It selects a bounded
quote checker and proof-state observer by the reservation's normalized mint, then:

1. loads the existing reservation, lifecycle effect, and fully reconstructed quote attempt;
2. checks only that existing quote and persists the exact returned snapshot;
3. queries NUT-07 for exactly the reservation's ordered proof references and persists the exact
   returned snapshot; and
4. classifies only the pair of durable observations.

The classification rules are conservative:

- `PAID` plus a later exact all-`SPENT` snapshot calls atomic acceptance with zero merchant fee;
- `UNPAID` observed at or after quote expiry plus a later exact all-`UNSPENT` snapshot releases the
  reservation;
- `PENDING` plus all-`PENDING` or all-`UNSPENT` records pending;
- pre-expiry `UNPAID` plus all-`UNSPENT` remains recoverable without inventing terminal failure; and
- mixed, contradictory, malformed, unavailable, or otherwise uncertain evidence enters
  `needs_attention` while claims remain active.

The coordinator's local pair is not release authority by itself. The lifecycle repository locks the
reservation, reconstructs the latest durable quote history, and requires the supplied post-expiry
`UNPAID` observation and later all-`UNSPENT` snapshot to still be the latest pair before it inserts a
release event. Quote and proof-state append paths take the same reservation lock. PostgreSQL repeats
the latest-pair check for direct lifecycle writers and rejects new observations after either terminal
state. Migration 12 installs these serialization constraints.

Terminal event and journal identifiers are deterministic from the existing payment, effect, mint, and
quote identity. A terminal lifecycle is returned before any operator observation, so retries and
restarts cannot create another network effect. Aborted reads stop recovery; they do not become release
evidence.

Keep recovery internal. ADR-0025 defines durable jobs, fenced leases, bounded retry, and escalation,
but no supervisor starts the worker and no payment route exposes it. Merchant authentication,
proof-validation orchestration, protected-mint credentials, and manual-attention handling remain
prerequisites for public orchestration.

## Consequences

- A newly accepted Stellar melt is bound to a server-authorized destination as well as the pinned
  network, asset, amount, route, quote, and proof set.
- Recovery never decrypts or redispatches bearer proofs.
- Operator ambiguity retains both proof and invoice claims; only positive paired evidence can consume
  or release them.
- A newer `PAID` quote or `SPENT` proof snapshot supersedes failure evidence before release; terminal
  state freezes both observation histories while exact stored replays remain valid.
- Exact terminal replay performs no further quote or proof-state request.
- Destination and quote records remain correlation-sensitive even though they contain no bearer proof.
- The current configuration uses one acquirer settlement destination for every merchant and operator.
  Per-merchant destinations require a versioned ownership registry before they can replace it.
- Local PostgreSQL and mocked operator clients prove the state transitions, not mint honesty, funded
  Stellar settlement, background scheduling, or a public checkout flow.

## Revisit When

Introduce a versioned settlement-account registry for multiple assets, networks, or merchant-owned
destinations. Add authenticated operator clients before protected mints. ADR-0025 defines the bounded
scheduler contract; add a supervised worker process only after its operational prerequisites are met.
Extend the matrix to trusted-hold swaps only after replacement proofs and their recovery data enter
durable custody before input spend.

## References

- [ADR-0014: Observe Cashu Proof State Through a Bounded Read Client](0014-observe-cashu-proof-state.md)
- [ADR-0015: Persist Payment-Scoped Cashu Proof-State Evidence](0015-persist-cashu-proof-state-evidence.md)
- [ADR-0022: Coordinate One Fresh Stellar Melt Dispatch](0022-coordinate-fresh-stellar-melt-dispatch.md)
- [ADR-0023: Atomically Account Confirmed Stellar Melt Payments](0023-atomically-account-stellar-melt-payments.md)
- [ADR-0025: Schedule Melt Recovery with Fenced Leases](0025-schedule-melt-recovery-with-fenced-leases.md)

# ADR-0004: Use a Stock CDK External Processor for Stellar

**Status:** Accepted for compatibility testing

**Date:** 2026-09-01

## Context

CashMesh needs custom Cashu `stellar` mint and melt behavior without owning a persistent CDK fork. The
boundary must preserve mint-generated quote ids, NUT-20 locks, conservative melt states, exact Stellar
asset validation, and recovery after an indeterminate payout.

CDK `0.18.0-rc.3` exposes `MintPayment` through `cdk-payment-processor` and lets stock `cdk-mintd`
register custom methods advertised by an external gRPC backend. Its current gRPC protocol preserves
quote ids and mint-quote public keys but reconstructs the custom method name as an empty string. The
proto reserves that addition while upstream CDK PR `#2275` is in flight.

## Decision

Pin CDK and `cdk-payment-processor` to `0.18.0-rc.3`, tag commit
`accdd95f1af76a6fdd067e7cbe0a3cc2e7a27693`.

Implement CashMesh as a separate `MintPayment` backend served by the stock payment-processor gRPC
server. Advertise one custom method, `stellar`, on a dedicated endpoint. Accept the empty method field
only as a documented compatibility alias for this pinned gRPC release. Do not add another custom method
to that endpoint until CDK transmits and tests method identity.

Use the CDK quote id as the mint and melt idempotency domain. Require NUT-20 locking pubkeys for Stellar
mint quotes. Map uncertain outgoing effects to `UNKNOWN` or an error while retaining reserved proofs;
never report `UNPAID` or `FAILED` unless no payout can still settle.

Use `stellar-horizon` `0.8.0` behind a replaceable read-only port and `stellar-strkey` `0.0.18` for
address validation. Keep signing and submission behind a separate payout port and fixture it until
funded network work is explicitly approved.

## Consequences

- Stock CDK compatibility is compile-tested without a source fork.
- CDK upgrades are deliberate because the release candidate and gRPC behavior are exact assumptions.
- A one-method processor endpoint is required until upstream method identity lands.
- CashMesh can own Stellar validation and recovery without changing Cashu cryptography or mint logic.
- The Horizon client is community-maintained and must remain isolated and replaceable.
- Live signing, submission, and production persistence remain separate security milestones.

## Revisit When

Re-evaluate this decision when CDK ships a stable release with custom method identity, changes quote or
outgoing-state contracts, or offers a first-party Stellar payment backend. Stop upgrading if stock CDK
can no longer express NUT-20 enforcement, stable quote correlation, or conservative ambiguous payout
states without a persistent fork.

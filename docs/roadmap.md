# Roadmap

This roadmap describes capability order, not promised dates. Later capabilities remain conditional on
security, legal, liquidity, and partner evidence.

## Foundation

**Status:** In progress

- Shared integer-money and operator-policy rules.
- Merchant console and acquirer API scaffolds.
- Settlement recovery state machine.
- Architecture, security, protocol, development, and ADR documentation.
- Deterministic CI and browser checks.

## Stellar Settlement

**Status:** In progress

- Fixture-backed Cashu `stellar` mint and melt profile on CDK `0.18.0-rc.3`.
- Stock external processor construction and documented single-method gRPC constraint.
- Exact Stellar testnet network and Circle USDC tuple validation.
- Atomic deposit cursor, finality, expiry, operation replay, and transaction replay evidence.
- At-most-once payout evidence across ambiguity, crash, and restart.
- Remaining: running `cdk-mintd` integration, testnet signing adapter, and production persistence.

## Merchant Acceptance

**Status:** In progress

- Implemented: versioned merchant invoice lifecycle and balanced invoice-payment journal domain.
- Implemented: operator-specific trusted-hold assets and explicit converted-settlement assets.
- Implemented: strict NUT-18 `creqA` construction for accepted operators and the `stellar` method.
- Implemented: one deterministic request fixture decoded by pinned cashu-ts and CDK types.
- Implemented: PostgreSQL-backed open-invoice creation, lookup, and concurrent idempotent replay.
- Implemented: atomic persistence and API return of the encoded request and operator-policy snapshot.
- Implemented: bounded NUT-18 HTTP envelope parsing and persisted-request binding with no false 2xx.
- Implemented: explicit keyset snapshots, strict offline DLEQ validation, and exact NUT-02 input fees.
- Implemented: bounded, unit-scoped NUT-01/02 observation with stable two-pass metadata reads.
- Implemented: durable keyset identity, collision history, observation replay, and freshness lookup.
- Implemented: durable local proof-reference reservation with restart and concurrency safety.
- Implemented: bounded, same-order NUT-07 proof-state observation without witness retention.
- Implemented: payment-scoped, durable proof-state evidence with explicit freshness and terminal
  `SPENT` history.
- Implemented: durable proof-reservation lifecycle with exact dispatch binding, conservative
  ambiguity, proof-state-gated consumption, and evidence-gated release.
- Implemented: reservation-bound AES-256-GCM bearer custody, permanent key/nonce reuse evidence,
  scoped best-effort zeroization, and terminal ciphertext deletion.
- Implemented: bounded custom `stellar` NUT-05 quote creation and checking with immutable term binding,
  UUIDv7 identity, and no automatic retry.
- Remaining: production key management, durable quote persistence, bounded swap/melt execution, and
  atomic paid-invoice plus balanced-journal persistence.
- Remaining: verified NUT-18 payment acceptance and advisory mint support after catch-all conversion.
- Remaining: protected-mint authentication, spending conditions, and redemption.
- Trusted-hold and immediate-conversion settlement.
- Receipts, refund records, webhooks, accounting export, and manual attention.

## Operator Network

**Status:** Conditional

- Signed operator manifests and capability discovery.
- Two or more independent test operators.
- Merchant-specific limits, health signals, and incident suspension.
- Published conformance and redemption-performance evidence.

## Distribution

**Status:** Conditional

- Payout links or campaigns with a documented privacy boundary.
- Wallet SDK for payment requests, operator selection, and fee disclosure.
- Sponsored Stellar-account graduation.
- Controlled merchant pilot with measurable settlement reliability.

## Settlement Choice

**Status:** Deferred

- Stellar path-payment quotes.
- Anchor and eligible cash-payout routes.
- Merchant plugins and accounting integrations.

## Clearing

**Status:** Deferred

- Prefunded balances and bounded merchant credit.
- Batched settlement.
- Counterparty limits, collateral, default, and suspension rules.
- Bilateral or multilateral netting only after operating history exists.

No new token, DAO, global compliance claim, or unconditional offline-finality claim is planned.

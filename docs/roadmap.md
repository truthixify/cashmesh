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

**Status:** Planned

- Experimental Cashu `stellar` mint and melt method profile.
- External processor compatible with a pinned stock CDK release.
- Exact Stellar testnet USDC asset validation.
- Durable deposit cursor, finality, expiry, replay, and reconciliation rules.
- At-most-once payout evidence across crash and restart.

## Merchant Acceptance

**Status:** Planned

- Versioned merchant invoice and ledger schemas.
- NUT-18 accepted/preferred operator policy.
- Proof, keyset, unit, amount, fee, DLEQ, invoice, and expiry validation.
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

# Security and Trust Model

## Scope

This model covers the CashMesh software boundary: merchant console, acquirer, operator integration, and
Stellar settlement adapter. It is not an audit, legal opinion, proof of operator solvency, or guarantee
of Cashu or Stellar implementations.

## Assets

- Cashu bearer proofs and their reserved/spent state.
- Mint signing keys.
- Stellar reserve and payout keys.
- Merchant balances and settlement obligations.
- Quote, invoice, receipt, refund, and transaction identifiers.
- Operator manifests, limits, and suspension state.
- Customer and merchant metadata.
- Reconciliation cursors and audit evidence.

## Actors

- Payer using a compatible Cashu wallet.
- Merchant and authorized cashier.
- CashMesh acquirer operator.
- Independent Cashu mint operator.
- Stellar asset issuer and network validators.
- Anchor or payout provider in later deployments.
- External attacker, dishonest payer, compromised merchant account, or dishonest operator.

## Trust Boundaries

1. Wallet to acquirer: bearer proofs and invoice binding cross an untrusted network.
2. Acquirer to Cashu operator: spent-state checks, swaps, and melts depend on a custodian.
3. Operator to Stellar: public settlement depends on exact network and asset configuration.
4. Acquirer to merchant: ledger state and webhook delivery affect merchant fulfillment.
5. Operations to key custody: application processes must not gain unnecessary signing authority.

## Required Invariants

- An exact deposit can fund at most one mint quote.
- A settlement identifier can produce at most one successful payout.
- Proofs remain reserved while a payout effect may exist.
- Submitted is not paid; paid requires an observed matching transaction.
- A different transaction hash for the same settlement is a hard conflict.
- Every monetary value is a bounded integer minor-unit amount.
- Every paid invoice is persisted atomically with one exactly balanced payment journal.
- Invoice-payment journals bind the invoice, merchant, payment, operator, and settlement mode.
- Trusted e-cash assets remain separated by operator in every posting.
- Operator tiers and caps are evaluated at payment time and recorded with the decision.
- A strict payment request lists only accepted operators and never advertises unlisted-mint support.
- Encoded request intent never replaces server-side invoice expiry, state, or replay enforcement.
- Stored `open` state never overrides the invoice's half-open validity interval.
- One merchant/idempotency-key pair commits at most one invoice and changed request terms fail.
- Merchant balances reconcile to immutable invoice and settlement references.
- Reserve visibility and redemption probes never become a solvency guarantee.

## Threats and Controls

| Threat | Impact | Initial control |
|---|---|---|
| Replayed Stellar deposit | Unbacked issuance | Quote-derived memo plus operation and transaction uniqueness |
| Wrong asset or issuer | Unbacked issuance | Exact network/code/issuer allowlist |
| Partial or rounded payment | Accounting loss | Integer quote amount and exact comparison |
| Duplicate payout after timeout | Reserve loss | Persisted exact envelope/hash, dispatch intent, observe-before-retry |
| Proof release after ambiguous effect | Double redemption | `needs_attention` state and proof reservation |
| Dishonest or insolvent operator | Merchant loss | Per-operator tiers, caps, conversion policy, suspension, diversification |
| Forged merchant callback | Fulfillment without payment | Signed/replay-protected webhooks and merchant-side verification |
| Cashier account compromise | Fraudulent invoice or refund | Least privilege, location scope, audit log, strong authentication |
| Bearer-proof leakage | Direct value theft | Never log proofs, encrypt local storage, minimize handling |
| Injected payment metadata | Secret or personal data retained in accounting | Project only declared schema fields into durable domain records |
| Wrong-merchant journal | Misstated merchant liability | Bind merchant in the reference and require one matching payable credit |
| Duplicate invoice payment | Double fulfillment or liability | Atomic open-to-paid transition plus database uniqueness constraints |
| Duplicate invoice creation | Conflicting checkout records | Merchant-scoped request fingerprint and transactional unique reservation |
| Cross-merchant invoice lookup | Metadata disclosure | Merchant-scoped query returning the same not-found result |
| Stale or replayed NUT-18 request | Payment against an invalid invoice | Server-side invoice lookup, half-open expiry check, and unique payment reservation |
| Unsafe request endpoint | Credential leakage or payer redirection | Normalized HTTPS URLs without credentials, queries, or fragments |
| False advisory-mint claim | Proofs arrive from an unsupported operator | Omit `mp` and reject advisory construction until catch-all conversion exists |
| Edge correlation | Privacy loss | Data minimization, retention limits, batching research, honest disclosure |
| Dependency compromise | Code/key compromise | Exact versions, lockfiles, review, minimal dependencies, CI checks |

## Privacy Boundary

Cashu blind signatures can prevent an operator from directly linking properly blinded issuance outputs
to later valid proofs. Internal token transfer does not appear on Stellar.

CashMesh does not hide everything:

- Stellar deposits and merchant settlements are public.
- Operators see quote amount, time, completion, and redemption details.
- The acquirer sees merchant, invoice, amount, operator, and settlement state.
- A NUT-18 request reveals its invoice identifier, amount, accepted mints, and transport endpoint.
- Network and application metadata can correlate parties.
- Exact amounts and timing can correlate entry and exit.
- Stablecoin issuer controls remain in force.

Do not describe this as anonymous, trustless, self-custodial, sanctions-resistant, or private at every
edge.

## Secret Handling

- Keep Cashu signing keys and Stellar payout keys in separate security domains.
- Do not place secrets in source, `.env.example`, tests, fixtures, snapshots, logs, screenshots, or
  issue reports.
- Use test-only keys that cannot control value when deterministic signatures are required.
- Redact bearer tokens and complete payment requests from telemetry by default.
- Treat database backups, dead-letter queues, and tracing systems as potential secret stores.
- Treat a signed Stellar envelope as dispatch-capable data: encrypt it at rest and never include it in
  debug output, telemetry, screenshots, or support artifacts.

## Compatibility Store Boundary

The current JSON journal uses atomic replacement and owner-only Unix permissions to test restart
invariants. It is safe only for one processor process in an unfunded environment. It does not provide
cross-process locking, encryption, access audit, backup recovery, or production migrations. Those are
deployment gates, not optional hardening.

## Acquirer Database Boundary

PostgreSQL now stores open invoices and idempotency fingerprints. Database constraints repeat the
identifier, amount, unit, schema, ownership, and expiry-shape invariants. Concurrent creation is
serialized by a unique merchant/key reservation, and invoice plus reservation commit together.

This is not authorization or a production data-protection program. The local Compose credentials are
test-only. A deployed database requires encrypted transport and storage, least-privilege credentials,
credential rotation, network isolation, access auditing, tested backups and point-in-time recovery,
retention rules, and merchant authentication before the API is exposed.

## Mainnet Gates

Mainnet custody or merchant settlement requires all of:

- named operating entities and qualified jurisdictional review;
- independent security review;
- production key custody and rotation plan;
- tested incident and redemption-only procedures;
- per-quote, daily, operator, and total-liability caps;
- reconciliation and backup recovery drills;
- a merchant dispute, refund, and support process; and
- explicit approval to use funded accounts.

Passing repository tests does not satisfy these gates.

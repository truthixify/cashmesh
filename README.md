# CashMesh

CashMesh is an open merchant acquiring and settlement network for multi-operator Cashu e-cash on
Stellar.

The repository contains a merchant operations console, a small acquirer API, shared invoice,
accounting, and operator-policy rules, and a fixture-backed Stellar payment processor for stock CDK
`0.18.0-rc.3`. It does **not** run a public Cashu mint, sign or broadcast Stellar transactions, persist
merchant balances, or wire a merchant flow that moves funds. The Cashu package does contain a
dispatch-capable melt client and must be treated as bearer-value code.

## Current Capabilities

- Classify operators as trusted, convertible-only, or unlisted.
- Force immediate conversion when an operator cannot be safely held.
- Represent USDC amounts as integer minor units.
- Create versioned invoices with deterministic paid, expired, and cancelled transitions.
- Pair payment acceptance with an immutable, balanced, operator-aware merchant journal.
- Persist open invoices with PostgreSQL and make concurrent merchant retries converge on one record.
- Construct deterministic strict NUT-18 requests for accepted operators and the `stellar` method.
- Persist each encoded NUT-18 request and its operator-policy snapshot atomically with the invoice.
- Inspect bounded NUT-18 POST envelopes and reject every payload until state, reservation, and
  accounting checks are wired atomically.
- Validate proof signatures and exact mixed-keyset input fees against explicit offline snapshots.
- Observe unit-scoped NUT-01/02 keysets through a bounded, rotation-aware HTTPS client.
- Persist append-only keyset identities and observations with collision and freshness checks.
- Derive and durably reserve non-spendable NUT-07 proof references without retaining bearer proofs.
- Observe NUT-07 proof state through a bounded, credential-free HTTPS client without retaining
  witnesses.
- Persist append-only, payment-scoped proof-state evidence with explicit freshness and terminal
  `SPENT` history.
- Persist an append-only proof-reservation lifecycle with dispatch identity, ambiguity retention,
  proof-state-gated consumption, and evidence-gated release.
- Validate a redacted bearer-proof bundle, encrypt it with reservation-bound AES-256-GCM custody, retain
  permanent key/nonce reuse evidence, and delete current ciphertext at terminal lifecycle state.
- Create and check strict `stellar` NUT-05 melt quotes through a bounded, non-retrying HTTPS client
  while binding every later observation to the original terms.
- Persist one pre-dispatch Stellar quote attempt per payment, retain ambiguous creation without retry,
  and append immutable quote-state observations across restart.
- Require every new melt effect to match that payment's persisted mint, quote ID, expiry, and current
  `UNPAID` evidence before dispatch can start.
- Construct a canonical zero-fee `stellar` melt request, require explicit fresh-effect authorization
  before one bounded non-retrying POST, and return only sanitized quote state.
- Coordinate encrypted custody, historical NUT-02 fees, mint-specific executors, and durable
  pending/attention outcomes so only one fresh melt effect can authorize one operator call.
- Atomically accept a confirmed immediate-conversion melt only after exact `PAID` quote and all-`SPENT`
  proof evidence, committing the paid invoice, balanced journal, consumed lifecycle event, and custody
  deletion together.
- Decode one NUT-18 fixture with independently pinned cashu-ts and CDK implementations.
- Produce deterministic SEP-0007 requests for an exact Stellar testnet USDC tuple.
- Decode joined Horizon fixtures and atomically reject wrong network, asset, amount, expiry, or replay.
- Persist a prepared payout before dispatch and recover without creating a second transaction effect.
- Expose custom `stellar` mint and melt behavior through stock CDK payment-processor types.
- Exercise the merchant workflow in an explicitly labeled testnet fixture console.

## Architecture

```text
Cashu wallet
     |
     | NUT-18 payment request
     v
Merchant console ---> Acquirer API ---> Operator policy
                            |                  |
                            |                  +--> hold / convert / reject
                            v
                 Cashu operator adapter       (fixture-backed)
                            |
                            v
                 Stellar settlement adapter   (read fixture / prepare payout)
                            |
                            v
                     Stellar testnet           (no broadcast)
```

The domain package has no framework or network dependencies. Cashu, Stellar, storage, and delivery
frameworks adapt to it at the edges.

## Repository Layout

| Path | Responsibility |
|---|---|
| `apps/merchant-console/` | Next.js merchant operations reference client |
| `services/acquirer-api/` | Fastify policy, durable invoice API, Cashu evidence, encrypted proof custody, quote ownership, reservation lifecycle, internal melt coordination, and atomic paid-melt accounting |
| `packages/domain/` | Invoice, balanced journal, integer money, and operator acceptance rules |
| `packages/cashu/` | NUT-18, bounded keyset/proof/quote/melt clients, proof integrity and fees, redacted bearer bundles, and interoperability fixtures |
| `crates/stellar-settlement/` | CDK processor, Stellar profile, journal, fixtures, and recovery rules |
| `docs/` | Architecture, protocol, security, roadmap, development, and ADRs |

## Quick Start

Requirements: Node.js 24, pnpm 10.28, Rust 1.93.1, and Docker with Compose.

```bash
pnpm install
pnpm db:up
pnpm dev
```

- Merchant console: `http://127.0.0.1:3000`
- Acquirer API health: `http://127.0.0.1:3100/health`

Run the complete local verification set:

```bash
pnpm check
pnpm test:e2e
```

See [development setup](docs/development.md), [architecture](docs/architecture.md), the
[merchant accounting contract](docs/merchant-accounting.md), the
[merchant invoice API](docs/invoice-api.md), the
[Cashu payment-request profile](docs/cashu-payment-requests.md), the
[experimental Stellar profile](docs/protocol-profile.md), and the [roadmap](docs/roadmap.md) before
implementing a network integration.

## Safety

Default to local fixtures and Stellar testnet. Do not use funded keys, production bearer proofs, or
mainnet transactions without explicit authorization and an approved operating model. A visible reserve
balance is not proof of mint solvency.

## License

No open-source license has been selected yet. Do not assume reuse rights until a license is added.

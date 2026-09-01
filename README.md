# CashMesh

CashMesh is an open merchant acquiring and settlement network for multi-operator Cashu e-cash on
Stellar.

The repository contains a merchant operations console, a small acquirer API, shared invoice,
accounting, and operator-policy rules, and a fixture-backed Stellar payment processor for stock CDK
`0.18.0-rc.3`. It does **not** run a public Cashu mint, sign or broadcast Stellar transactions, persist
merchant balances, or move funds.

## Current Capabilities

- Classify operators as trusted, convertible-only, or unlisted.
- Force immediate conversion when an operator cannot be safely held.
- Represent USDC amounts as integer minor units.
- Create versioned invoices with deterministic paid, expired, and cancelled transitions.
- Pair payment acceptance with an immutable, balanced, operator-aware merchant journal.
- Persist open invoices with PostgreSQL and make concurrent merchant retries converge on one record.
- Construct deterministic strict NUT-18 requests for accepted operators and the `stellar` method.
- Persist each encoded NUT-18 request and its operator-policy snapshot atomically with the invoice.
- Inspect bounded NUT-18 POST envelopes and reject every payload until proof validation is available.
- Validate proof signatures and exact mixed-keyset input fees against explicit offline snapshots.
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
| `services/acquirer-api/` | Fastify policy and durable Cashu invoice API |
| `packages/domain/` | Invoice, balanced journal, integer money, and operator acceptance rules |
| `packages/cashu/` | NUT-18, keyset-snapshot, proof-integrity, and fee adapter plus interoperability fixture |
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

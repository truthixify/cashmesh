# CashMesh

CashMesh is an open merchant acquiring and settlement network for multi-operator Cashu e-cash on
Stellar.

The repository is at foundation stage. It currently contains a merchant operations console, a small
acquirer API, shared operator-policy rules, and a Rust settlement state machine. It does **not** run a
Cashu mint, connect to Stellar, persist merchant balances, or move funds.

## Current Capabilities

- Classify operators as trusted, convertible-only, or unlisted.
- Force immediate conversion when an operator cannot be safely held.
- Represent USDC amounts as integer minor units.
- Reserve proofs before a payout effect.
- Reject a second transaction hash for one settlement identifier.
- Route ambiguous submitted effects to manual attention instead of declaring failure.
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
                 Cashu operator adapter       (planned)
                            |
                            v
                 Stellar settlement adapter   (planned)
                            |
                            v
                     Stellar testnet
```

The domain package has no framework or network dependencies. Cashu, Stellar, storage, and delivery
frameworks adapt to it at the edges.

## Repository Layout

| Path | Responsibility |
|---|---|
| `apps/merchant-console/` | Next.js merchant operations reference client |
| `services/acquirer-api/` | Fastify health and operator-policy API |
| `packages/domain/` | Integer money and operator acceptance rules |
| `crates/stellar-settlement/` | Rust settlement transition and recovery invariants |
| `docs/` | Architecture, protocol, security, roadmap, development, and ADRs |

## Quick Start

Requirements: Node.js 24, pnpm 10.28, and Rust 1.93.1.

```bash
pnpm install
pnpm dev
```

- Merchant console: `http://127.0.0.1:3000`
- Acquirer API health: `http://127.0.0.1:3100/health`

Run the complete local verification set:

```bash
pnpm check
pnpm test:e2e
```

See [development setup](docs/development.md), [architecture](docs/architecture.md), and the
[roadmap](docs/roadmap.md) before implementing a network integration.

## Safety

Default to local fixtures and Stellar testnet. Do not use funded keys, production bearer proofs, or
mainnet transactions without explicit authorization and an approved operating model. A visible reserve
balance is not proof of mint solvency.

## License

No open-source license has been selected yet. Do not assume reuse rights until a license is added.

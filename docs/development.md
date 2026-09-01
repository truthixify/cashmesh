# Development

## Prerequisites

- Node.js 24 or newer
- pnpm 10.28.2
- Rust 1.93.1 with `rustfmt` and `clippy`
- Chromium through Playwright for browser tests

The repository pins the Node major in `.nvmrc`, the pnpm release in `package.json`, and the Rust
toolchain in `rust-toolchain.toml`.

## Install

```bash
pnpm install
pnpm exec playwright install chromium
```

Copy `.env.example` to `.env` only when a task needs local configuration. Never place funded keys,
seed phrases, bearer proofs, or production credentials in environment files.

## Run

Start the merchant console and acquirer API together:

```bash
pnpm dev
```

Or run them independently:

```bash
pnpm dev:merchant
pnpm dev:api
```

The merchant console currently uses labeled fixtures. The acquirer API exposes:

```text
GET  /health
POST /v1/operator-policy/evaluate
```

Example policy request:

```bash
curl -s http://127.0.0.1:3100/v1/operator-policy/evaluate \
  -H 'content-type: application/json' \
  -d '{"tier":"convertible","requestedMode":"trusted_hold"}'
```

The expected decision forces `immediate_conversion`.

## Checks

```bash
pnpm lint       # Biome, rustfmt, and clippy
pnpm typecheck  # all TypeScript workspaces
pnpm test       # Vitest and Cargo tests
pnpm build      # production application builds
pnpm check      # all of the above
pnpm test:e2e   # merchant console at mobile, tablet, and desktop widths
```

The optional read-only testnet identity probe performs no signing or transaction submission:

```bash
cargo test -p cashmesh-stellar-settlement live_horizon_endpoint -- --ignored
```

## Test Layers

| Layer | Current command | What it proves |
|---|---|---|
| TypeScript domain | `pnpm --filter @cashmesh/domain test` | Invoice transitions, balanced journals, integer amounts, and operator policy |
| Cashu request adapter | `pnpm --filter @cashmesh/cashu test` | Strict NUT-18 mapping, policy boundaries, and deterministic cashu-ts decoding |
| Acquirer API | `pnpm --filter @cashmesh/acquirer-api test` | HTTP validation and policy wiring |
| Rust settlement | `cargo test --workspace` | CDK boundary, exact deposit claims, and payout recovery fixtures |
| NUT-18 cross-implementation | `cargo test -p cashmesh-stellar-settlement --test nut18_interoperability` | Pinned CDK decodes the cashu-ts fixture with the intended fields |
| Merchant browser | `pnpm test:e2e` | Responsive layout and invoice fixture interaction |
| Cashu process integration | Not implemented | No running `cdk-mintd` or token issuance yet |
| Stellar fixture integration | `stellar_compatibility` Rust test | Pinned Horizon decoding, identity, finality, and restart rules |
| Stellar live integration | Not implemented | No funded signing, submission, or live payment yet |

Never describe a lower test layer as proof that an unimplemented higher layer works.

## Dependency Policy

Dependencies are exact in manifests and reproducible through `pnpm-lock.yaml` and `Cargo.lock`.
Protocol clients must be introduced only with a compatibility test and an ADR or protocol-profile
update. CDK and cashu-ts release candidates require exact pins.

## Local Research

Some contributors may have a local `research/` directory and local agent instructions. Those files are
not part of the implementation repository and should remain visible, unignored, and unstaged when
present.

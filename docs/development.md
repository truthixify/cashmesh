# Development

## Prerequisites

- Node.js 24 or newer
- pnpm 10.28.2
- Rust 1.93.1 with `rustfmt` and `clippy`
- Chromium through Playwright for browser tests
- Docker with Compose, or PostgreSQL 18.6

The repository pins the Node major in `.nvmrc`, the pnpm release in `package.json`, and the Rust
toolchain in `rust-toolchain.toml`.

## Install

```bash
pnpm install
pnpm exec playwright install chromium
```

The API reads process environment variables directly; it does not load `.env` itself. Use
`.env.example` as a reference and export overrides through the shell or process manager. Never place
funded keys, seed phrases, bearer proofs, or production credentials in environment files.

## Run

Start the merchant console and acquirer API together:

```bash
pnpm db:up
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
POST /v1/merchants/:merchantId/invoices
GET  /v1/merchants/:merchantId/invoices/:invoiceId
POST /v1/cashu/payments
```

Example policy request:

```bash
curl -s http://127.0.0.1:3100/v1/operator-policy/evaluate \
  -H 'content-type: application/json' \
  -d '{"tier":"convertible","requestedMode":"trusted_hold"}'
```

The expected decision forces `immediate_conversion`.

Outside production, the API uses two non-routable `.example` Cashu operators and an `.example` POST
transport. Override them with the compact JSON array and HTTPS URL shown in `.env.example`:

```bash
export CASHMESH_CASHU_OPERATOR_ROUTES='[{"operatorId":"operator-a","mintUrl":"https://mint-a.example","tier":"trusted"}]'
export CASHMESH_CASHU_TRANSPORT_URL=https://pay.example/v1/cashu/payments
```

`NODE_ENV=production` requires both values and rejects malformed, duplicate, unlisted, non-HTTPS, or
oversized profiles before opening the database. The API implements the POST path only as a bounded,
non-retaining envelope check and always rejects unverified proofs; the local request is not a payable
checkout.

The Compose service uses local-only test credentials from `.env.example`. Stop the container without
deleting its named data volume with:

```bash
pnpm db:down
```

## Checks

```bash
pnpm lint       # Biome, rustfmt, and clippy
pnpm typecheck  # all TypeScript workspaces
pnpm test       # Vitest and Cargo tests
pnpm build      # production application builds
pnpm check      # all of the above
pnpm test:e2e   # merchant console at mobile, tablet, and desktop widths
```

Run the real PostgreSQL repository suite while the Compose service is healthy:

```bash
CASHMESH_TEST_DATABASE_URL=postgresql://cashmesh:cashmesh_local@127.0.0.1:5432/cashmesh \
  pnpm test:integration
```

The optional read-only testnet identity probe performs no signing or transaction submission:

```bash
cargo test -p cashmesh-stellar-settlement live_horizon_endpoint -- --ignored
```

## Test Layers

| Layer | Current command | What it proves |
|---|---|---|
| TypeScript domain | `pnpm --filter @cashmesh/domain test` | Invoice transitions, balanced journals, integer amounts, and operator policy |
| Cashu adapter | `pnpm --filter @cashmesh/cashu test` | NUT-18 mapping, keyset identity and bounded observation, official DLEQ vector, proof integrity, and exact input fees |
| Acquirer API | `pnpm --filter @cashmesh/acquirer-api test` | HTTP validation, runtime Cashu configuration, replay, envelope binding, privacy, and sanitized failures |
| PostgreSQL repository integration | `pnpm test:integration` | Migration, invoice/request atomicity, keyset history, freshness, proof-reference reservation, restart, concurrency, corruption, and rollback behavior |
| Rust settlement | `cargo test --workspace` | CDK boundary, exact deposit claims, and payout recovery fixtures |
| NUT-18 cross-implementation | `cargo test -p cashmesh-stellar-settlement --test nut18_interoperability` | Pinned CDK decodes the cashu-ts fixture with the intended fields |
| Merchant browser | `pnpm test:e2e` | Responsive layout and invoice fixture interaction |
| Cashu process integration | Not implemented | No running `cdk-mintd` or token issuance yet |
| Cashu mint HTTP integration | Not implemented | Keyset network behavior is covered by mocked transport; no live mint is called |
| Stellar fixture integration | `stellar_compatibility` Rust test | Pinned Horizon decoding, identity, finality, and restart rules |
| Stellar live integration | Not implemented | No funded signing, submission, or live payment yet |

Never describe a lower test layer as proof that an unimplemented higher layer works.

## Dependency Policy

Dependencies are exact in manifests and reproducible through `pnpm-lock.yaml` and `Cargo.lock`.
Protocol clients must be introduced only with a compatibility test and an ADR or protocol-profile
update. CDK and cashu-ts release candidates require exact pins.

The normal local test command skips PostgreSQL integration when `CASHMESH_TEST_DATABASE_URL` is absent.
CI supplies a real PostgreSQL 18.6 service and runs those tests as part of `pnpm check`.

## Local Research

Some contributors may have a local `research/` directory and local agent instructions. Those files are
not part of the implementation repository and should remain visible, unignored, and unstaged when
present.

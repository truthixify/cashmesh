# ADR-0008: Persist Cashu Request Snapshots with Invoices

**Status:** Accepted

**Date:** 2026-09-01

## Context

A NUT-18 request fixes more than an amount and invoice identifier. It commits the receiver to a mint
allowlist, transport, method, and operator policy decision. Rebuilding an old request from current
configuration could redirect a payer, change accepted liabilities, or make an idempotent replay return
different bytes. Persisting only the invoice would leave the merchant checkout artifact incomplete.

The pinned cashu-ts encoder also emits the standard Base64 alphabet even though current NUT-18 calls
for base64url. The library decoder and pinned CDK decoder accept URL-safe input.

## Decision

Validate a reusable, server-owned Cashu issuer profile at startup. Production must configure one HTTPS
POST transport and one through 16 explicit operator routes. API callers cannot assign operator trust,
settlement mode, mint URL, or transport.

Normalize the `creqA` alphabet to padded base64url in the isolated Cashu adapter. Preserve the CBOR
payload and verify the deterministic fixture with both pinned implementations.

Persist the encoded request, transport, issue time, and normalized operator-policy rows in the same
PostgreSQL transaction as the open invoice and idempotency reservation. On read, reconstruct the
request through the adapter and require identical encoded bytes and policy fields. Deferred database
constraints require at least one route at commit while allowing the parent row to be inserted first.

Exact replays return the stored request without consulting the current issuer profile. Migration from
an invoice-only database refuses to proceed when legacy invoice rows exist because their historical
route and transport decisions cannot be inferred safely; deployment must supply an explicit reviewed
backfill or retire those local-only records first.

## Consequences

- A committed invoice always has one stable, strict Cashu request and at least one accepted route.
- Rolling configuration changes affect only newly issued invoices.
- The public request exposes invoice, amount, mint, transport, and operator-policy metadata and must
  remain outside logs, traces, analytics, and public unauthenticated deployments.
- The local `.example` profile is non-routable fixture data.
- The advertised HTTP POST receiver, proof validation, input-fee calculation, terminal invoice state,
  and merchant journal transaction remain separate capabilities.
- NUT-26 `creqB` remains an additive encoding upgrade after wallet and QR interoperability evidence.

## Revisit When

Add merchant-specific persisted route profiles when authentication and merchant configuration exist.
Add a versioned `creqB` representation without rewriting stored `creqA` bytes. Replace the strict-only
profile only after policy can honestly accept and settle proofs from unlisted operators.

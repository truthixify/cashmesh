# Merchant Invoice API

**Status:** Open-invoice issuance and lookup implemented; payment acceptance not implemented

The acquirer API persists version `1` USDC invoices in PostgreSQL and requires a merchant-scoped
idempotency key for every creation request. It does not yet authenticate merchants, issue NUT-18
requests from this endpoint, receive Cashu proofs, or transition invoices out of `open`.

## Create an Invoice

```http
POST /v1/merchants/{merchantId}/invoices
Idempotency-Key: checkout-attempt-001
Content-Type: application/json

{
  "amount": 1234,
  "expiresAt": 1788000300
}
```

`amount` is a positive integer number of US cents. `expiresAt` is an absolute Unix timestamp in
seconds and must be after the server-controlled creation time. Client-supplied identifiers,
timestamps, state, units, customer metadata, and undeclared fields are rejected or unavailable by
schema.

A newly committed invoice returns `201 Created`, `Idempotency-Replayed: false`, a merchant-scoped
`Location`, and:

```json
{
  "invoice": {
    "amount": 1234,
    "createdAt": 1788000000,
    "expiresAt": 1788000300,
    "id": "inv_00000000-0000-4000-8000-000000000000",
    "merchantId": "merchant-001",
    "schemaVersion": 1,
    "state": "open",
    "unit": "usdc"
  },
  "replayed": false
}
```

The identifier above is illustrative test data. Runtime identifiers use a server-generated UUID with
an `inv_` prefix.

## Idempotency Contract

An idempotency key contains the same constrained characters as other durable identifiers and is scoped
to one merchant. CashMesh hashes a canonical tuple of merchant, amount, expiry, and invoice schema.

- Repeating the exact tuple returns the originally committed invoice with `200 OK`,
  `Idempotency-Replayed: true`, and `replayed: true`.
- A replay still succeeds after process restart or invoice expiry because it returns historical
  issuance state rather than attempting to create a new invoice.
- Reusing the same merchant/key pair with different terms returns `409 idempotency_conflict`.
- The same key may be used by a different merchant.

The service performs an initial replay lookup to avoid generating a new candidate for a known request.
That lookup is an optimization, not the race authority. The transaction inserts a merchant/key
reservation with `ON CONFLICT DO NOTHING`; PostgreSQL's composite primary key serializes concurrent
requests. A deferred composite foreign key makes the reservation and invoice commit together. An
invoice identifier collision rolls back the reservation before the service retries with a new id.

Idempotency records currently have no deletion or reuse window. A production retention policy must
preserve replay guarantees for at least the complete client retry and reconciliation horizon.

## Read an Invoice

```http
GET /v1/merchants/{merchantId}/invoices/{invoiceId}
```

Lookup is merchant-scoped. A mismatched merchant and a missing invoice both return
`404 invoice_not_found`, avoiding cross-merchant existence disclosure through this endpoint. Invoice
responses use `Cache-Control: no-store` and explicit serialization schemas.

The stored lifecycle state remains `open` until a terminal transition is implemented. A read or replay
can therefore return `state=open` after `expiresAt`; clients and the future payment receiver must still
apply the invoice validity interval `[createdAt, expiresAt)` and must not treat that state alone as
authorization to accept payment.

## PostgreSQL Boundary

The repository uses exact `pg` version `8.23.0`. Local and CI integration tests run against the
official `postgres:18.6-alpine3.23` image pinned to manifest digest
`sha256:697c180dbf244d3ce4a8f4cbc0156cde840af055c1bf8b76aebe422a4822086f`. Startup applies
forward-only migrations under a PostgreSQL transaction-scoped advisory lock and refuses an unknown
migration version or name.

The first migration enforces:

- globally unique invoice identifiers;
- one creation record per merchant/idempotency key and one key per invoice;
- matching merchant ownership through a composite foreign key;
- version `1`, `usdc`, positive safe-integer amounts, safe timestamps, and `expiresAt > createdAt`;
- constrained invoice, merchant, and idempotency identifiers; and
- `open` as the only persistable state in the current schema.

Supporting `paid`, `expired`, or `cancelled` records requires a new migration with state-specific fields
and checks. In particular, payment acceptance must atomically write the paid invoice, proof reservation,
and balanced journal; this issuance transaction does not satisfy that later accounting boundary.

## Error and Privacy Boundary

Shape and identifier failures return `400`; semantic invoice failures return `422`; changed
idempotency terms return `409`; and sanitized storage failures return `503`. SQL text, connection
strings, credentials, and driver errors are never returned to clients or adopted as stable API codes.

Invoice identifiers, amounts, timing, merchant identifiers, and idempotency keys are sensitive payment
metadata. Do not put customer identity or secrets into identifiers or keys. Merchant authentication and
authorization are mandatory before any public or multi-tenant deployment; the current local API does
not implement them.

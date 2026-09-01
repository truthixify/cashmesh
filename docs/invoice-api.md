# Merchant Invoice API

**Status:** Open-invoice and strict Cashu request issuance implemented; payment acceptance not
implemented

The acquirer API persists version `1` USDC invoices in PostgreSQL and requires a merchant-scoped
idempotency key for every creation request. It can inspect and bind a NUT-18 payment envelope, but it
does not yet authenticate merchants, validate or reserve Cashu proofs, or transition invoices out of
`open`.

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
  "cashuPaymentRequest": {
    "amount": 1234,
    "encodedRequest": "creqA...",
    "encoding": "creqA",
    "expiresAt": 1788000300,
    "invoiceId": "inv_00000000-0000-4000-8000-000000000000",
    "issuedAt": 1788000000,
    "mintPolicy": "strict",
    "operators": [
      {
        "mintUrl": "https://mint-a.example",
        "mode": "trusted_hold",
        "operatorId": "operator-a",
        "reason": "trusted_operator",
        "tier": "trusted"
      },
      {
        "mintUrl": "https://mint-b.example",
        "mode": "immediate_conversion",
        "operatorId": "operator-b",
        "reason": "conversion_required",
        "tier": "convertible"
      }
    ],
    "schemaVersion": 1,
    "transportUrl": "https://pay.example/v1/cashu/payments",
    "unit": "usdc"
  },
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

The identifier and shortened encoded request above are illustrative. Runtime identifiers use a
server-generated UUID with an `inv_` prefix. The actual `encodedRequest` is a complete padded
base64url `creqA` value.

The server, not the HTTP caller, supplies accepted operator routes and the transport. Production
requires `CASHMESH_CASHU_OPERATOR_ROUTES` and `CASHMESH_CASHU_TRANSPORT_URL`; startup rejects invalid,
unlisted, duplicate, unsafe, or oversized profiles. Local defaults use non-routable `.example` URLs.

## Idempotency Contract

An idempotency key contains the same constrained characters as other durable identifiers and is scoped
to one merchant. CashMesh hashes a canonical tuple of merchant, amount, expiry, and invoice schema.

- Repeating the exact tuple returns the originally committed invoice and Cashu request with `200 OK`,
  `Idempotency-Replayed: true`, and `replayed: true`.
- A replay still succeeds after process restart or invoice expiry because it returns historical
  issuance state rather than attempting to create a new invoice.
- Reusing the same merchant/key pair with different terms returns `409 idempotency_conflict`.
- The same key may be used by a different merchant.

The service performs an initial replay lookup to avoid generating a new candidate for a known request.
That lookup is an optimization, not the race authority. The transaction inserts a merchant/key
reservation with `ON CONFLICT DO NOTHING`; PostgreSQL's composite primary key serializes concurrent
requests. The invoice, Cashu request, normalized operator-policy rows, and reservation commit together.
An invoice identifier collision rolls back the complete artifact before the service retries with a
new id.

Idempotency records currently have no deletion or reuse window. A production retention policy must
preserve replay guarantees for at least the complete client retry and reconciliation horizon.

## Read an Invoice

```http
GET /v1/merchants/{merchantId}/invoices/{invoiceId}
```

Lookup is merchant-scoped. A mismatched merchant and a missing invoice both return
`404 invoice_not_found`, avoiding cross-merchant existence disclosure through this endpoint. Invoice
responses use `Cache-Control: no-store` and explicit serialization schemas. Lookup returns the
persisted Cashu request alongside the invoice; it never rebuilds historical request bytes from current
operator configuration.

The stored lifecycle state remains `open` until a terminal transition is implemented. A read or replay
can therefore return `state=open` after `expiresAt`; clients and the future payment receiver must still
apply the invoice validity interval `[createdAt, expiresAt)` and must not treat that state alone as
authorization to accept payment.

## Inspect a Payment Envelope

```http
POST /v1/cashu/payments
Content-Type: application/json

{
  "id": "inv_00000000-0000-4000-8000-000000000000",
  "mint": "https://mint-a.example",
  "unit": "usdc",
  "proofs": [
    {
      "amount": 1234,
      "id": "009a1f293253e41e",
      "secret": "test-only-no-value",
      "C": "021111111111111111111111111111111111111111111111111111111111111111"
    }
  ]
}
```

The proof above is structural test data and cannot carry value. This is the POST path advertised by the
default request profile. It accepts at most 64 KiB and 128 proofs, preserves exact JSON integer amounts
through the pinned Cashu decoder, and discards memo, proof, and undeclared payer fields after deriving a
metadata-only envelope. The invoice ID is globally unique, so this wallet-facing route does not require
a merchant ID and returns no invoice data.

The route checks that the invoice exists, remains within `[createdAt, expiresAt)`, uses the same unit,
lists the normalized mint, and is not definitely underpaid before input fees. It never returns 2xx.
A matching envelope returns `503 proof_validation_unavailable`; no proof is stored, reserved, spent,
or submitted to an operator.

The Cashu package has a deterministic offline proof validator, but the API has no trusted keyset
provider, durable snapshot store, NUT-07 observer, or proof reservation yet. That library capability is
therefore intentionally not enough to change the endpoint response.

| Status | Meaning |
|---:|---|
| `400` | Malformed NUT-18 envelope |
| `404` | Invoice/request ID not found |
| `410` | Invoice request expired |
| `413` | Body exceeds 64 KiB |
| `415` | Media type is not `application/json` |
| `422` | Unit, mint, or definite gross amount mismatch |
| `503` | Proof validation is unavailable or storage failed |

## PostgreSQL Boundary

The repository uses exact `pg` version `8.23.0`. Local and CI integration tests run against the
official `postgres:18.6-alpine3.23` image pinned to manifest digest
`sha256:697c180dbf244d3ce4a8f4cbc0156cde840af055c1bf8b76aebe422a4822086f`. Startup applies
forward-only migrations under a PostgreSQL transaction-scoped advisory lock and refuses an unknown
migration version or name.

The invoice and Cashu request migrations enforce:

- globally unique invoice identifiers;
- one creation record per merchant/idempotency key and one key per invoice;
- matching merchant ownership through a composite foreign key;
- version `1`, `usdc`, positive safe-integer amounts, safe timestamps, and `expiresAt > createdAt`;
- constrained invoice, merchant, and idempotency identifiers;
- `open` as the only persistable state in the current schema;
- one request per invoice, one through 16 ordered routes, unique operator and mint identities, strict
  policy tuples, HTTPS endpoints, and a URL-safe `creqA` shape; and
- reconstruction of stored request bytes through the pinned adapter before returning a record.

The Cashu request migration refuses an invoice-only database that already contains invoice rows. A
historical mint allowlist and transport cannot be inferred from an invoice, so deployment requires an
explicit reviewed backfill or retirement of local-only legacy records before upgrade.

Supporting `paid`, `expired`, or `cancelled` records requires a new migration with state-specific fields
and checks. In particular, payment acceptance must atomically write the paid invoice, proof reservation,
and balanced journal; this issuance transaction does not satisfy that later accounting boundary.

## Error and Privacy Boundary

Shape and identifier failures return `400`; semantic invoice failures return `422`; changed
idempotency terms return `409`; and sanitized request-issuance or storage failures return `503`. SQL
text, connection strings, credentials, driver errors, and raw configuration are never returned to
clients or adopted as stable API codes.

Invoice identifiers, amounts, timing, merchant identifiers, and idempotency keys are sensitive payment
metadata. Do not put customer identity or secrets into identifiers or keys. Merchant authentication and
authorization are mandatory before any public or multi-tenant deployment; the current local API does
not implement them. The NUT-18 POST path is envelope-only and always rejects unverified proofs, so the
local fixture request must not be presented as payable.

Automatic HTTP access logs are disabled because request paths contain merchant and invoice identifiers.
Do not enable framework request logging without replacing raw URLs with reviewed route templates and
excluding headers and bodies.

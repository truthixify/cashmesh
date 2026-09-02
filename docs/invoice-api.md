# Merchant Invoice API

**Status:** Open-invoice issuance and internal evidence-gated paid-melt accounting implemented; public
payment acceptance not implemented

The acquirer API persists version `1` USDC invoices in PostgreSQL and requires a merchant-scoped
idempotency key for every creation request. It can inspect and bind a NUT-18 payment envelope, but it
does not yet authenticate merchants or validate proofs in the HTTP path. Internal repositories can
reserve sanitized proof references, persist matching NUT-07 and Stellar quote evidence, coordinate a
bounded melt, recover it without redispatch, and atomically transition an invoice to `paid` with its
journal after confirmation. None of that acceptance flow is connected to the public endpoint.

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

The server, not the HTTP caller, supplies accepted operator routes, the transport, and the Stellar
settlement destination. Production requires `CASHMESH_CASHU_OPERATOR_ROUTES`,
`CASHMESH_CASHU_TRANSPORT_URL`, and `CASHMESH_STELLAR_SETTLEMENT_DESTINATION`; startup rejects invalid,
unlisted, duplicate, unsafe, oversized, or checksum-invalid profiles. Local defaults use non-routable
`.example` URLs and an unfunded test address.

## Idempotency Contract

An idempotency key contains the same constrained characters as other durable identifiers and is scoped
to one merchant. CashMesh hashes a canonical tuple of merchant, amount, expiry, settlement destination,
and invoice schema.

- Repeating the exact tuple returns the originally committed invoice and Cashu request with `200 OK`,
  `Idempotency-Replayed: true`, and `replayed: true`.
- A replay still succeeds after process restart or invoice expiry because it returns historical
  issuance state rather than attempting to create a new invoice.
- A replay after internal payment acceptance still returns the original `open` issuance snapshot; it
  is not a current invoice-status endpoint.
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

The public flow currently has no path that invokes a terminal transition. An open read can therefore
return `state=open` after `expiresAt`; clients must still apply `[createdAt, expiresAt)` and must not
treat state alone as payment authorization. When internal acceptance marks an invoice paid, the open
lookup excludes it. Idempotency replay remains an issuance-history response and deliberately
reconstructs the original `open` snapshot rather than current payment state.

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

The Cashu package has a deterministic offline proof validator and bounded NUT-07 observer. Separate
acquirer repositories can load explicit keyset observations, reserve sanitized proof references,
persist exact payment-scoped proof-state evidence, manage lifecycle claims, encrypt the minimum spend
bundle for an exact reservation, coordinate one fresh zero-fee melt against stored quote evidence,
recover the existing melt from paired quote and proof-state observations without redispatch, and
atomically account a confirmed immediate-conversion melt. The HTTP service does not orchestrate those
capabilities. Internal dispatch alone is therefore intentionally not enough to change the endpoint
response.

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

The invoice, Cashu request, keyset-evidence, proof-reference, and proof-state migrations enforce:

- globally unique invoice identifiers;
- one creation record per merchant/idempotency key and one key per invoice;
- matching merchant ownership through a composite foreign key;
- version `1`, `usdc`, positive safe-integer amounts, safe timestamps, and `expiresAt > createdAt`;
- constrained invoice, merchant, and idempotency identifiers;
- `open` and evidence-gated `paid` as the only persistable states in the current schema;
- one request per invoice, one through 16 ordered routes, unique operator and mint identities, strict
  policy tuples, HTTPS endpoints, a URL-safe `creqA` shape, and an authenticated fingerprint over the
  complete issued request and ordered route policy;
- reconstruction of stored request bytes and verification of its route count, route details, and
  fingerprint through the pinned adapter before returning or accepting a record;
- one immutable identity per normalized mint URL and keyset ID, even across operator configurations;
- one append-only observation per operator, mint, unit, and observation time;
- reconstruction and fingerprint verification before a keyset snapshot is returned as fresh;
- one append-only reservation per payment ID, bound to an issued invoice/operator/mint route and exact
  keyset observation; and
- one local claim per `(mint URL, Y)`, with exact replay and transactional proof-set cardinality and
  amount checks;
- one append-only proof-state snapshot per payment and observation time, bound to that reservation's
  exact scope and complete `Y` set; and
- terminal `SPENT` history, including observations inserted out of timestamp order;
- one immutable operator effect per payment, with exact dispatch and melt-quote identity;
- append-only reservation transitions with exact replay and conservative ambiguity; and
- active proof and invoice claims removed only by an evidence-valid release;
- one immutable AES-256-GCM ciphertext record per active pre-dispatch reservation, bound to its exact
  scope and proof references;
- append-only key/nonce use across terminal histories; and
- automatic current-ciphertext deletion on `consumed` or `released` lifecycle events;
- one immutable Stellar melt quote attempt per payment, requiring its open invoice, active reservation,
  encrypted custody, server-owned destination, and immediate-conversion route before the single
  authorized creation call; and
- one immutable quote outcome plus append-only, term-bound observations with terminal `PAID` history;
- full quote-attempt reconstruction and fingerprint verification before dispatch or acceptance; and
- one exact quote-to-melt-effect binding enforced by repository checks and a database trigger;
- one immutable paid-invoice journal per accepted payment, with exactly balanced canonical
  settlement-asset, merchant-payable, and optional fee postings;
- a consumed event, exact persisted `PAID` melt observation, later all-`SPENT` snapshot, issued
  immediate-conversion route, and paid invoice that must commit as one coherent record; and
- append-only issued route decisions, rejection of reservations against unauthenticated legacy route
  sets, exact destination binding, and atomic current-ciphertext deletion at acceptance.

Keyset, proof-reference, proof-state, quote, and lifecycle persistence are separate repository capabilities.
Invoice issuance and HTTP payment intake do not automatically observe a mint, select a freshness
interval, load a stored snapshot, create a reservation, dispatch an effect, or interpret evidence. The
reservation stores `Y`, keyset ID, and amount; state evidence stores `Y` and the mint-asserted enum;
lifecycle history stores sanitized effect identities and outcomes. Those evidence tables store no proof
secret, signature, DLEQ value, witness, memo, token, or raw payload. The separate custody table stores
only ciphertext, authenticated metadata, and key/nonce identity; it has no plaintext bearer columns.
Quote evidence stores the full SEP-0007 payout request and quote identity, so it is sensitive even
though it contains no bearer proof. The payment endpoint does not create or observe quote attempts.

The Cashu request migration refuses an invoice-only database that already contains invoice rows. A
historical mint allowlist and transport cannot be inferred from an invoice, so deployment requires an
explicit reviewed backfill or retirement of local-only legacy records before upgrade.

The paid-accounting migration takes access-exclusive locks on invoice creation, invoices, issued
requests, routes, reservations, and lifecycle events in application write order. It refuses existing
`consumed` events, any reservation not already proven `released`, and every issued request that predates
the authenticated route fingerprint. Historical journal, fee, asset, and route policy cannot be
inferred, and migration cannot leave an issued invoice silently unreadable. Deployments must retire or
explicitly backfill those records before upgrade. Persisting `expired` or `cancelled` records still
requires a later migration with state-specific fields and checks.

The destination-binding migration refuses every existing issued request because it cannot infer
whether a historical SEP-0007 destination was server-owned. Deployments must retire those requests or
perform an explicitly reviewed destination backfill before applying migration 11.

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

NUT-07 `Y` values are not spendable without their proof secrets, but they are stable, correlation-sensitive
identifiers. Exclude them from logs, metrics, traces, support artifacts, and merchant-facing responses.

Bearer-proof ciphertext is still custody. Logical terminal deletion does not guarantee physical erasure
from PostgreSQL page history, WAL, replicas, snapshots, or backups, and the local key-provider port is
not a production key-management implementation. The internal melt coordinator wires scoped decryption
to canonical outbound request binding only after a fresh durable effect insert. Do not expose that
capability through this route until proof-validation orchestration, authentication, recovery
scheduling, and operational controls are also complete. The separate recovery coordinator cannot
access custody or execution and therefore cannot authorize a second melt.

Automatic HTTP access logs are disabled because request paths contain merchant and invoice identifiers.
Do not enable framework request logging without replacing raw URLs with reviewed route templates and
excluding headers and bodies.

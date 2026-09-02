# Cashu Merchant Payment Requests

**Status:** Strict request construction, durable issuance, non-accepting HTTP envelope intake, offline
proof-integrity validation, bounded public-key and proof-state observation, durable keyset and
proof-state evidence, local proof-reference reservation, and durable reservation lifecycle implemented;
bearer custody, operator dispatch, and payment acceptance not implemented

CashMesh constructs NUT-18 payment requests for an open merchant invoice and an explicit set of
merchant-approved Cashu operators. The adapter is isolated in `packages/cashu`; the domain package
does not depend on a Cashu implementation.

## Compatibility Boundary

The adapter pins `@cashu/cashu-ts` to `5.0.0-rc.8`. That release candidate implements the current
NUT-18 preferred-mint and supported-method fields. The encoded compatibility fixture is also decoded
by CDK `0.18.0-rc.3` in a Rust test. Both dependencies are exact pins because their request types are
still moving.

CashMesh emits CBOR plus padded base64url `creqA` requests. The pinned cashu-ts encoder currently
returns the standard Base64 alphabet, so the isolated adapter replaces `+` and `/` with `-` and `_`
without changing the CBOR bytes. Both pinned decoders accept the normalized fixture. NUT-26 `creqB`
encoding remains deferred until wallet and QR behavior are tested independently.

## Version 1 Mapping

| NUT-18 field | CashMesh value |
|---|---|
| `i` | Invoice identifier |
| `a` | Invoice amount in integer minor units, net of Cashu input fees |
| `u` | `usdc`, where one unit is one US cent |
| `s` | `true` |
| `m` | Sorted, normalized HTTPS URLs for accepted operators |
| `mp` | Omitted, making `m` a strict allowlist |
| `sm` | One custom method with `mn=stellar` and no method fee |
| `t` | One HTTPS POST target |
| `d` | Omitted to avoid retaining free-form customer metadata |
| `nut10` | Omitted; spending conditions are not part of this profile |

The adapter returns a versioned sidecar record containing the invoice amount, invoice expiry,
request issue time, transport URL, selected settlement mode, operator tier, and policy reason. The
acquirer persists that record, the encoded request, and every accepted route in the same transaction
as the invoice and idempotency reservation.

The server validates one reusable route profile at startup. Production requires
`CASHMESH_CASHU_OPERATOR_ROUTES` as a JSON array and `CASHMESH_CASHU_TRANSPORT_URL` as an HTTPS URL.
HTTP callers cannot submit mint URLs, operator tiers, settlement modes, or transports. The local
defaults use the reserved `.example` domain and are fixtures that cannot receive a payment.

## Strict Operator Semantics

An absent or false `mp` field means a wallet must use one of the mints in `m`. CashMesh currently
accepts only operators that merchant policy classifies as trusted or convertible. Emitting `mp=true`
would advertise acceptance of proofs from mints outside that list, which the current policy cannot
honor. The adapter therefore rejects advisory requests instead of making an incompatible promise.

Trusted routes may retain operator e-cash or explicitly request immediate conversion. Convertible
routes always select immediate conversion. Unlisted routes are rejected before encoding.

The `stellar` supported method tells a compatible wallet that a listed mint may satisfy the request by
melting through the custom Stellar profile. No method fee is advertised because NUT-18 method fees
apply to mints outside the listed set, and this profile does not accept those mints.

## Expiry and Single Use

NUT-18 has no invoice-expiry field. CashMesh creates a request only during the invoice interval
`[createdAt, expiresAt)` and returns `expiresAt` in the sidecar, but an encoded request can remain in a
wallet after that time. The receiving endpoint must load the invoice and enforce its current state and
expiry before reserving proofs.

The request sets `single_use=true` as payer intent. It does not prevent replay by itself. Production
storage must atomically enforce unique invoice payment, payment identifier, and proof reservation
constraints.

Invoice creation, exact idempotent replay, and lookup return the persisted sidecar. A restart or
operator-profile change therefore cannot rewrite a previously issued request. PostgreSQL rejects a
request with zero routes, more than 16 route positions, duplicate operators or mint URLs, invalid
policy tuples, or a sidecar that cannot be reconstructed to the stored encoded bytes.

## Input and Privacy Boundaries

- One through 16 unique operators are accepted.
- Mint and POST endpoints must be normalized HTTPS URLs no longer than 512 characters.
- Credentials, query strings, fragments, malformed URLs, and surrounding whitespace are rejected.
- Encoded requests are limited to 4,096 ASCII characters as an application transport bound. This is
  not a claim that every resulting request is practical to scan as a QR code.
- The adapter copies only declared invoice and policy fields and returns deeply immutable records.

## HTTP Payment Envelope

`POST /v1/cashu/payments` accepts the NUT-18 `PaymentRequestPayload` only as raw
`application/json`. The route is capped at 64 KiB and 128 proofs so Fastify does not parse bearer
amounts through ordinary JavaScript JSON or buffer an unbounded proof set. The pinned decoder preserves
integer precision. CashMesh then returns only invoice ID, normalized mint, unit, proof count, and exact
safe-integer gross amount across the adapter boundary; memo, secrets, signatures, DLEQ data, witnesses,
and undeclared metadata are discarded.

The service loads the persisted request by its globally unique invoice ID and checks the half-open
expiry interval, exact `usdc` unit, strict mint allowlist, and gross amount. Gross value at least equal
to the invoice is necessary but not sufficient: NUT-18 defines the requested amount net of input fees.

The endpoint deliberately has no success response. A payload that passes every implemented check
returns `503 proof_validation_unavailable`. It does not retain or reserve proofs, call a mint, inspect
spent state, verify a keyset or DLEQ proof, calculate input fees, transition the invoice, or write a
merchant journal. Malformed and mismatched payloads return non-success responses without reflecting
their contents. Every response uses `Cache-Control: no-store`.

## Offline Proof Validation

`packages/cashu` can separately validate the same raw payload against a version `1` keyset snapshot.
The snapshot binds one normalized mint URL and observation time to public keysets containing unit,
activity, per-input fee, optional final expiry, and all denomination keys. Snapshot construction is
bounded to 64 keysets with 256 keys each, verifies every secp256k1 point, recomputes each keyset ID, and
rejects duplicate IDs. It currently accepts standard `00` and `01` keyset IDs only.

The validator requires every secp proof to contain a valid NUT-12 DLEQ, rejects duplicate secrets,
unknown or expired keysets, mint and unit mismatches, and denomination/signature failures. Requiring a
DLEQ is deliberately stricter than NUT-12's verify-if-present baseline. Inactive keysets are accepted as
inputs before their final expiry because NUT-02 requires mints to accept old proofs after key rotation.

Input fees are calculated across the proof set with exact integer arithmetic using the NUT-02 formula,
then subtracted from gross value once. The immutable result contains gross, input fee, net, proof count,
used keyset IDs, mint, unit, invoice ID, snapshot time, validation time, and one canonical reference per
proof. Each reference contains only the amount, keyset ID, and NUT-07 `Y = hash_to_curve(secret)`. The
result contains no secret, signature, DLEQ, witness, or memo.

NUT-12's proof-side DLEQ includes the payer's blinding factor. It is needed for receiver-side
verification but must not be sent back to the mint because that would reveal the link between issuance
and spend. The metadata-only return prevents accidental forwarding. The custody-specific validator
creates a separate redacted handle only after the same DLEQ check and strips the DLEQ before encryption;
a future operator adapter must preserve that boundary.

This function is not wired into the HTTP route yet. A snapshot is unauthenticated observation evidence,
not a freshness guarantee, and offline cryptography cannot establish NUT-07 `UNSPENT` state. The public
endpoint therefore still returns `503`; a valid offline result must never be presented as a completed
merchant payment.

## Keyset Observation

`CashuKeysetObserver` obtains one configured unit through a `CashuMintKeysetSource` port. The concrete
HTTP client reads only `GET /v1/keysets` and `GET /v1/keys/{keyset_id}` beneath one normalized,
server-configured HTTPS mint URL. Redirects, ambient credentials, referrer data, cache reuse, and
authentication headers are disabled. Per-request time and decoded-body limits are hard bounded.

The observer caps the metadata list before selecting the requested unit, then fetches at most 64
matching keysets with four reads in flight. An ID repeated anywhere in the metadata response, including
across units, is rejected. The observer reads metadata again after the keys arrive and rejects the whole
result if an ID, activity flag, unit, input fee, or final expiry changed. Specific-key responses must
contain exactly one matching keyset. The snapshot timestamp is taken only after that stable second read,
and the existing snapshot validator recomputes every supported keyset ID.

This is transport-authenticated observation of a configured host, not signed operator metadata. The
client must never be constructed directly from the payer's mint field. It performs no automatic retry,
assigns no freshness lifetime, sends no NUT-21 or NUT-22 credential, and does not call NUT-07.

The acquirer storage boundary can persist the resulting snapshot separately. It keeps key material,
unit, fee, and final expiry immutable for each normalized mint URL and keyset ID while recording
activity per operator observation. It rejects historical collisions across operators, treats an exact
scope-and-time repeat as idempotent, and exposes only the latest snapshot inside caller-supplied
inclusive freshness bounds. The observer is not scheduled and this store is not wired to payment
acceptance.

## Local Proof-Reference Reservation

The acquirer can separately persist a local reservation after successful offline validation. It binds
one payment ID to the issued invoice, exact operator/mint route, unit, reservation time, gross amount,
the exact keyset observation time, and a sorted set of proof references. Every referenced keyset must
occur in that operator observation. The caller remains responsible for selecting the observation through
an explicit freshness policy; the reservation does not infer one.

PostgreSQL permits only one active claim for a `(mint URL, Y)` pair. Exact payment retries replay the
stored record, changed terms under one payment ID fail, and competing payments cannot claim the same
proof reference. A released reservation cannot be reactivated by replay, although a new payment may
claim the same references after their active claims are removed. The header and all references commit
together, remain append-only across restart, and contain no secret, signature, DLEQ value, witness,
memo, or raw payload.

Reservation creation is a local lock, not payment acceptance. A separate lifecycle controls whether
that lock remains active, is consumed, or is safely released. Neither repository calls an operator,
retains spendable proof material, changes an invoice, or enables HTTP success. `Y` is non-spendable but
correlation-sensitive and must not enter logs, metrics, support artifacts, or merchant responses.

## Proof-State Observation

`CashuProofStateObserver` can query a configured mint for the NUT-07 state of previously sanitized
proof references. Its concrete HTTPS client sends one bounded, credential-free `POST /v1/checkstate`
containing only a sorted set of at most 128 `Y` values. It disables redirects, cache reuse, referrer
metadata, and ambient credentials, applies time and response-size limits, and performs no automatic
retry.

The observer requires exactly one same-order response for every requested `Y` and accepts only
`UNSPENT`, `PENDING`, or `SPENT`. It validates the optional witness field but discards its value before
constructing an immutable snapshot timestamped at completion. It does not itself persist the snapshot
or wire it into the payment endpoint, reservation lifecycle, redemption, invoice state, or accounting.

This read reveals the queried `Y` grouping and timing to the mint. The result is the mint's current
assertion, not proof of honesty, solvency, future unspentness, successful redemption, or merchant
payment. In particular, `UNSPENT` can become stale immediately and `PENDING` cannot authorize release
of a local reservation.

The acquirer can separately persist a complete snapshot against one exact payment reservation. It
rechecks the payment, operator, mint, unit, reservation time, and full sorted `Y` set before writing.
One payment and observation time has one fingerprinted result; exact retries replay, changed results
conflict, and concurrent workers serialize through the reservation row. Inclusive caller-supplied
freshness bounds select the latest acceptable observation.

`UNSPENT` and `PENDING` can move between each other until a proof becomes `SPENT`. `SPENT` is terminal
even when evidence is backfilled out of order. PostgreSQL repeats exact proof-set coverage and terminal
history constraints below the repository. The store remains append-only, unscheduled, non-accepting,
and witness-free; it does not interpret a snapshot as payment by itself.

## Proof-Reservation Lifecycle

The acquirer can persist one exact operator effect intent for a reserved payment. A swap or melt effect
binds a local effect ID, start time, and SHA-256 fingerprint of the future adapter's canonical outbound
operation. A melt additionally binds its NUT-05 quote ID and expiry. Immutable events reconstruct
`dispatch_started`, melt-only `pending`, `needs_attention`, `consumed`, or `released` state across
restart. One active invoice claim and one dispatch binding prevent competing local effects.

A pre-dispatch reservation may be released without mint evidence. After dispatch starts, ambiguity
always retains the invoice and proof claims. Matching swap success or melt `PAID` evidence consumes
only with a persisted exact all-`SPENT` NUT-07 snapshot at or after that outcome. A definite swap
rejection releases only with later exact all-`UNSPENT` evidence. A melt requires both an `UNPAID`
outcome at or after the bound quote expiry and later exact all-`UNSPENT` evidence. Mixed state,
`PENDING`, timeout, and pre-expiry `UNPAID` never authorize release.

Released reservations retain immutable history while dropping active claims transactionally, allowing
a new payment to claim proofs that are still provably unspent. Consumed and ambiguous lifecycles retain
their claims. Exact event retries replay; conflicting identities or evidence fail. PostgreSQL repeats
the transition, ordering, effect-kind, proof-state, dispatch-ownership, and active-projection rules
below the repository.

This boundary stores sanitized effect evidence, not a trusted receipt. It does not compute the
canonical dispatch fingerprint, authenticate a mint response, retain bearer proofs, send NUT-03 or
NUT-05 requests, transition an invoice, write accounting, or change the public endpoint's rejection.

## Encrypted Bearer-Proof Custody

The custody-specific proof validator returns the ordinary metadata result plus a
`CashuBearerProofBundleV1`. The bundle stores only invoice, mint, unit, and sorted proof amount, keyset
ID, secret, signature, and derived `Y`. It excludes raw payload, memo, DLEQ, witness, and undeclared
fields. Any witness or well-known NUT-10 secret is rejected until CashMesh has a dedicated
spending-condition verifier. JSON serialization, runtime inspection, and string conversion are
redacted; plaintext requires an explicit method.

The PostgreSQL custody repository accepts only a bundle created by that initial validation path and
only for the exact active pre-dispatch reservation. It encrypts canonical bytes with AES-256-GCM, a
random 96-bit nonce, a 128-bit tag, and associated data derived from the payment, invoice, operator,
mint, unit, reservation time, proof references, and custody time. One immutable ciphertext row is
allowed per payment. A permanent key/nonce registry prevents reuse even after the current ciphertext is
deleted, and active plus historical keys are obtained through a key-provider port.

Exact concurrent storage retries converge; changed terms conflict. Retrieval decrypts only inside a
callback and destroys the restored byte array afterward, including on callback failure. The caller owns
and must promptly destroy the initial validated bundle. These wipes reduce exposure but cannot erase
immutable request strings, garbage-collected copies, or crash memory.

A terminal `consumed` or `released` event deletes current ciphertext in the same database transaction.
That is logical retention control, not guaranteed physical erasure from PostgreSQL page history, WAL,
replicas, snapshots, or backups. No production KMS/HSM, envelope-key, access-audit, or
cryptographic-erasure adapter exists. The scoped decryption API does not authorize network use; a future
dispatch coordinator must first persist the exact effect and request fingerprint before it gives proofs
to a bounded NUT-03 or NUT-05 adapter.

A complete request reveals the invoice identifier, amount, accepted mint URLs, and acquirer endpoint.
It is bearer-adjacent payment metadata and must be redacted from logs, traces, analytics, screenshots,
and support artifacts. Avoid putting customer identity or secrets into invoice identifiers or URLs.

## Compatibility Evidence

`packages/cashu/fixtures/nut18/strict-stellar.creq` is generated deterministically by the TypeScript
adapter. TypeScript tests decode it with the pinned cashu-ts implementation and verify the exact raw
field set. A Rust interoperability test decodes the same bytes with pinned CDK NUT-18 types and checks
the identifier, amount, unit, mint list, strict semantics, Stellar method, and POST transport.

This proves request encoding compatibility at the two library boundaries. The HTTP tests prove
precision-preserving envelope parsing, stored-request binding, rejection behavior, and non-retention;
they do not prove wallet QR scanning, proof validity, DLEQ verification, input-fee calculation,
operator redemption, or merchant settlement. Separate proof tests cover an official NUT-12 vector,
deterministic generated proofs, mixed-keyset fees, expiry, duplicates, and malformed evidence. Keyset
and proof-state observer tests cover stable metadata, exact request/response binding, unit filtering,
concurrency, response bounds, transport timeouts, and failure paths entirely through local fixtures.
PostgreSQL tests cover restart, historical collision rejection, freshness bounds, exact keyset and
proof-state binding, terminal state history, concurrent replay, proof-reference exclusion, append-only
enforcement, reservation lifecycle recovery, dispatch ownership, ambiguity retention, evidence-gated
release, encrypted custody restart and key rotation, key/nonce exclusion, ciphertext tamper detection,
terminal deletion, rollback, and stored-record corruption. They do not prove endpoint authenticity, an
appropriate production freshness policy, mint honesty, operator dispatch, redemption, or merchant
settlement. Do not present a locally issued fixture request as payable.

## References

- [Cashu NUT-18 payment requests](https://github.com/cashubtc/nuts/blob/main/18.md)
- [Cashu basic notation and proofs](https://github.com/cashubtc/nuts/blob/main/00.md)
- [Cashu NUT-01 mint public keys](https://github.com/cashubtc/nuts/blob/main/01.md)
- [Cashu NUT-02 keysets and fees](https://github.com/cashubtc/nuts/blob/main/02.md)
- [Cashu NUT-03 swap](https://github.com/cashubtc/nuts/blob/main/03.md)
- [Cashu NUT-05 melt](https://github.com/cashubtc/nuts/blob/main/05.md)
- [Cashu NUT-07 proof state](https://github.com/cashubtc/nuts/blob/main/07.md)
- [Cashu NUT-11 spending conditions](https://github.com/cashubtc/nuts/blob/main/11.md)
- [Cashu NUT-12 DLEQ proofs](https://github.com/cashubtc/nuts/blob/main/12.md)
- [Cashu NUT-21 clear authentication](https://github.com/cashubtc/nuts/blob/main/21.md)
- [Cashu NUT-22 blind authentication](https://github.com/cashubtc/nuts/blob/main/22.md)
- [Cashu NUT-26 payment-request encoding](https://github.com/cashubtc/nuts/blob/main/26.md)
- [cashu-ts](https://github.com/cashubtc/cashu-ts)
- [CDK `v0.18.0-rc.3`](https://github.com/cashubtc/cdk/releases/tag/v0.18.0-rc.3)

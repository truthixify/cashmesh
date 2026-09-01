# Cashu Merchant Payment Requests

**Status:** Strict request construction and durable invoice issuance implemented; payment receipt and
proof validation not implemented

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

A complete request reveals the invoice identifier, amount, accepted mint URLs, and acquirer endpoint.
It is bearer-adjacent payment metadata and must be redacted from logs, traces, analytics, screenshots,
and support artifacts. Avoid putting customer identity or secrets into invoice identifiers or URLs.

## Compatibility Evidence

`packages/cashu/fixtures/nut18/strict-stellar.creq` is generated deterministically by the TypeScript
adapter. TypeScript tests decode it with the pinned cashu-ts implementation and verify the exact raw
field set. A Rust interoperability test decodes the same bytes with pinned CDK NUT-18 types and checks
the identifier, amount, unit, mint list, strict semantics, Stellar method, and POST transport.

This proves request encoding compatibility at the two library boundaries. It does not prove wallet QR
scanning, HTTP receipt, proof validity, DLEQ verification, input-fee calculation, operator redemption,
or merchant settlement. The configured POST transport is descriptive until the receiver endpoint is
implemented; do not present a locally issued fixture request as payable.

## References

- [Cashu NUT-18 payment requests](https://github.com/cashubtc/nuts/blob/main/18.md)
- [Cashu NUT-26 payment-request encoding](https://github.com/cashubtc/nuts/blob/main/26.md)
- [cashu-ts](https://github.com/cashubtc/cashu-ts)
- [CDK `v0.18.0-rc.3`](https://github.com/cashubtc/cdk/releases/tag/v0.18.0-rc.3)

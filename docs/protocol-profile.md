# Experimental Cashu `stellar` Payment Method Profile

**Status:** Draft for compatibility testing

**Method identifier:** `stellar`

**Initial unit:** `usdc`

This document defines the intended boundary for a Cashu mint/melt payment method backed by a Stellar
asset. It is not an accepted NUT and must not be represented as one. Exact field compatibility must be
validated against the pinned CDK release before implementation is treated as interoperable.

## Configuration

Each operator must configure and expose one exact tuple:

```text
network_passphrase
asset_code
asset_issuer
cashu_unit
minor_unit_scale
deposit_destination_strategy
```

The initial profile fixes `cashu_unit=usdc` and `minor_unit_scale=2`, meaning one Cashu unit is one US
cent. Network and issuer are never inferred from asset code alone.

## Capability Discovery

The operator should advertise the custom method through NUT-06 using the method/unit pair supported by
the pinned implementation. A conceptual capability is:

```json
{
  "method": "stellar",
  "unit": "usdc",
  "min_amount": 1,
  "max_amount": 25000
}
```

The exact property names and optional fields remain subject to the compatibility spike. Wallets must
not guess support from the mint name or reserve address.

## Mint Quote

The intended NUT-04 sequence is:

1. Wallet requests a `stellar` / `usdc` mint quote in integer minor units.
2. Operator allocates a unique quote identifier, expiry, and deposit correlation value.
3. Operator returns a signed SEP-0007 `web+stellar:pay` request.
4. Wallet pays the exact allowlisted asset on the configured network.
5. The observer validates and records the finalized transaction once.
6. The Cashu mint marks the quote paid and blind-signs outputs bound by NUT-20 where supported.

The SEP-0007 request must bind:

- exact destination;
- exact decimal amount derived from minor units;
- asset code and issuer;
- network passphrase;
- unique memo or muxed destination;
- quote expiry; and
- origin-domain signature when the selected wallet flow relies on it.

The observer must reject a transaction that is wrong-network, wrong-destination, wrong-asset,
wrong-issuer, partial, overpaid, expired, replayed, or already claimed by another quote.

## Deposit Finality

The exact Horizon/RPC cursor and finality rule is intentionally unresolved. The compatibility spike must
choose and record:

- the authoritative Stellar data source;
- paging/cursor persistence behavior;
- how a successful ledger close becomes final for this product;
- restart behavior between observation and quote update; and
- reconciliation against the operator reserve account.

Issuance must never depend on an unpersisted callback or an in-memory cursor.

## Melt Quote

The intended NUT-05 sequence is:

1. Wallet requests a `stellar` / `usdc` melt quote with destination and integer amount.
2. Operator validates destination, network, asset, fees, limits, and expiry before reserving proofs.
3. Proofs move to `proofs_reserved` before any Stellar submission.
4. One settlement identifier creates at most one Stellar transaction effect.
5. Submission records the transaction hash but does not mark the quote paid.
6. A matching finalized transaction moves the quote to `paid` and consumes proofs.
7. A provable pre-submission failure moves to `failed` and permits release.
8. An ambiguous submitted outcome moves to `needs_attention`; proofs remain reserved.

The quote identifier is the default idempotency domain. If the pinned Cashu implementation requires a
different stable key, that decision must be documented before code changes.

## Merchant Payment Requests

CashMesh uses NUT-18 for receiver-initiated merchant requests. The acquirer will map:

| NUT-18 concept | CashMesh use |
|---|---|
| Amount and unit | Integer invoice amount in `usdc` |
| Accepted mints (`m`) | Merchant/acquirer operator allowlist |
| Mint policy (`mp`) | Strict or advisory operator preference |
| Supported melt methods (`sm`) | `stellar` settlement option and disclosed fee |
| Transport | Wallet-to-acquirer delivery endpoint |
| Locking | Recipient binding where compatible wallet support exists |

CashMesh-specific invoice metadata must not be placed into an extension field until collision,
canonicalization, signing, and versioning behavior are specified.

## Error Categories

Stable public errors should distinguish:

- unsupported method, unit, network, or asset;
- invalid destination or memo;
- amount outside limits;
- expired quote;
- payment not observed;
- wrong or already claimed payment;
- payout rejected before submission;
- payout submitted and awaiting observation;
- payout outcome requiring manual attention; and
- operator suspended by merchant policy.

Raw Stellar, CDK, database, or infrastructure errors must not become stable public schemas by accident.

## Unresolved Decisions

- CDK release and external processor interface.
- Stellar data source and finality rule.
- SEP-0007 signature requirements and origin domain.
- Memo versus muxed-account allocation.
- Fee rounding and sub-cent handling.
- Quote expiry and late-payment recovery.
- NUT-20 support expectations.
- NUT-18 transport and invoice binding.

These decisions require fixtures and compatibility evidence; they must not be selected implicitly in
production code.

# Experimental Cashu `stellar` Payment Method Profile

**Status:** Implemented for fixture-backed compatibility testing

**Method identifier:** `stellar`

**Initial unit:** `usdc`

This document defines the CashMesh profile for a custom Cashu mint and melt method backed by Stellar
USDC. It is not an accepted NUT and must not be represented as one. The implementation proves a stock
CDK boundary and deterministic recovery behavior; it does not operate a funded mint or payout account.

## Pinned Compatibility Boundary

| Component | Exact version | Role |
|---|---|---|
| CDK | `0.18.0-rc.3` | Cashu mint payment interface |
| CDK tag commit | `accdd95f1af76a6fdd067e7cbe0a3cc2e7a27693` | Reviewed upstream source identity |
| `cdk-payment-processor` | `0.18.0-rc.3` | Stock external gRPC processor server |
| `stellar-horizon` | `0.8.0` | Structured read-only Horizon adapter |
| `stellar-base` | `0.7.0` | Horizon account request type |
| `stellar-strkey` | `0.0.18` | G- and M-address validation |

All direct versions are exact in `Cargo.toml`; transitive versions are fixed by `Cargo.lock`.
`stellar-horizon` and `stellar-base` are community-maintained, so their use is isolated behind the
deposit-source port. `stellar-strkey` is maintained by the Stellar Development Foundation.

Stock `cdk-mintd` can connect to this processor through its `grpcprocessor` backend. The processor
advertises `custom["stellar"]`, which causes stock CDK to register the custom mint and melt routes.
The executable construction test passes the CashMesh backend directly to the stock
`PaymentProcessorServer` type.

CDK `0.18.0-rc.3` preserves the quote id and NUT-20 public key over gRPC, but its current proto does not
carry the custom method name. The server reconstructs that field as an empty string while upstream
work is tracked in CDK PR `#2275`. CashMesh therefore accepts either `stellar` or an empty method at
this one-method endpoint. It must not multiplex another custom method onto the same endpoint until the
method name is transmitted and tested.

## Stellar Testnet Identity

The compatibility fixture fixes this exact tuple:

```text
network_passphrase = Test SDF Network ; September 2015
network_id         = cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472
horizon_url        = https://horizon-testnet.stellar.org
asset_code         = USDC
asset_issuer       = GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
cashu_unit         = usdc
minor_unit_scale   = 2
```

The network id is recomputed as SHA-256 of the passphrase. The Horizon adapter reads the root endpoint
and requires the exact passphrase before reading payments. Asset code never implies issuer or network.

One Cashu `usdc` unit is one US cent:

```text
1 unit   = USDC 0.01
100 units = USDC 1.00
```

No floating-point value enters the accounting boundary. Stellar decimals are parsed to stroops and
must equal the quoted cent amount exactly; sub-cent values, partial payments, and overpayments fail.
The compatibility limits are 1 through 25,000 units inclusive.

## Capability Discovery

The external processor reports unit `usdc` and a `stellar` custom-method settings object containing:

- exact network id and passphrase;
- exact asset code and issuer;
- minor-unit scale;
- minimum and maximum amount; and
- `nut20_required=true`.

Wallets must discover the method from mint settings. They must not infer support from a mint name,
reserve address, or asset code.

## Mint Quote

The implemented NUT-04 adapter flow is:

1. CDK supplies a mint-generated typed quote id, integer `usdc` amount, expiry, and NUT-20 pubkey.
2. CashMesh rejects missing locks, zero or out-of-range amounts, expired quotes, and expiries more than
   900 seconds after creation.
3. CashMesh derives `base64(sha256(quote_id))` as a `MEMO_HASH` correlation value.
4. The quote, amount, expiry, correlation, and lock are atomically persisted before a request returns.
5. The adapter returns a deterministic `web+stellar:pay` URI with destination, decimal amount, exact
   asset tuple, memo hash, memo type, and network passphrase.
6. The observer validates one successful direct payment in a closed ledger and atomically persists the
   claim, operation id, transaction hash, and paging cursor before reporting the quote paid.

The fixture request is unsigned. SEP-0007 origin-domain signatures require an origin domain and signing
key; neither is introduced in this compatibility task. Quote expiry is returned in the CDK response
and enforced against ledger close time because SEP-0007 has no standard payment-expiry parameter. The
software must not claim that the URI itself signs or embeds expiry.

The initial observer accepts direct `payment` operations only. Path payments, account creation, and
other payment-like operations advance the Horizon cursor but do not fund a quote. A transaction hash
and an operation id can each fund at most one quote. This intentionally disallows batched mint deposits
within one Stellar transaction.

## Deposit Finality and Cursor Rule

For this profile, final means all of the following:

- the verified Horizon endpoint reports the configured network passphrase;
- the operation and joined transaction report matching transaction ids and hashes;
- the joined transaction is successful and has a positive closed-ledger sequence;
- the operation destination, asset code, issuer, memo, and amount match exactly; and
- the ledger close time is no later than quote expiry.

Stellar consensus produces one transaction set for a closed ledger, so the profile does not add a
proof-of-work confirmation count. A successful historical Horizon transaction joined to a closed
ledger is the product finality boundary.

Observations are processed in ascending paging-token order. Rejected relevant payments still advance
the cursor atomically so they do not block ingestion. Late and malformed transfers require a separate
manual recovery process and never authorize issuance automatically.

## Melt Quote and Payout

The implemented NUT-05 adapter accepts the same strict SEP-0007 subset and validates destination,
network, asset, integer-cent amount, limits, and duplicate parameters before persisting a melt record.
It returns a zero rail fee for the fixture; production fee policy is not selected here.

The recovery sequence is:

1. Move `unpaid` to `proofs_reserved` before preparing any payout.
2. Ask an external signer port for one exact signed envelope and transaction hash.
3. Atomically persist that envelope and hash while proofs remain reserved.
4. Persist `dispatch_started=true` before calling the network submission port.
5. Observe the transaction hash before every possible submission or recovery action.
6. Map accepted submission to `submitted`, matching final success to `paid`, authoritative rejection
   to `failed`, and indeterminate outcome to `needs_attention`.
7. Return CDK `PENDING` for reserved/submitted, `UNKNOWN` for manual attention, and nonzero total spent
   only for `PAID`.

A crash before submission can retry the exact persisted envelope. A crash after an external effect
observes the same hash before proceeding. Re-submitting an identical Stellar envelope cannot create a
second transaction effect, while a different hash is a hard conflict. Once an ambiguous result is
durably recorded, automatic calls observe only and never create another payout.

## Acquirer Quote Boundary

`packages/cashu` now implements the client side of custom-method NUT-05 quote creation and checking.
It sends the exact `{ amount, request, unit: "usdc" }` body to
`POST /v1/melt/quote/stellar` on one configured HTTPS mint and checks only
`GET /v1/melt/quote/stellar/{quote_id}`. The transport omits credentials, rejects redirects and endpoint
substitution, bounds time and response bytes, supports cancellation, and performs no automatic retry.
It does not assume NUT-19 response caching.

Before the POST, the client validates the same permitted SEP-0007 parameter set, exact testnet network
and USDC issuer, checksum-valid G- or M-address, 1 through 25,000 cent range, and exact integer-cent
amount. It preserves the original URI for byte-for-byte response binding. The caller must still select
the destination from server-owned merchant or settlement configuration; address validity alone is not
payout authorization.

A created quote must be `UNPAID`, unexpired, no more than 900 seconds from creation, and use a canonical
UUIDv7. Its method, unit, request, amount, fee reserve, mint, and expiry are then immutable across
checks. `PENDING` may return to
`UNPAID` after a failed attempt, while `PAID` is terminal for the client. Current CDK generates UUIDv7
for new quote IDs; the older UUID injected by one processor fixture is not accepted at this HTTP
boundary. Responses are projected onto common quote fields. Payment preimages and unknown fields are
discarded, and nonempty NUT-08 change fails closed until matching blinded-output data can be persisted.
One shared deterministic response fixture is accepted by the TypeScript client and decoded by pinned
CDK `MeltQuoteCustomResponse` types.

This quote state is not settlement evidence. The client does not store the quote, decrypt proofs,
execute a melt, interpret `PAID` as proof consumption, release a reservation, or write accounting. A
future coordinator must persist one quote and exact dispatch intent before accessing bearer custody,
then combine the operator outcome with the existing exact NUT-07 evidence rules.

## Durable Journal Scope

The compatibility store writes a versioned JSON journal through write, file sync, atomic rename, and
directory sync. The file is created with owner-only permissions on Unix. It proves restart behavior for
one processor process.

It is not a production multi-process database. It has no cross-process lock, encryption, backup policy,
schema migration framework, or operator console. A signed envelope is dispatch-capable and is persisted
to support recovery, so production storage must place it in an encrypted, access-controlled signing
domain. The public debug implementations redact envelope bytes.

The event stream is cancellation-aware but does not emit events in this spike. Stock CDK can poll the
implemented incoming and outgoing status methods. A production observer should add durable event
delivery without making an event callback the source of accounting truth.

## Error Categories

Internal validation distinguishes unsupported method or unit, wrong network, wrong destination,
wrong asset code, wrong issuer, amount mismatch, expiry, unknown correlation, stale cursor, operation
replay, transaction replay, quote conflict, payout rejection, pending submission, and manual attention.
Raw Horizon, CDK, filesystem, and signing details are not adopted as stable merchant-facing schemas.

## Not Yet Proven

- live testnet mint issuance through a running `cdk-mintd` process;
- transaction construction, signing, or submission with a funded Stellar account;
- origin-domain signing for SEP-0007 requests;
- production database concurrency and encrypted envelope storage;
- event-driven quote updates;
- a running `cdk-mintd` interoperability test for the acquirer quote client;
- fees, late-payment return, or sub-cent recovery policy;
- multiple operators sharing a clearing or settlement store; and
- NUT-18 payment payload receipt and proof acceptance; strict request construction is fixture-proven.

No mainnet transaction, funded testnet transaction, or public mint is authorized by this profile.

## References

- [CDK `v0.18.0-rc.3` release](https://github.com/cashubtc/cdk/releases/tag/v0.18.0-rc.3)
- [CDK custom-method gRPC work, PR #2275](https://github.com/cashubtc/cdk/pull/2275)
- [Cashu NUT-01 units](https://github.com/cashubtc/nuts/blob/main/01.md)
- [Cashu NUT-05 melt quotes and execution](https://github.com/cashubtc/nuts/blob/main/05.md)
- [Cashu NUT-08 fee-return change](https://github.com/cashubtc/nuts/blob/main/08.md)
- [Cashu NUT-19 cached responses](https://github.com/cashubtc/nuts/blob/main/19.md)
- [SEP-0007 URI scheme](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md)
- [Stellar network identities](https://developers.stellar.org/docs/networks)
- [Stellar consensus protocol](https://developers.stellar.org/docs/learn/fundamentals/stellar-consensus-protocol)
- [Circle testnet USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

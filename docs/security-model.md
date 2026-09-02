# Security and Trust Model

## Scope

This model covers the CashMesh software boundary: merchant console, acquirer, operator integration, and
Stellar settlement adapter. It is not an audit, legal opinion, proof of operator solvency, or guarantee
of Cashu or Stellar implementations.

## Assets

- Cashu bearer proofs and their reserved/spent state.
- Mint signing keys.
- Stellar reserve and payout keys.
- Merchant balances and settlement obligations.
- Quote, invoice, receipt, refund, and transaction identifiers.
- Operator manifests, limits, and suspension state.
- Customer and merchant metadata.
- Reconciliation cursors and audit evidence.

## Actors

- Payer using a compatible Cashu wallet.
- Merchant and authorized cashier.
- CashMesh acquirer operator.
- Independent Cashu mint operator.
- Stellar asset issuer and network validators.
- Anchor or payout provider in later deployments.
- External attacker, dishonest payer, compromised merchant account, or dishonest operator.

## Trust Boundaries

1. Wallet to acquirer: bearer proofs and invoice binding cross an untrusted network.
2. Acquirer to Cashu operator: spent-state checks, swaps, and melts depend on a custodian.
3. Operator to Stellar: public settlement depends on exact network and asset configuration.
4. Acquirer to merchant: ledger state and webhook delivery affect merchant fulfillment.
5. Operations to key custody: application processes must not gain unnecessary signing authority.

## Required Invariants

- An exact deposit can fund at most one mint quote.
- A settlement identifier can produce at most one successful payout.
- Proofs remain reserved while a payout effect may exist.
- Submitted is not paid; paid requires an observed matching transaction.
- A different transaction hash for the same settlement is a hard conflict.
- Every monetary value is a bounded integer minor-unit amount.
- Every paid invoice is persisted atomically with one exactly balanced payment journal.
- Invoice-payment journals bind the invoice, merchant, payment, operator, and settlement mode.
- Trusted e-cash assets remain separated by operator in every posting.
- Operator tiers and caps are evaluated at payment time and recorded with the decision.
- A strict payment request lists only accepted operators and never advertises unlisted-mint support.
- Encoded request intent never replaces server-side invoice expiry, state, or replay enforcement.
- Stored `open` state never overrides the invoice's half-open validity interval.
- One merchant/idempotency-key pair commits at most one invoice and changed request terms fail.
- An issued invoice, encoded request, transport, and operator-policy snapshot commit atomically.
- An unverified payment envelope never returns success, reserves value, or changes invoice state.
- Offline proof integrity never substitutes for mint-observed unspent state or durable reservation.
- Bearer-proof plaintext enters durable storage only as reservation-bound authenticated ciphertext.
- One AES-GCM key and nonce pair is never reused, including after terminal ciphertext deletion.
- One canonical dispatch fingerprint is bound to at most one local effect for a mint and effect kind.
- Ambiguous operator evidence never releases proof or invoice claims.
- Post-dispatch release requires a matching terminal failure and a later exact all-`UNSPENT` snapshot.
- A checked melt quote may change state but never its mint, method, unit, request, amount, fee, identity,
  or expiry; an observed `PAID` quote never regresses locally.
- One persisted creation attempt owns a payment; only its first insert authorizes the single POST, and
  transport ambiguity cannot become automatic retry permission.
- Every new melt effect matches the persisted payment, mint, quote ID, expiry, and dispatch-time
  `UNPAID` evidence; exact replay never authorizes another outbound call.
- A Stellar melt sends only after exact proof-value validation and explicit dispatch authorization;
  the current execution profile rejects every nonzero fee reserve and performs no automatic retry.
- A melt cannot be released as unpaid before its bound quote expires.
- A melt quote state never substitutes for exact reserved-proof state or matching effect evidence.
- Consumption requires matching success and a later exact all-`SPENT` snapshot.
- Merchant balances reconcile to immutable invoice and settlement references.
- Reserve visibility and redemption probes never become a solvency guarantee.

## Threats and Controls

| Threat | Impact | Initial control |
|---|---|---|
| Replayed Stellar deposit | Unbacked issuance | Quote-derived memo plus operation and transaction uniqueness |
| Wrong asset or issuer | Unbacked issuance | Exact network/code/issuer allowlist |
| Partial or rounded payment | Accounting loss | Integer quote amount and exact comparison |
| Duplicate payout after timeout | Reserve loss | Persisted exact envelope/hash, dispatch intent, observe-before-retry |
| Proof release after ambiguous effect | Double redemption | `needs_attention` state and proof reservation |
| One outbound operation bound to multiple payments | Conflicting recovery and double fulfillment | Unique mint, effect-kind, and dispatch-fingerprint binding |
| Melt released while its quote remains payable | Double redemption | Bound quote expiry plus post-expiry `UNPAID` and later all-`UNSPENT` evidence |
| Rebound or malformed Stellar melt quote | Wrong payout terms or unsafe recovery | Strict SEP-0007 request validation, UUIDv7 identity, immutable-term checks, and terminal `PAID` state |
| Duplicate quote creation after timeout | Correlation and abandoned remote state | Persist one attempt before POST; exact replay never reauthorizes creation and ambiguity is terminal for automation |
| Melt sent without a fresh local effect | Unrecoverable or duplicate bearer-value loss | Domain-separated exact request fingerprint plus strict pre-network authorization callback |
| Unhandled NUT-08 change | Lost recoverable value | Reject nonempty change until matching blinded-output data is durably recoverable |
| Dishonest or insolvent operator | Merchant loss | Per-operator tiers, caps, conversion policy, suspension, diversification |
| Forged merchant callback | Fulfillment without payment | Signed/replay-protected webhooks and merchant-side verification |
| Cashier account compromise | Fraudulent invoice or refund | Least privilege, location scope, audit log, strong authentication |
| Bearer-proof leakage | Direct value theft | Redacted handles, authenticated encrypted custody, scoped decryption, and terminal deletion |
| AES-GCM nonce reuse or ciphertext rebinding | Proof disclosure or substituted bearer value | Permanent key/nonce registry plus exact reservation metadata as associated data |
| DLEQ blinding factor forwarded to a mint | Issuance-to-spend correlation | Verify before custody and strip DLEQ from the stored spend bundle |
| Injected payment metadata | Secret or personal data retained in accounting | Project only declared schema fields into durable domain records |
| Wrong-merchant journal | Misstated merchant liability | Bind merchant in the reference and require one matching payable credit |
| Duplicate invoice payment | Double fulfillment or liability | Atomic open-to-paid transition plus database uniqueness constraints |
| Duplicate invoice creation | Conflicting checkout records | Merchant-scoped request fingerprint and transactional unique reservation |
| Cross-merchant invoice lookup | Metadata disclosure | Merchant-scoped query returning the same not-found result |
| Request rewritten after issuance | Payer redirection or changed accepted liability | Persist exact encoded bytes and normalized route decisions with the invoice |
| Oversized or imprecise proof payload | Resource exhaustion or wrong amount comparison | Raw JSON byte/proof caps and exact integer decoding before policy lookup |
| Forged keyset, signature, or denomination | Crediting counterfeit operator liability | Recomputed keyset IDs, validated public points, strict DLEQ, and exact key lookup |
| Oversized, redirected, or stalled keyset endpoint | Resource exhaustion or observation of the wrong host | Exact configured HTTPS paths, no redirects or credentials, response/time limits, and bounded concurrency |
| Malformed, redirected, or stalled proof-state endpoint | False state evidence, resource exhaustion, or observation by the wrong host | Exact configured HTTPS path, no redirects or credentials, response/time limits, and exact ordered `Y` binding |
| Regressed or partial proof-state history | Unsafe proof release or incomplete recovery evidence | Exact reservation proof-set binding, append-only observations, and terminal `SPENT` constraints |
| Key rotation during observation | Inconsistent activity, fee, expiry, and public-key evidence | Two matching metadata reads around unit-scoped key collection |
| Historical keyset ID reuse | Substituted keys, unit, fee, or expiry after prior acceptance | Cross-operator immutable identity fingerprints and append-only observations |
| Duplicate proof inside one payload | Inflated gross amount | Reject duplicate secrets before amount or fee acceptance |
| Same proof presented to concurrent payments | Conflicting operator effects or double fulfillment | Unique local `(mint URL, Y)` reservation in one database transaction |
| Dust proof fee exhaustion | Merchant receives less redeemable value than invoiced | Mixed-keyset NUT-02 fee calculation with integer round-up |
| Stale or replayed NUT-18 request | Payment against an invalid invoice | Server-side invoice lookup, half-open expiry check, and unique payment reservation |
| Unsafe request endpoint | Credential leakage or payer redirection | Normalized HTTPS URLs without credentials, queries, or fragments |
| False advisory-mint claim | Proofs arrive from an unsupported operator | Omit `mp` and reject advisory construction until catch-all conversion exists |
| Edge correlation | Privacy loss | Data minimization, retention limits, batching research, honest disclosure |
| Dependency compromise | Code/key compromise | Exact versions, lockfiles, review, minimal dependencies, CI checks |

## Privacy Boundary

Cashu blind signatures can prevent an operator from directly linking properly blinded issuance outputs
to later valid proofs. Internal token transfer does not appear on Stellar.

CashMesh does not hide everything:

- Stellar deposits and merchant settlements are public.
- Operators see quote amount, time, completion, and redemption details.
- A Stellar melt request reveals its destination, amount, asset tuple, memo if present, and check timing
  to the selected operator.
- The acquirer sees merchant, invoice, amount, operator, and settlement state.
- A NUT-18 request reveals its invoice identifier, amount, accepted mints, and transport endpoint.
- Stored or mint-queried NUT-07 `Y` references can correlate presentation attempts and queried proof
  groups even though they cannot spend a proof.
- Network and application metadata can correlate parties.
- Exact amounts and timing can correlate entry and exit.
- Stablecoin issuer controls remain in force.

Do not describe this as anonymous, trustless, self-custodial, sanctions-resistant, or private at every
edge.

## Secret Handling

- Keep Cashu signing keys and Stellar payout keys in separate security domains.
- Do not place secrets in source, `.env.example`, tests, fixtures, snapshots, logs, screenshots, or
  issue reports.
- Use test-only keys that cannot control value when deterministic signatures are required.
- Redact bearer tokens and complete payment requests from telemetry by default.
- Treat database backups, dead-letter queues, and tracing systems as potential secret stores.
- Destroy initial and restored bearer-bundle byte arrays as soon as their scoped use ends. Treat this as
  best effort because immutable strings, runtime copies, and crash memory may survive.
- Keep active and historical custody keys outside source and ordinary database roles. Key retirement
  must account for live rows, replicas, WAL, snapshots, and backup retention.
- Treat a signed Stellar envelope as dispatch-capable data: encrypt it at rest and never include it in
  debug output, telemetry, screenshots, or support artifacts.

## Compatibility Store Boundary

The current JSON journal uses atomic replacement and owner-only Unix permissions to test restart
invariants. It is safe only for one processor process in an unfunded environment. It does not provide
cross-process locking, encryption, access audit, backup recovery, or production migrations. Those are
deployment gates, not optional hardening.

## Acquirer Database Boundary

PostgreSQL now stores open invoices, idempotency fingerprints, public Cashu keyset evidence,
non-spendable proof references, proof-state evidence, and reservation lifecycle history. Database
constraints repeat identifier, amount, unit, schema, ownership, expiry-shape, evidence-cardinality,
transition, and active-claim invariants. Concurrent invoice creation is serialized by a unique
merchant/key reservation, and invoice plus reservation commit together.

The same transaction stores the strict Cashu request and one through 16 operator routes. Deferred
constraints prevent a request with no accepted route. Reads reconstruct the request through the pinned
adapter and reject a stored policy or encoded value that does not match. Production configuration is
server-owned; merchant HTTP input cannot claim that an arbitrary mint is trusted.

Fastify automatic request logging is disabled because route paths contain merchant and invoice
identifiers. Storage and initialization failures log only a stable error class name; expected payment
rejections do not create one log entry per public request. Any future access telemetry must use route
templates or explicit low-cardinality labels and must not record URLs, idempotency keys, encoded
requests, proof payloads, or operator credentials.

The NUT-18 POST route parses at most 64 KiB and 128 proofs from raw JSON, projects only non-secret
envelope metadata, and binds it to the stored invoice request. It always rejects after these checks.
That route persists nothing and no successful response exists until proof validation and accounting can
commit atomically.

The Cashu adapter can validate standard `00` and `01` keysets, strict DLEQ evidence, and exact input
fees from an explicit public snapshot. It accepts inactive keysets before final expiry but rejects
deprecated base64 and experimental `02` keyset IDs. Its bounded client can observe public NUT-01/02
data for one unit from a server-configured HTTPS host and rejects metadata that rotates during the
read. HTTPS does not make the result a signed operator statement. A separate PostgreSQL repository
stores append-only identities and observations, rejects historical version `00` unit, fee, or expiry
changes across operators, and requires callers to provide inclusive freshness bounds. It has no
automatic observer schedule and is not connected to payment acceptance. Offline validation alone
cannot establish NUT-07 state, and NUT-21 and NUT-22 credentials are not handled. The adapter and
keyset store return no bearer fields. A received NUT-12 blinding factor must never be logged, persisted
outside encrypted proof custody, or forwarded to the mint, where it would reveal an issuance-to-spend
link.

After offline validation, a separate repository can reserve only `Y`, keyset ID, and amount. The
reservation is bound to an issued invoice/operator/mint route and exact keyset observation, commits all
proof references atomically, and makes each `(mint URL, Y)` active for at most one payment. It
deliberately stores no secret, signature, DLEQ value, witness, memo, or raw payload. `Y` remains
correlation-sensitive and is excluded from telemetry and merchant-facing responses.

A separate bounded observer can send only reserved-style `Y` references to one configured mint's
NUT-07 endpoint and return an in-memory `UNSPENT`, `PENDING`, or `SPENT` snapshot. It enforces exact
response order and cardinality and discards any witness, but the query itself discloses the grouped
references and timing to that mint. A separate PostgreSQL repository can persist the complete snapshot
against the exact payment reservation, require explicit freshness bounds, and prevent state from
regressing after `SPENT`. It stores no witness or bearer field. The evidence is an operator assertion
that can become stale immediately and cannot establish payment or solvency by itself.

A lifecycle repository separately binds one immutable swap or melt effect and an append-only sequence
of state changes. A canonical dispatch fingerprint prevents the same outbound operation from being
attached to multiple local payments. Melt effects also bind a quote ID and expiry. Ambiguity enters
`needs_attention` and retains active proof and invoice claims. Consumption requires matching success
plus exact all-`SPENT` evidence. Post-dispatch release requires matching terminal failure plus exact
all-`UNSPENT` evidence; melt release additionally requires the `UNPAID` outcome at or after quote
expiry. Database triggers repeat these rules and require active projections to agree with history.

The lifecycle stores only sanitized identities, outcomes, timestamps, and state-snapshot fingerprints.
It does not authenticate the outcome source, hold or send bearer proofs, call a mint, mark an invoice
paid, or write a journal. The separate execution adapter computes canonical dispatch bytes and keeps
secrets, signatures, DLEQ values, witnesses, tokens, and raw responses out of lifecycle storage and
telemetry.

A bounded Stellar quote client can create and check the current custom-method NUT-05 quote on one
configured HTTPS mint. It validates the exact testnet asset, network, integer-cent amount, permitted
SEP-0007 fields, and Stellar destination checksum before the POST. It accepts only complete current
common fields, UUIDv7 identity, and an expiry inside the 900-second profile, then requires every check
to match the original request, amount, fee, method, unit, mint, and expiry. It performs no automatic
retry, discards undeclared fields and payment preimages, and rejects nonempty NUT-08 change. The quote
client has no bearer-custody access, protected-mint authentication, execution method, lifecycle write,
or accounting authority.

A separate PostgreSQL repository persists one exact attempt against an open invoice, active proof
reservation, encrypted custody record, issued operator, and mint before creation. Only the first insert
authorizes one POST; replay is recovery-only. One immutable outcome records either transport ambiguity
or the initial `UNPAID` quote, and append-only observations preserve exact terms and terminal `PAID`
history. Full requests, destinations, quote IDs, and timing remain correlation-sensitive. This boundary
is enforced by the lifecycle repository and a database trigger: a new melt effect must match the stored
mint, quote ID, expiry, and current `UNPAID` evidence. Later state observations do not invalidate the
historical dispatch binding, but they also do not prove exact proof consumption.

A bounded Stellar execution client converts one live custody bundle into the exact custom NUT-05 melt
body. It requires a matching unexpired `UNPAID` quote, zero fee reserve, and proof total equal to the
quote amount plus the caller-supplied validated NUT-02 input fee. A domain-separated SHA-256 fingerprint
binds the normalized endpoint, method, and exact body. Only a strict authorization callback result can
precede the one outbound request. The transport is credential-free, bounded, redirect-free, and
non-retrying. Returned state is sanitized and immutable terms must match. The adapter does not prove
that the callback wrote durable state, so only the acquirer coordinator supplies that authorization.
Any error after authorization remains recovery-sensitive.

The coordinator loads reservation, lifecycle, quote, and the exact historical keyset evidence before
opening custody. It derives NUT-02 fees from the reserved proof set, selects an executor by the bound
mint URL, and returns authorization only for a fresh, non-replayed effect insert. Returned observations
must fall between effect start and the coordinator's post-response clock. `PENDING` is persisted;
transport ambiguity, invalid responses, unknown results, clock disagreement, or post-dispatch storage
failure enter `needs_attention`. None of those paths releases proofs or permits an automatic retry, and
`PAID` does not itself authorize consumption or merchant credit. If attention storage is unavailable,
the already durable effect remains recovery-only rather than permitting redispatch.

A dedicated custody repository can persist the minimum spend bundle as AES-256-GCM ciphertext. It binds
the key ID and an exact reservation fingerprint as associated data, records every 96-bit nonce in an
append-only key/nonce registry, permits only immutable pre-dispatch custody, and deletes the current
ciphertext in the transaction that records `consumed` or `released`. It reconstructs plaintext only
inside a callback whose bundle is destroyed afterward. Restored bundles cannot be resubmitted as newly
validated input, and spending conditions are rejected before custody.

This does not make application memory, PostgreSQL, or backups non-custodial. Row deletion does not
physically erase old PostgreSQL page versions, WAL, replicas, snapshots, or backups. JavaScript byte
wiping cannot erase immutable strings or undiscovered runtime copies. The built-in key-provider port has
no production KMS or HSM adapter, access audit, per-record envelope key, or cryptographic-erasure
mechanism. Decryption alone is not dispatch authorization: the coordinator binds durable effect intent
before it allows the execution client's authorization callback to return `true`.

This is not authorization or a production data-protection program. The local Compose credentials are
test-only. A deployed database requires encrypted transport and storage, least-privilege credentials,
credential rotation, network isolation, access auditing, tested backups and point-in-time recovery,
retention rules, and merchant authentication before the API is exposed.

## Mainnet Gates

Mainnet custody or merchant settlement requires all of:

- named operating entities and qualified jurisdictional review;
- independent security review;
- production key custody and rotation plan;
- tested incident and redemption-only procedures;
- per-quote, daily, operator, and total-liability caps;
- reconciliation and backup recovery drills;
- a merchant dispute, refund, and support process; and
- explicit approval to use funded accounts.

Passing repository tests does not satisfy these gates.

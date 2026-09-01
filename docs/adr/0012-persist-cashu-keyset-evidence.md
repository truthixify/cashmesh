# ADR-0012: Persist Cashu Keyset Identity and Observation Evidence

**Status:** Accepted

**Date:** 2026-09-01

## Context

Offline proof verification cannot safely depend on an in-memory NUT-01 and NUT-02 read. CashMesh
must retain which keys were observed, which operator configuration selected the mint, and when the
observation completed. It must also recognize keyset identifier reuse after restart. NUT-02 warns
clients to reject an imported keyset ID that collides with a previously added keyset.

A keyset's activity flag can legitimately change during rotation. Its public keys, unit, input fee,
and final expiry cannot change after CashMesh first accepts the `(mint URL, keyset ID)` identity. A
version `00` identifier commits only to a truncated hash of the public keys, so CashMesh must enforce
the additional unit, fee, and expiry invariants itself. Operator identity is not part of mint keyset
identity: two configured operators pointing at the same URL must not create separate collision
histories.

Freshness is use-case policy. A scheduler, payment service, or recovery job may require different
maximum ages, and a future-dated observation must never satisfy a current lookup.

## Decision

Store immutable keyset identities separately from timestamped operator observations in PostgreSQL.
Key immutable identities by normalized mint URL and keyset ID, and retain their unit, input fee,
optional final expiry, canonical denomination keys, and SHA-256 identity fingerprint. On every write,
insert or load that identity and reject any fingerprint mismatch as a keyset collision. The collision
boundary spans operators but not distinct mint URLs; observation times remain on the append-only
observation records instead of being duplicated on the identity.

Store each observation under a SHA-256 fingerprint covering operator ID, normalized mint URL, unit,
schema version, observation time, ordered keysets, activity flags, and immutable material. Permit one
observation for an `(operator, mint, unit, observed-at)` tuple. An exact repeat is an idempotent replay;
a different snapshot at that same tuple is an observation conflict. A later observation may change
activity flags while continuing to reference the same immutable keysets.

Persist the identity checks, observation row, and ordered entries in one transaction. Use uniqueness
constraints plus insert-on-conflict and follow-up reads so concurrent writers converge on one result.
A deferred database trigger requires every committed observation to contain at least one entry.
Row-level update and delete triggers make keyset identities, observations, and their entries
append-only; rotation creates another observation instead of rewriting evidence.

Expose a latest-fresh lookup with caller-supplied inclusive lower and upper observation timestamps.
Scope it by operator, normalized mint URL, and unit. Reconstruct every returned snapshot through the
existing keyset validator and recompute both identity and snapshot fingerprints; malformed or
inconsistent stored data fails closed.

Do not schedule observations, call a mint, query NUT-07 state, persist bearer proofs, reserve value,
or make payment acceptance successful in this capability.

## Consequences

- CashMesh retains collision history across restart and operator-configuration changes.
- Normal rotation can change activity without mutating historical observations.
- Version `00` IDs cannot silently acquire a different unit, fee, or final expiry after first use.
- Exact concurrent writes are idempotent; conflicting concurrent writes produce a stable domain
  error and roll back partial identity inserts.
- Application-role row updates and deletes fail below the repository boundary; administrative backup,
  retention, and disaster-recovery operations remain deployment responsibilities.
- Callers must choose and record their freshness policy explicitly, including a current-time upper
  bound.
- SHA-256 fingerprints are integrity cross-checks for application reads, not signatures or proof of
  mint honesty, operator authorization, availability, redemption, or solvency.
- Stored public keys are validation material. No bearer secrets, blinded messages, or credentials
  belong in these tables.

## Revisit When

Define scheduler ownership, observation cadence, retention, and alerting before automatic refresh is
enabled. Add authenticated key reads only after NUT-21 or NUT-22 credential storage and request
isolation are designed. NUT-07 state evidence, encrypted proof reservation, paid-invoice accounting,
and redemption remain separate security boundaries.

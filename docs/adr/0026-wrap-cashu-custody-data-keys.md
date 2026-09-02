# ADR-0026: Wrap Per-Record Cashu Custody Data Keys

**Status:** Accepted

**Date:** 2026-09-02

## Context

ADR-0017 encrypts the minimum Cashu spend bundle with AES-256-GCM and obtains active and historical
content keys through a local provider port. That protects database rows from plaintext disclosure, but
one long-lived application key still encrypts every record. Giving the acquirer that key also gives it
direct access to every live ciphertext, and rotating the key leaves a growing set of raw historical
keys in application configuration.

Production key services instead expose non-exportable key-encryption keys and return a plaintext data
key together with an encrypted copy. CashMesh needs that boundary without selecting a cloud vendor or
pretending that an interface alone supplies credential isolation, access policy, audit evidence, or
incident procedures. Existing `aes-256-gcm-v1` rows must remain readable during a controlled upgrade;
rewriting live bearer value merely to adopt a new envelope format would add avoidable risk.

## Decision

This decision supersedes ADR-0017 only where that decision described direct content-key provision and
left envelope encryption unimplemented. Its bearer-bundle, reservation, lifecycle, and retention
boundaries remain in force.

Add `aes-256-gcm-envelope-v2` as the active custody write format. Obtain a fresh 256-bit plaintext data
key and its wrapped form for every record through a provider-neutral data-key port. The provider returns
the immutable wrapping-key version ID and must cryptographically authenticate a non-secret context
derived from the custody domain and exact reservation binding. A cloud KMS adapter can implement this
with a generated data-key operation or local cryptographic randomness followed by a wrap operation.

Use the plaintext data key only for one AES-256-GCM operation. The provider transfers ownership of each
plaintext byte buffer to the cipher and must not cache or reuse it; the cipher overwrites it in a
`finally` block after encrypt or unwrap. This is best-effort exposure reduction in a
garbage-collected runtime; it is not a guarantee that native-library copies, crash memory, or provider
internals are erased.

Authenticate the algorithm, wrapping-key ID, SHA-256 data-key fingerprint, SHA-256 digest of the wrapped
key, and exact reservation binding with the ciphertext. On read, require the provider to unwrap under
the same context, recompute the data-key fingerprint before decryption, and fail closed for missing key
versions, invalid provider output, metadata substitution, or GCM authentication failure. Provider and
cryptographic errors exposed outside the cipher remain sanitized.

Persist the wrapping-key ID, wrapped data key, and data-key fingerprint beside ciphertext. Retain the
existing append-only key/nonce history for v1 and add a permanent unique v2 data-key fingerprint. A
duplicate fingerprint rejects a faulty provider that returns the same data key for another payment,
including after terminal ciphertext deletion. The fingerprint is a verifier for a uniformly random
256-bit secret and must not be used as key material.

Keep the original v1 record-fingerprint bytes unchanged. The envelope cipher may read v1 only when an
explicit legacy cipher with the required historical key is supplied, and it always writes v2.
Migration 14 backfills v1 key-use metadata without decrypting or rewriting ciphertext and adds
database checks that require the nonce-history and custody rows to agree on algorithm and data-key
identity. Ordered table locks let an already-running v13 writer finish before the schema change. After
migration, the v1 database default and nullable envelope columns let an older application instance
continue writing legacy records during the rolling-upgrade window.

## Consequences

- PostgreSQL and its ordinary application role retain ciphertext, envelope metadata, and wrapped data
  keys, but not plaintext data keys or the wrapping key.
- Compromise of one plaintext data key is limited to one record. Compromise or misuse of a wrapping
  key can still expose every retained envelope under that key.
- Wrapping-key rotation changes new writes without rewriting existing ciphertext. Historical key
  versions remain required while their wrapped records or retained backups can still be restored.
- Terminal deletion removes the current wrapped data key with the ciphertext while retaining only the
  non-secret reuse fingerprint and lifecycle evidence. WAL, replicas, snapshots, and backups can retain
  the deleted envelope until their separate retention windows expire.
- The repository detects accidental data-key reuse but cannot prove that a provider uses an approved
  random source, protects its wrapping key, or enforces the requested context.
- No AWS, Google Cloud, Azure, Vault, or HSM adapter is selected or wired into the API server. Production
  use still requires an adapter, workload identity, least-privilege policy, access logging, rotation and
  disablement procedures, restore testing, alerts, and independent review.
- The public payment endpoint remains non-accepting and no funded network effect is added.

## Revisit When

Select the deployment key service and implement its adapter. Test provider-side context enforcement,
old-key reads, disabled-key behavior, throttling, timeout handling, access logs, backup restore, and
emergency lockout before funded custody. Revisit the legacy reader after all live v1 rows and relevant
backup retention windows have expired.

## References

- [ADR-0017: Protect Cashu Bearer Proofs in Encrypted Custody](0017-protect-cashu-bearer-proof-custody.md)
- [Google Cloud KMS envelope encryption](https://cloud.google.com/kms/docs/envelope-encryption)
- [AWS KMS data keys](https://docs.aws.amazon.com/kms/latest/developerguide/data-keys.html)
- [AWS KMS encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html)
- [NIST SP 800-38D: GCM and GMAC](https://csrc.nist.gov/pubs/sp/800/38/d/final)

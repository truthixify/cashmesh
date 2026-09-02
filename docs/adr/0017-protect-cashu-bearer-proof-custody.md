# ADR-0017: Protect Cashu Bearer Proofs in Encrypted Custody

**Status:** Accepted

**Date:** 2026-09-02

## Context

CashMesh can validate Cashu proofs offline, reserve their non-spendable NUT-07 references, and preserve
an operator-effect lifecycle. A future NUT-03 or NUT-05 adapter still needs the proof amount, keyset ID,
secret, and signature. Those fields are bearer value: disclosure can let another party spend the proofs.
The proof-side NUT-12 DLEQ also contains the payer's blinding factor and must not be forwarded to the
mint, while NUT-10 secrets and witnesses require spending-condition verification that CashMesh does not
yet implement.

Keeping raw payment JSON or ordinary proof objects in application records would spread bearer value
through logs, errors, telemetry, database tools, and backups. Encryption alone is also insufficient if
ciphertext can be rebound to another reservation, an AES-GCM nonce can be reused, keys cannot rotate,
or terminal records remain retrievable indefinitely.

## Decision

Create a versioned `CashuBearerProofBundleV1` only as a second result of the custody-specific offline
validator. The bundle contains a canonical, sorted projection of invoice, mint, unit, and the minimum
proof spend fields. It excludes the raw payload, memo, DLEQ, and undeclared fields. Reject every witness
and well-known NUT-10 secret until its spending condition has a dedicated verifier. Ordinary JSON,
inspection, and string conversion expose only redacted metadata. Bearer plaintext is available only
through an explicit serialization method, and the handle supports best-effort destruction.

Track initial-validation provenance in a module-private identity registry. Restored plaintext can be
used after authenticated decryption but cannot be submitted as newly validated custody input. The
caller that receives the initial bundle owns its lifetime and must destroy it in a `finally` block after
storage. Repository reads use a scoped callback and destroy the restored bundle after the callback,
including when the callback fails.

Encrypt canonical bundle bytes with AES-256-GCM using a random 96-bit nonce and a 128-bit authentication
tag. Bind the algorithm version, key ID, and a SHA-256 fingerprint of the exact payment, invoice,
operator, mint, unit, reservation time, proof references, and custody time as associated data. Obtain
active and historical 256-bit secret keys through a key-provider port so rotation does not rewrite
ciphertext. Return sanitized key-unavailable, integrity, conflict, and storage errors.

Persist one immutable ciphertext row per active payment reservation. Permit initial storage only while
the invoice is open, the reservation is pre-dispatch, every proof claim is active, and the custody time
is inside the invoice interval. Keep an append-only `(key ID, nonce)` registry after ciphertext deletion
so the same AES-GCM key and nonce cannot be reused by a later payment. Exact concurrent writes converge;
changed terms conflict. Database triggers repeat reservation, cardinality, mutation, and deletion rules.

Delete the current ciphertext in the same transaction that appends a terminal `consumed` or `released`
lifecycle event. Retain the nonce-use record and sanitized lifecycle evidence. This logical deletion is
data minimization, not guaranteed physical erasure: old page versions, WAL, replicas, snapshots, and
backups may retain ciphertext until their own retention windows expire.

The scoped decryption API is not permission to contact a mint. It releases its database lock before the
callback and carries no operator effect identity. A dispatch coordinator must first durably bind the
exact effect and canonical request fingerprint, then use the decrypted bundle only for that effect. It
must never forward DLEQ material and must preserve ambiguous outcomes instead of retrying blindly.

## Consequences

- Bearer fields are no longer represented in ordinary validation results or plaintext database columns.
- Ciphertext substitution, reservation rebinding, key-ID substitution, and storage corruption fail
  closed before a bundle is returned.
- Historical keys are required until all ciphertext and relevant backup copies have expired. Losing a
  key makes its active proofs unrecoverable; retaining a key preserves the ability to decrypt backups.
- JavaScript zeroization is best effort. Immutable strings, request buffers, runtime copies, crash dumps,
  and garbage-collected memory can outlive the explicit byte-array wipe.
- The built-in cipher and key-provider port establish an application boundary, but no production KMS,
  HSM, access audit, envelope-key scheme, or cryptographic-erasure mechanism is implemented.
- A database writer can still deny service or exfiltrate ciphertext. Production requires least-privilege
  roles, encrypted transport and disks, monitored key access, and tested backup retention.
- The public payment endpoint remains non-accepting. No mint request, invoice transition, journal,
  receipt, or funded operation is added by this decision.

## Revisit When

Add the bounded NUT-03/NUT-05 operator adapter and its effect coordinator. Define canonical outbound
bytes, response authentication and bounds, retry and ambiguity behavior, and the transaction that binds
effect intent before bearer access. Before funded deployment, select a production key-management and
backup-erasure model and test rotation, loss, restore, and incident procedures.

## References

- [Cashu basic notation and proofs](https://github.com/cashubtc/nuts/blob/main/00.md)
- [Cashu NUT-11 spending conditions](https://github.com/cashubtc/nuts/blob/main/11.md)
- [Cashu NUT-12 DLEQ proofs](https://github.com/cashubtc/nuts/blob/main/12.md)
- [Node.js cryptography API](https://nodejs.org/api/crypto.html)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [OWASP Key Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html)

# ADR-0006: Isolate the NUT-18 Request Adapter

**Status:** Accepted

**Date:** 2026-09-01

## Context

CashMesh needs current NUT-18 fields for strict mint selection and the custom `stellar` melt method.
The stable cashu-ts release does not expose all of those fields, while `5.0.0-rc.8` does. Pulling a
release-candidate protocol library into the domain would make core accounting and policy behavior
depend on a moving wire implementation.

NUT-18 advisory mint semantics also create a policy obligation: `mp=true` says that a receiver accepts
mints outside its list. CashMesh currently rejects unlisted operators, so advertising that capability
would be false.

## Decision

Create a separate `packages/cashu` adapter with an exact `@cashu/cashu-ts@5.0.0-rc.8` dependency. The
adapter accepts validated domain invoices and operator policy inputs and returns a versioned,
immutable sidecar plus a `creqA` string. It does not expose the mutable upstream request object.

Emit only strict requests: list normalized accepted mint URLs in `m` and omit `mp`. Advertise the
custom `stellar` method, a single HTTPS POST transport, integer `usdc` amount, and single-use intent.
Do not add descriptions, NUT-10 conditions, or non-standard expiry fields.

Keep expiry in the sidecar because NUT-18 has no expiry field. Treat server-side invoice state and
database uniqueness as the enforcement boundaries for expiry and replay.

Maintain one deterministic encoded fixture. Decode it with both the pinned cashu-ts version and pinned
CDK `0.18.0-rc.3` so a dependency change cannot silently alter the accepted wire shape.

## Consequences

- Core domain code remains independent of a release-candidate Cashu client.
- The emitted request is honest about the operators CashMesh will accept.
- `creqA` interoperability is fixture-proven across two implementations.
- Advisory mint selection, NUT-26 `creqB`, receipt handling, and proof verification remain separate
  capabilities.
- Upgrading either Cashu dependency requires review of the NUT-18 specification and regeneration of
  the fixture only when the intended wire contract changes.

## Revisit When

Revisit the strict-only decision after CashMesh has a bounded, tested conversion policy for unlisted
mints. Revisit the encoding after `creqB` wallet and QR interoperability is demonstrated. Replace the
release-candidate dependency when a stable cashu-ts version provides the required current fields and
passes the same cross-implementation fixture.

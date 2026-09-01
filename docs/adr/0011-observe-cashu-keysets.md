# ADR-0011: Observe Cashu Keysets Through a Bounded Read Client

**Status:** Accepted

**Date:** 2026-09-01

## Context

Offline proof validation depends on a complete NUT-01 and NUT-02 snapshot. A mint exposes keyset
metadata at `GET /v1/keysets` and the denomination keys for an active or inactive keyset at
`GET /v1/keys/{keyset_id}`. Those responses are separate and a rotation can change activity, fees, or
expiry while a client is collecting them. They are also untrusted network input and can be oversized,
malformed, redirected, or stalled.

CashMesh must obtain this public material without letting a Cashu library perform implicit network
requests, letting payer-controlled mint URLs become an SSRF surface, or treating one partial read as
durable operator evidence. HTTPS authenticates the configured endpoint and protects the connection; it
does not make the returned metadata a signed operator manifest or prove that the endpoint is honest.

## Decision

Define a `CashuMintKeysetSource` port in `packages/cashu` and a concrete HTTP client for server-owned,
allowlisted mint URLs. The client normalizes one HTTPS base URL and permits only credential-free `GET`
requests to the exact NUT-01 and NUT-02 paths. It disables redirects and cache reuse, omits credentials
and referrer metadata, and accepts no authentication token.

Each request has a five-second default timeout, configurable only up to 30 seconds. Each decoded
response has a 256 KiB default limit and a one MiB hard ceiling; chunked bodies are measured while
reading. The client makes one attempt. A scheduler may retry a complete observation later, but this
adapter does not hide partial failure through per-request retries.

Observe one explicitly requested unit at a time. Bound the metadata response to 256 entries, the
selected unit to 64 keysets, each keyset to the existing 256-key snapshot limit, and individual key
reads to four concurrent requests. Reject an ID repeated anywhere in the metadata response, including
across units, but do not fetch unrelated units. Require a specific-key endpoint to return exactly one
matching ID and unit, and require any activity, fee, or expiry metadata it includes to agree with the
keyset list.

Read `/v1/keysets` before and after collecting keys. Canonicalize the selected metadata and reject the
entire observation if any selected ID, unit, activity flag, input fee, or final expiry changed. Record
the snapshot time only after the second read and reject a clock that moved backwards. Finally, pass the
joined data through the version `1` snapshot validator, which verifies bounds, public points, keyset
IDs, and supported `00` or `01` secp256k1 versions.

Do not persist the result, establish a freshness lifetime, detect collisions against historical
observations, inspect NUT-07 state, handle NUT-21 or NUT-22 authentication, accept proofs, or change an
invoice in this capability. The HTTP client must only be constructed from server-owned operator
configuration, never directly from a payment payload.

## Consequences

- A successful result is a complete, internally consistent observation of one unit at one configured
  HTTPS endpoint.
- A rotation during collection causes a deterministic failure; the caller can schedule a fresh whole
  observation.
- One observation makes at most 66 requests: two metadata reads and one read for each of 64 keysets.
- Strict single-key responses may reject a nonconforming mint that returns unrelated entries from a
  specific-key endpoint.
- NUT-21 or NUT-22 protected key endpoints fail closed because this client does not hold clear or blind
  authentication credentials.
- Deterministic tests use generated test-only public keysets and mocked transport. They do not call a
  live mint or demonstrate operator authenticity, availability, redemption, or solvency.
- The payment endpoint remains terminally non-successful. An observed snapshot is public validation
  input, not evidence that a proof is unspent or reserved.

## Revisit When

Add a durable operator snapshot store keyed by operator, mint, unit, and observation. It must preserve
collision history, reject conflicting reuse of an existing ID, enforce an explicit freshness policy,
and prove restart/concurrency behavior. Review deployment SSRF controls and NUT-21/22 credential
handling separately before protected mints are supported. NUT-07 observation, encrypted proof
reservation, and payment accounting remain later boundaries.

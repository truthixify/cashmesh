# ADR-0007: Persist Invoice Issuance in PostgreSQL

**Status:** Accepted

**Date:** 2026-09-01

## Context

Invoice creation must survive restart and make concurrent retries converge on one record. The domain
constructors cannot enforce uniqueness across processes, and an in-memory repository would not prove
the merchant API's idempotency contract. The selected store must also support the later atomic
paid-invoice, proof-reservation, and journal transaction.

Node 24's built-in SQLite API remains experimental. Embedded PostgreSQL implementations do not provide
the multi-process server boundary CashMesh needs. A conventional PostgreSQL schema provides real
transaction isolation, uniqueness, foreign keys, operational tooling, and a direct path to the later
accounting transaction.

## Decision

Use PostgreSQL for acquirer state and isolate access behind an asynchronous invoice-repository port.
Pin `pg` exactly and test the adapter against the exact official PostgreSQL 18.6 container image.

Apply forward-only migrations at startup inside one transaction while holding a fixed transaction
advisory lock. Record both migration version and durable name, and refuse unknown or renamed history.

Scope invoice-creation idempotency keys to a merchant. Persist a SHA-256 fingerprint of the canonical
merchant, amount, expiry, and schema tuple. In one transaction, reserve the merchant/key pair, insert
the open invoice, and satisfy a deferred ownership foreign key. An exact replay returns the existing
invoice; changed terms fail; an invoice-id collision rolls back before retry.

Keep the initial schema deliberately limited to open invoices. Add terminal state, payment, proof,
journal, webhook, and receipt tables only with the transaction that enforces their full invariants.

## Consequences

- Local development needs Docker or another PostgreSQL 18 instance.
- Invoice creation and exact replay survive process restart and concurrent requests.
- Database constraints repeat critical domain bounds rather than trusting application validation.
- The API remains portable behind the repository port, but PostgreSQL behavior is the tested contract.
- The local Compose password is test-only and must never be reused in a deployed environment.
- Backups, point-in-time recovery, replication, credential rotation, row-level authorization, and
  idempotency retention remain deployment work.

## Revisit When

Revisit the adapter only if operational evidence justifies another transactional database without
weakening concurrency or accounting constraints. Extend this decision with a new ADR when payment
acceptance and the balanced merchant journal are persisted atomically.

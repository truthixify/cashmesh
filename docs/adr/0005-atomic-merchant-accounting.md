# ADR-0005: Pair Invoice Acceptance with a Balanced Journal

**Status:** Accepted

**Date:** 2026-09-01

## Context

CashMesh accepts liabilities from multiple Cashu operators and owes merchants after valid payment.
Changing an invoice to paid without recording the corresponding obligation creates untraceable value.
Recording a journal without changing the invoice permits duplicate fulfillment. A merely balanced
journal can still credit the wrong merchant or collapse distinct operator exposure.

The domain contract must work before a production database or proof-validation orchestrator is chosen.

## Decision

Use version `1` immutable invoice and journal records in integer US-cent units. Invoice validity is the
half-open interval from `createdAt` through, but excluding, `expiresAt`. Only an open invoice can become
paid, expired, or cancelled.

Accepting payment produces the paid invoice and its journal as one return value. Persistence adapters
must commit both records atomically and enforce unique invoice-payment, payment-id, and journal-id
constraints.

An invoice-payment reference binds the invoice, merchant, payment, operator, and settlement mode. The
journal permits one asset debit, one credit to that merchant's payable account, and an optional fee
credit. Trusted e-cash is debited to an account scoped by operator. Immediately converted value is
debited to a named settlement-asset account. Every entry must balance exactly within safe integer
bounds.

Domain constructors revalidate branded values at runtime and copy only declared schema fields. This
prevents type assertions, deserialized values, or incidental request metadata from silently weakening
the durable record.

## Consequences

- Merchant obligations cannot be represented without a balanced asset-side entry.
- Operator e-cash exposure stays attributable even when denomination and merchant are the same.
- The application must treat the returned invoice and journal as one persistence unit.
- Database uniqueness and transaction isolation remain mandatory; in-memory checks are insufficient.
- Payment acceptance does not itself prove Cashu proofs or conversion. Orchestration must complete those
  checks first.
- Refunds, conversion after a trusted hold, settlement, and corrections require new reference and
  journal-entry types rather than edits to historical entries.

## Revisit When

Add a new schema version when supporting another accounting unit, partial or multi-tender invoices,
refund and reversal entries, clearing, or accounting rules that cannot be represented without changing
the meaning of version `1` records.

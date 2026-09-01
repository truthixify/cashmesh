# ADR-0003: Prove Direct Settlement Before Network Clearing

**Status:** Accepted

**Date:** 2026-09-01

## Context

Prefunded merchant guarantees and net settlement can improve checkout speed and capital efficiency, but
they introduce counterparty credit, collateral, liquidity, default, and unwind requirements. The
project has no operating history or volume evidence yet.

## Decision

Begin with payments attributable to one issuing operator and use one of two modes:

- trusted hold: swap proofs, credit the merchant ledger, and settle later within a cap; or
- immediate conversion: melt proofs through the issuing operator to the merchant's Stellar account.

Do not implement network-guaranteed credit or multilateral netting until direct settlement is reliable
and the required risk controls are separately approved.

## Consequences

- The first merchant flow is easier to reconcile and audit.
- Merchants may wait longer or pay more for conversion.
- Operator exposure remains visible rather than hidden in a network balance.
- Clearing remains a product and legal decision, not an accidental optimization.

## Revisit When

Consider prefunding only after sustained volume, measured redemption reliability, named liquidity,
collateral and exposure rules, settlement windows, default procedures, and legal review exist.

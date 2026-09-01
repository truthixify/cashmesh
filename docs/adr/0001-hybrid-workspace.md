# ADR-0001: Use a Hybrid TypeScript and Rust Workspace

**Status:** Accepted

**Date:** 2026-09-01

## Context

Merchant interfaces and API orchestration benefit from the TypeScript ecosystem. The intended Cashu
operator integration is based on CDK, whose primary implementation is Rust, and payout recovery needs a
small auditable state boundary.

A single-language repository would either move the web stack away from its strongest ecosystem or add
a long-lived process boundary between CDK and all settlement logic before that boundary is justified.

## Decision

Use one repository containing:

- a pnpm workspace for merchant applications, APIs, and runtime-independent domain rules; and
- a Cargo workspace for Stellar settlement state and future CDK integration.

Share behavior through versioned JSON/HTTP contracts and conformance fixtures when the Rust and
TypeScript components first interact. Do not hand-maintain duplicate accounting rules in both
languages.

## Consequences

- Contributors need Node, pnpm, and Rust.
- CI must verify both workspaces.
- Cross-language schemas need explicit ownership and compatibility tests.
- The repository can use CDK without forcing merchant UI and API code into Rust.

## Revisit When

Revisit if the CDK integration becomes a remote standard service, if one runtime owns nearly all domain
behavior, or if operating two toolchains creates measurable delivery or security problems.

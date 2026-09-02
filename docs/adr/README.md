# Architecture Decision Records

ADRs record decisions that constrain more than one component or are expensive to reverse.

Each ADR includes its status, context, decision, consequences, and conditions that justify revisiting
it. Amend a decision with a superseding ADR rather than silently changing the old record.

Current decisions:

- [ADR-0001: Use a Hybrid Workspace](0001-hybrid-workspace.md)
- [ADR-0002: Keep Operator Liabilities Distinct](0002-distinct-operator-liabilities.md)
- [ADR-0003: Prove Direct Settlement Before Network Clearing](0003-direct-settlement-before-clearing.md)
- [ADR-0004: Use a Stock CDK External Processor for Stellar](0004-stock-cdk-stellar-processor.md)
- [ADR-0005: Pair Invoice Acceptance with a Balanced Journal](0005-atomic-merchant-accounting.md)
- [ADR-0006: Isolate the NUT-18 Request Adapter](0006-isolate-nut18-request-adapter.md)
- [ADR-0007: Persist Invoice Issuance in PostgreSQL](0007-postgres-invoice-issuance.md)
- [ADR-0008: Persist Cashu Request Snapshots with Invoices](0008-persist-cashu-request-snapshots.md)
- [ADR-0009: Reject Unverified Cashu Payment Payloads](0009-reject-unverified-cashu-payments.md)
- [ADR-0010: Validate Cashu Proofs Against Explicit Keyset Snapshots](0010-validate-cashu-proofs-offline.md)
- [ADR-0011: Observe Cashu Keysets Through a Bounded Read Client](0011-observe-cashu-keysets.md)
- [ADR-0012: Persist Cashu Keyset Identity and Observation Evidence](0012-persist-cashu-keyset-evidence.md)
- [ADR-0013: Reserve Cashu Proof References Before Network Effects](0013-reserve-cashu-proof-references.md)
- [ADR-0014: Observe Cashu Proof State Through a Bounded Read Client](0014-observe-cashu-proof-state.md)
- [ADR-0015: Persist Payment-Scoped Cashu Proof-State Evidence](0015-persist-cashu-proof-state-evidence.md)
- [ADR-0016: Manage Cashu Proof-Reservation Lifecycle](0016-manage-cashu-proof-reservation-lifecycle.md)
- [ADR-0017: Protect Cashu Bearer Proofs in Encrypted Custody](0017-protect-cashu-bearer-proof-custody.md)
- [ADR-0018: Bind Stellar Melt Quote Terms Before Dispatch](0018-bound-stellar-melt-quotes.md)
- [ADR-0019: Persist Stellar Melt Quote Evidence Before Creation](0019-persist-stellar-melt-quote-evidence.md)
- [ADR-0020: Require Quote Evidence for Melt Effects](0020-require-quote-evidence-for-melt-effects.md)
- [ADR-0021: Authorize Bounded Zero-Fee Stellar Melt Dispatch](0021-authorize-zero-fee-stellar-melt-dispatch.md)
- [ADR-0022: Coordinate One Fresh Stellar Melt Dispatch](0022-coordinate-fresh-stellar-melt-dispatch.md)
- [ADR-0023: Atomically Account Confirmed Stellar Melt Payments](0023-atomically-account-stellar-melt-payments.md)
- [ADR-0024: Bind Stellar Destinations and Recover Melts Without Redispatch](0024-bind-stellar-destinations-and-recover-melts.md)

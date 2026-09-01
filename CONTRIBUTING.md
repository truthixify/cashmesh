# Contributing

CashMesh handles bearer value and external settlement. Small changes can alter custody, accounting, or
privacy boundaries, so contributions should remain narrow and testable.

## Before Editing

1. Read `README.md`, `docs/architecture.md`, and `docs/security-model.md`.
2. Read any ADR that owns the boundary being changed.
3. Confirm the task does not require funded accounts, mainnet effects, or private credentials.
4. Inspect the surrounding code and existing tests.

## Development Rules

- Use integer minor units for all monetary values.
- Treat each operator's proofs as a distinct liability.
- Keep external clients behind ports and use deterministic fixtures in unit tests.
- Observe remote state before retrying an ambiguous transaction.
- Never log bearer proofs, private keys, credentials, or private customer data.
- Do not add a dependency unless the task needs it and the pull request explains why.
- Keep comments for non-obvious invariants and compatibility constraints.

## Verification

Run the narrowest relevant test while developing, then:

```bash
pnpm check
```

For merchant-console changes, also run:

```bash
pnpm test:e2e
```

Report skipped integration layers. Passing fixture tests is not evidence that a Cashu or Stellar
integration works.

## Commits

Keep one logical change per commit. Use short imperative subjects such as `Add operator policy checks`
or `Harden payout reconciliation`. Do not include secrets, generated attribution, or unrelated cleanup.

import { paymentId, unixTimestamp } from "@cashmesh/domain";
import { describe, expect, it } from "vitest";
import {
  CashuStellarMeltRecoveryCoordinatorError,
  type CashuStellarMeltRecoveryResultV1,
} from "../src/cashu-stellar-melt-recovery-coordinator";
import {
  CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION,
  type CashuStellarMeltRecoveryJobRepository,
  CashuStellarMeltRecoveryJobRepositoryError,
  type CashuStellarMeltRecoveryJobV1,
  type CashuStellarMeltRecoveryLeaseV1,
  cashuStellarMeltRecoveryLeaseToken,
  type RecordCashuStellarMeltRecoveryOutcomeInput,
} from "../src/cashu-stellar-melt-recovery-job-repository";
import {
  CashuStellarMeltRecoveryWorker,
  CashuStellarMeltRecoveryWorkerError,
} from "../src/cashu-stellar-melt-recovery-worker";

const PAYMENT_ID = paymentId("payment-recovery-worker-001");
const NOW = 1_788_900_000;

describe("CashuStellarMeltRecoveryWorker", () => {
  it("returns idle without invoking recovery when no job is eligible", async () => {
    const fixture = workerFixture({ lease: undefined });

    await expect(fixture.worker.runOnce()).resolves.toEqual({ state: "idle" });
    expect(fixture.recoveryCalls).toHaveLength(0);
    expect(fixture.outcomes).toHaveLength(0);
  });

  it("records terminal recovery outcomes under the claimed lease", async () => {
    for (const state of ["accepted", "released"] as const) {
      const fixture = workerFixture({ recoveryResult: result(state) });

      const recovered = await fixture.worker.runOnce();

      expect(recovered).toMatchObject({ paymentId: PAYMENT_ID, state });
      expect(fixture.outcomes).toEqual([
        {
          kind: state,
          leaseToken: "lease-1",
          paymentId: PAYMENT_ID,
          recordedAt: NOW + 1,
        },
      ]);
    }
  });

  it("schedules bounded exponential retries for nonterminal evidence", async () => {
    const first = workerFixture({ recoveryResult: result("pending") });
    const later = workerFixture({
      lease: lease(4),
      recoveryResult: result("pending"),
      retryMaxSeconds: 100,
    });

    await expect(first.worker.runOnce()).resolves.toMatchObject({
      nextAttemptAt: NOW + 31,
      reason: "nonterminal_evidence",
      state: "retry_scheduled",
    });
    await expect(later.worker.runOnce()).resolves.toMatchObject({
      nextAttemptAt: NOW + 101,
      reason: "nonterminal_evidence",
      state: "retry_scheduled",
    });
  });

  it("retries uncertain operator state but stops on an invalid operator response", async () => {
    const uncertain = workerFixture({
      recoveryResult: result("needs_attention", "operator_state_unknown"),
    });
    const invalid = workerFixture({
      recoveryResult: result("needs_attention", "operator_response_invalid"),
    });

    await expect(uncertain.worker.runOnce()).resolves.toMatchObject({
      reason: "operator_state_unknown",
      state: "retry_scheduled",
    });
    await expect(invalid.worker.runOnce()).resolves.toMatchObject({
      reason: "operator_response_invalid",
      state: "attention_required",
    });
  });

  it("moves a still-nonterminal final attempt to manual attention", async () => {
    const fixture = workerFixture({
      lease: lease(6),
      recoveryResult: result("pending"),
    });

    await expect(fixture.worker.runOnce()).resolves.toMatchObject({
      reason: "retry_exhausted",
      state: "attention_required",
    });
    expect(fixture.outcomes[0]).toMatchObject({
      kind: "attention_required",
      reason: "retry_exhausted",
    });
  });

  it("closes a reclaimed lease after an expired final attempt without another operator read", async () => {
    const fixture = workerFixture({ lease: lease(7) });

    await expect(fixture.worker.runOnce()).resolves.toMatchObject({
      reason: "retry_exhausted",
      state: "attention_required",
    });
    expect(fixture.recoveryCalls).toHaveLength(0);
    expect(fixture.outcomes).toEqual([
      {
        kind: "attention_required",
        leaseToken: "lease-7",
        paymentId: PAYMENT_ID,
        reason: "retry_exhausted",
        recordedAt: NOW + 1,
      },
    ]);
  });

  it.each([
    ["storage_unavailable", "retry_scheduled", "storage_unavailable"],
    ["request_aborted", "retry_scheduled", "worker_aborted"],
    ["operator_not_configured", "attention_required", "recovery_configuration_invalid"],
    ["evidence_invalid", "attention_required", "evidence_invalid"],
  ] as const)(
    "classifies coordinator %s without losing the lease",
    async (code, expectedState, expectedReason) => {
      const fixture = workerFixture({
        recoveryError: new CashuStellarMeltRecoveryCoordinatorError(code, "sanitized fixture"),
      });

      await expect(fixture.worker.runOnce()).resolves.toMatchObject({
        reason: expectedReason,
        state: expectedState,
      });
    },
  );

  it("aborts an overlong recovery attempt and records a retry", async () => {
    const fixture = workerFixture({
      attemptTimeoutMs: 5,
      recover: async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        throw new CashuStellarMeltRecoveryCoordinatorError("request_aborted", "sanitized fixture");
      },
    });

    await expect(fixture.worker.runOnce()).resolves.toMatchObject({
      reason: "worker_aborted",
      state: "retry_scheduled",
    });
    expect(fixture.recoverySignals[0]?.aborted).toBe(true);
  });

  it("does not claim a job when its caller is already aborted", async () => {
    const fixture = workerFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(fixture.worker.runOnce({ signal: controller.signal })).rejects.toMatchObject({
      code: "request_aborted",
    });
    expect(fixture.claimCalls).toBe(0);
  });

  it("rejects malformed and non-string generated lease tokens before claiming storage", async () => {
    for (const leaseTokenFactory of [() => "bad token", () => undefined as unknown as string]) {
      const fixture = workerFixture({ leaseTokenFactory });

      await expect(fixture.worker.runOnce()).rejects.toMatchObject({
        code: "invalid_configuration",
      });
      expect(fixture.claimCalls).toBe(0);
      expect(fixture.recoveryCalls).toHaveLength(0);
    }
  });

  it("rejects a mismatched coordinator payment as invalid evidence", async () => {
    const fixture = workerFixture({
      recoveryResult: {
        ...result("pending"),
        paymentId: paymentId("payment-other"),
      } as CashuStellarMeltRecoveryResultV1,
    });

    await expect(fixture.worker.runOnce()).resolves.toMatchObject({
      reason: "evidence_invalid",
      state: "attention_required",
    });
  });

  it("converges on a concurrent terminal lifecycle after losing its lease outcome", async () => {
    const fixture = workerFixture({
      jobAfterLeaseLoss: completedJob("accepted"),
      recordError: new CashuStellarMeltRecoveryJobRepositoryError(
        "lease_lost",
        "sanitized fixture",
      ),
      recoveryResult: result("pending"),
    });

    await expect(fixture.worker.runOnce()).resolves.toMatchObject({ state: "accepted" });
  });

  it("fails closed when a stale lease has no concurrent terminal state", async () => {
    const fixture = workerFixture({
      recordError: new CashuStellarMeltRecoveryJobRepositoryError(
        "lease_lost",
        "sanitized fixture",
      ),
      recoveryResult: result("pending"),
    });

    await expect(fixture.worker.runOnce()).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("rejects invalid worker, timeout, lease, retry, and attempt policies", () => {
    const dependencies = workerFixture().dependencies;
    for (const options of [
      { workerId: "bad worker" },
      { workerId: 1 as unknown as string },
      { attemptTimeoutMs: 0, workerId: "worker-a" },
      { attemptTimeoutMs: 90_000, leaseDurationSeconds: 90, workerId: "worker-a" },
      { maxAttempts: 0, workerId: "worker-a" },
      { retryBaseSeconds: 31, retryMaxSeconds: 30, workerId: "worker-a" },
    ]) {
      expect(() => new CashuStellarMeltRecoveryWorker(dependencies, options)).toThrow(
        CashuStellarMeltRecoveryWorkerError,
      );
    }
  });
});

interface WorkerFixtureOptions {
  readonly attemptTimeoutMs?: number;
  readonly jobAfterLeaseLoss?: CashuStellarMeltRecoveryJobV1;
  readonly lease?: CashuStellarMeltRecoveryLeaseV1 | undefined;
  readonly leaseTokenFactory?: () => string;
  readonly recordError?: Error;
  readonly recover?: (signal: AbortSignal) => Promise<CashuStellarMeltRecoveryResultV1>;
  readonly recoveryError?: Error;
  readonly recoveryResult?: CashuStellarMeltRecoveryResultV1;
  readonly retryMaxSeconds?: number;
}

function workerFixture(options: WorkerFixtureOptions = {}) {
  const outcomes: RecordCashuStellarMeltRecoveryOutcomeInput[] = [];
  const recoveryCalls: string[] = [];
  const recoverySignals: AbortSignal[] = [];
  let claimCalls = 0;
  const dependencies = {
    coordinator: {
      async recover(input: { readonly paymentId: string; readonly signal?: AbortSignal }) {
        recoveryCalls.push(input.paymentId);
        if (input.signal === undefined) {
          throw new Error("Expected the worker attempt signal.");
        }
        recoverySignals.push(input.signal);
        if (options.recover !== undefined) {
          return await options.recover(input.signal);
        }
        if (options.recoveryError !== undefined) {
          throw options.recoveryError;
        }
        return options.recoveryResult ?? result("pending");
      },
    },
    jobRepository: {
      async claimNext() {
        claimCalls += 1;
        return Object.hasOwn(options, "lease") ? options.lease : lease(1);
      },
      async findByPaymentId() {
        return options.jobAfterLeaseLoss;
      },
      async recordOutcome(input: RecordCashuStellarMeltRecoveryOutcomeInput) {
        if (options.recordError !== undefined) {
          throw options.recordError;
        }
        outcomes.push(input);
        return { job: completedJob("accepted"), replayed: false };
      },
    },
  } satisfies {
    readonly coordinator: {
      recover(input: {
        readonly paymentId: string;
        readonly signal?: AbortSignal;
      }): Promise<CashuStellarMeltRecoveryResultV1>;
    };
    readonly jobRepository: Pick<
      CashuStellarMeltRecoveryJobRepository,
      "claimNext" | "findByPaymentId" | "recordOutcome"
    >;
  };
  const clockValues = [NOW, NOW + 1];
  return {
    get claimCalls() {
      return claimCalls;
    },
    dependencies,
    outcomes,
    recoveryCalls,
    recoverySignals,
    worker: new CashuStellarMeltRecoveryWorker(dependencies, {
      attemptTimeoutMs: options.attemptTimeoutMs ?? 1_000,
      clock: () => {
        const value = clockValues.shift();
        if (value === undefined) {
          throw new Error("Unexpected clock read.");
        }
        return value;
      },
      leaseDurationSeconds: 90,
      leaseTokenFactory: options.leaseTokenFactory ?? (() => "lease-1"),
      retryMaxSeconds: options.retryMaxSeconds ?? 300,
      workerId: "worker-a",
    }),
  };
}

function lease(attemptNumber: number): CashuStellarMeltRecoveryLeaseV1 {
  return Object.freeze({
    attemptNumber,
    claimedAt: unixTimestamp(NOW),
    expiresAt: unixTimestamp(NOW + 90),
    leaseToken: cashuStellarMeltRecoveryLeaseToken(`lease-${attemptNumber}`),
    paymentId: PAYMENT_ID,
    schemaVersion: CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION,
    workerId: "worker-a",
  });
}

function result(
  state: CashuStellarMeltRecoveryResultV1["state"],
  attentionReason?: "operator_response_invalid" | "operator_state_unknown",
): CashuStellarMeltRecoveryResultV1 {
  return {
    paymentId: PAYMENT_ID,
    state,
    ...(attentionReason !== undefined && { attentionReason }),
  } as CashuStellarMeltRecoveryResultV1;
}

function completedJob(terminalState: "accepted" | "released"): CashuStellarMeltRecoveryJobV1 {
  return {
    attempts: Object.freeze([]),
    completedAt: unixTimestamp(NOW + 1),
    effectId: "effect-recovery-worker-001" as CashuStellarMeltRecoveryJobV1["effectId"],
    initialAttemptAt: unixTimestamp(NOW),
    paymentId: PAYMENT_ID,
    schemaVersion: CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION,
    state: "completed",
    terminalState,
  };
}

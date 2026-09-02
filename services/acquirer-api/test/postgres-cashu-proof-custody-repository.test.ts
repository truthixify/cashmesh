import { createSecretKey } from "node:crypto";
import {
  CashuBearerProofBundleV1,
  CashuPaymentRequestIssuer,
  type CashuProofReferenceV1,
  createCashuKeysetSnapshotV1,
  restoreCashuBearerProofBundleV1,
  validateCashuPaymentProofsForCustodyV1,
} from "@cashmesh/cashu";
import {
  createInvoiceV1,
  idempotencyKey,
  invoiceId,
  merchantId,
  minorUnits,
  operatorId,
  paymentId,
  unixTimestamp,
} from "@cashmesh/domain";
import { Pool } from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Aes256GcmCashuProofCustodyCipher,
  type CashuProofCustodyKey,
  type CashuProofCustodyKeyId,
  type CashuProofCustodyKeyProvider,
  cashuProofCustodyKeyId,
  createCashuProofCustodyKey,
} from "../src/cashu-proof-custody-cipher";
import {
  cashuOperatorDispatchFingerprint,
  cashuOperatorEffectId,
  cashuReservationLifecycleEventId,
} from "../src/cashu-proof-reservation-lifecycle-repository";
import type { CreateOpenInvoiceRecord } from "../src/invoice-repository";
import { PostgresCashuKeysetRepository } from "../src/postgres-cashu-keyset-repository";
import { PostgresCashuProofCustodyRepository } from "../src/postgres-cashu-proof-custody-repository";
import { PostgresCashuProofReservationLifecycleRepository } from "../src/postgres-cashu-proof-reservation-lifecycle-repository";
import { PostgresCashuProofReservationRepository } from "../src/postgres-cashu-proof-reservation-repository";
import { PostgresInvoiceRepository } from "../src/postgres-invoice-repository";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const MINT_URL = "https://mint-a.cashmesh.example";
const CREATED_AT = 1_788_000_000;
const EXPIRES_AT = CREATED_AT + 300;
const RESERVED_AT = CREATED_AT + 1;
const CUSTODY_AT = RESERVED_AT + 1;
const KEYSET_ID = "000f715baf5d4c2e";
const KEYSET_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PROOF_SECRET = "daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9";
const PROOF_SIGNATURE = "024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc";
const PROOF_DLEQ = {
  e: "b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4",
  r: "a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861",
  s: "8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8",
} as const;
const repositories: Array<{ close(): Promise<void> }> = [];
const REQUEST_ISSUER = new CashuPaymentRequestIssuer({
  operators: [
    {
      mintUrl: MINT_URL,
      operatorId: operatorId("operator-a"),
      tier: "trusted",
    },
  ],
  transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
});

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL Cashu bearer proof custody", () => {
  beforeAll(async () => {
    const repository = await connectCustodyRepository(cipher([key("custody-key-a", 1)], 1));
    await closeRepository(repository);
  });

  beforeEach(async () => {
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(`
        TRUNCATE
          cashu_stellar_melt_quote_observations,
          cashu_stellar_melt_quote_outcomes,
          cashu_stellar_melt_quote_attempts,
          cashu_bearer_proof_custody,
          cashu_proof_custody_nonce_uses,
          cashu_proof_reservation_events,
          cashu_active_invoice_payment_claims,
          cashu_operator_effects,
          cashu_active_proof_claims,
          cashu_proof_state_observation_entries,
          cashu_proof_state_observations,
          cashu_reserved_proofs,
          cashu_proof_reservations,
          cashu_keyset_observation_entries,
          cashu_keyset_observations,
          cashu_keysets,
          invoice_cashu_request_operators,
          invoice_cashu_requests,
          invoice_creation_requests,
          merchant_invoices
      `);
    } finally {
      await pool.end();
    }
  });

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map(async (repository) => repository.close()));
  });

  it("persists only authenticated ciphertext and restores the bundle across restart", async () => {
    await seedReservation();
    const proofBundle = bundle();
    const expectedPlaintext = proofBundle.serializeForEncryption();
    const firstRepository = await connectCustodyRepository(cipher([key("custody-key-a", 2)], 2));
    const stored = await firstRepository.store(custodyInput(proofBundle));
    await closeRepository(firstRepository);

    const restartedRepository = await connectCustodyRepository(
      cipher([key("custody-key-a", 2)], 3),
    );
    const metadata = await restartedRepository.findMetadata(paymentId("payment-001"));
    let retainedBundle: CashuBearerProofBundleV1 | undefined;
    const restoredPlaintext = await restartedRepository.withDecryptedBundle(
      paymentId("payment-001"),
      (restored) => {
        retainedBundle = restored;
        return restored.serializeForEncryption();
      },
    );

    expect(stored).toEqual({
      metadata: {
        createdAt: CUSTODY_AT,
        paymentId: "payment-001",
        proofCount: 1,
        schemaVersion: 1,
      },
      replayed: false,
    });
    expect(metadata).toEqual(stored.metadata);
    expect(restoredPlaintext).toEqual(expectedPlaintext);
    expect(() => retainedBundle?.serializeForEncryption()).toThrow(
      expect.objectContaining({ code: "bundle_destroyed" }),
    );
    let failedBundle: CashuBearerProofBundleV1 | undefined;
    await expect(
      restartedRepository.withDecryptedBundle(paymentId("payment-001"), (restored) => {
        failedBundle = restored;
        throw new Error("test callback failure");
      }),
    ).rejects.toThrow("test callback failure");
    expect(() => failedBundle?.serializeForEncryption()).toThrow(
      expect.objectContaining({ code: "bundle_destroyed" }),
    );

    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const row = await pool.query<{
        authentication_tag: Buffer;
        ciphertext: Buffer;
        nonce: Buffer;
      }>("SELECT nonce, authentication_tag, ciphertext FROM cashu_bearer_proof_custody");
      const encrypted = row.rows[0];
      expect(encrypted?.nonce).toHaveLength(12);
      expect(encrypted?.authentication_tag).toHaveLength(16);
      expect(encrypted?.ciphertext.includes(Buffer.from(PROOF_SECRET))).toBe(false);
      expect(encrypted?.ciphertext.includes(Buffer.from(KEYSET_PUBLIC_KEY))).toBe(false);

      const columns = await pool.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'cashu_bearer_proof_custody'
        ORDER BY ordinal_position
      `);
      expect(columns.rows.map((item) => item.column_name).join(" ")).not.toMatch(
        /secret|signature|dleq|witness|token|proof_y/i,
      );
    } finally {
      await pool.end();
    }
  });

  it("converges concurrent exact writes and rejects changed custody terms", async () => {
    await seedReservation();
    const first = await connectCustodyRepository(cipher([key("custody-key-a", 3)], 4));
    const second = await connectCustodyRepository(cipher([key("custody-key-a", 3)], 5));
    const proofBundle = bundle();

    const results = await Promise.all([
      first.store(custodyInput(proofBundle)),
      second.store(custodyInput(proofBundle)),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);

    await expect(
      first.store(custodyInput(bundle(), { createdAt: CUSTODY_AT + 1 })),
    ).rejects.toMatchObject({ code: "custody_conflict" });
    await expectCustodyCount(1);
  });

  it("requires the exact active pre-dispatch reservation scope and time", async () => {
    await seedReservation();
    const repository = await connectCustodyRepository(cipher([key("custody-key-a", 4)], 6));

    await expect(
      repository.store(custodyInput(bundle({ invoiceId: "invoice-other" }))),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.store(custodyInput(bundle(), { createdAt: RESERVED_AT - 1 })),
    ).rejects.toMatchObject({ code: "invalid_reservation_state" });
    const validated = bundle();
    const restored = restoreCashuBearerProofBundleV1(validated.serializeForEncryption());
    await expect(repository.store(custodyInput(restored))).rejects.toMatchObject({
      code: "invalid_input",
    });
    const destroyed = bundle();
    destroyed.destroy();
    await expect(repository.store(custodyInput(destroyed))).rejects.toMatchObject({
      code: "invalid_input",
    });

    const lifecycle = await connectLifecycleRepository();
    await lifecycle.startEffect({
      dispatchFingerprint: cashuOperatorDispatchFingerprint("a".repeat(64)),
      effectId: cashuOperatorEffectId("effect-001"),
      eventId: cashuReservationLifecycleEventId("event-start"),
      kind: "swap",
      paymentId: paymentId("payment-001"),
      startedAt: unixTimestamp(CUSTODY_AT),
    });
    await expect(repository.store(custodyInput(bundle()))).rejects.toMatchObject({
      code: "invalid_reservation_state",
    });
  });

  it("rejects reuse of one AES-GCM nonce with the same key across payments", async () => {
    await seedReservation();
    const lifecycle = await connectLifecycleRepository();
    const repository = await connectCustodyRepository(cipher([key("custody-key-a", 5)], 7));
    await repository.store(custodyInput(bundle()));
    await lifecycle.release({
      eventId: cashuReservationLifecycleEventId("event-release"),
      kind: "pre_dispatch",
      paymentId: paymentId("payment-001"),
      recordedAt: unixTimestamp(CUSTODY_AT + 1),
    });
    await seedReservation({
      invoiceId: "invoice-002",
      paymentId: "payment-002",
    });

    await expect(
      repository.store(
        custodyInput(bundle({ invoiceId: "invoice-002" }), {
          paymentId: "payment-002",
        }),
      ),
    ).rejects.toMatchObject({ code: "nonce_conflict" });
    await expectCustodyCount(0);
    await expectNonceCount(1);
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const deletion = await errorFromAsync(() =>
        pool.query("DELETE FROM cashu_proof_custody_nonce_uses"),
      );
      expect(deletion).toMatchObject({ code: "55000" });
    } finally {
      await pool.end();
    }
  });

  it("reads historical keys after rotation and fails closed when the key is unavailable", async () => {
    await seedReservation();
    const oldKey = key("custody-key-old", 6);
    const newKey = key("custody-key-new", 7);
    const writer = await connectCustodyRepository(cipher([oldKey], 8));
    await writer.store(custodyInput(bundle()));
    await closeRepository(writer);

    const rotated = await connectCustodyRepository(cipher([newKey, oldKey], 9));
    const proofCount = await rotated.withDecryptedBundle(
      paymentId("payment-001"),
      (restored) => restored.proofCount,
    );
    expect(proofCount).toBe(1);
    await closeRepository(rotated);

    const missing = await connectCustodyRepository(cipher([newKey], 10));
    await expect(
      missing.withDecryptedBundle(paymentId("payment-001"), () => undefined),
    ).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("blocks early deletion and fails closed on corrupted ciphertext", async () => {
    await seedReservation();
    const repository = await connectCustodyRepository(cipher([key("custody-key-a", 8)], 11));
    await repository.store(custodyInput(bundle()));
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const earlyDelete = await errorFromAsync(() =>
        pool.query("DELETE FROM cashu_bearer_proof_custody WHERE payment_id = $1", ["payment-001"]),
      );
      expect(earlyDelete).toMatchObject({ code: "55000" });

      await pool.query(
        "ALTER TABLE cashu_bearer_proof_custody DISABLE TRIGGER cashu_bearer_proof_custody_guard_mutation",
      );
      try {
        await pool.query(`
          UPDATE cashu_bearer_proof_custody
          SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)
          WHERE payment_id = 'payment-001'
        `);
      } finally {
        await pool.query(
          "ALTER TABLE cashu_bearer_proof_custody ENABLE TRIGGER cashu_bearer_proof_custody_guard_mutation",
        );
      }
    } finally {
      await pool.end();
    }
    await expect(
      repository.withDecryptedBundle(paymentId("payment-001"), () => undefined),
    ).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("destroys restored plaintext when reservation binding fails", async () => {
    await seedReservation();
    const writer = await connectCustodyRepository(cipher([key("custody-key-a", 10)], 13));
    await writer.store(custodyInput(bundle()));
    await closeRepository(writer);

    const mismatched = bundle({ invoiceId: "invoice-other" });
    const plaintext = mismatched.serializeForEncryption();
    mismatched.destroy();
    const destroy = vi.spyOn(CashuBearerProofBundleV1.prototype, "destroy");
    const repository = await PostgresCashuProofCustodyRepository.connect({
      cipher: {
        decrypt: async () => Uint8Array.from(plaintext),
        encrypt: async () => {
          throw new Error("Encryption is not used by this read-only test cipher.");
        },
      },
      connectionString: requireDatabaseUrl(),
      maxConnections: 4,
    });
    repositories.push(repository);

    try {
      await expect(
        repository.withDecryptedBundle(paymentId("payment-001"), () => undefined),
      ).rejects.toMatchObject({ code: "invalid_record" });
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      destroy.mockRestore();
      plaintext.fill(0);
    }
  });

  it("deletes ciphertext atomically when the reservation becomes terminal", async () => {
    await seedReservation();
    const repository = await connectCustodyRepository(cipher([key("custody-key-a", 9)], 12));
    await repository.store(custodyInput(bundle()));
    const lifecycle = await connectLifecycleRepository();

    const released = await lifecycle.release({
      eventId: cashuReservationLifecycleEventId("event-release"),
      kind: "pre_dispatch",
      paymentId: paymentId("payment-001"),
      recordedAt: unixTimestamp(CUSTODY_AT + 1),
    });

    expect(released.lifecycle.state).toBe("released");
    await expect(repository.findMetadata(paymentId("payment-001"))).resolves.toBeUndefined();
    let used = false;
    await expect(
      repository.withDecryptedBundle(paymentId("payment-001"), () => {
        used = true;
      }),
    ).resolves.toBeUndefined();
    expect(used).toBe(false);
    await expectCustodyCount(0);
  });
});

interface SeedOverrides {
  readonly invoiceId?: string;
  readonly paymentId?: string;
  readonly proofs?: readonly CashuProofReferenceV1[];
  readonly total?: number;
}

async function seedReservation(overrides: SeedOverrides = {}): Promise<void> {
  const requestedInvoiceId = overrides.invoiceId ?? "invoice-001";
  await seedInvoice(requestedInvoiceId, overrides.total ?? 1);
  await seedKeyset();
  const repository = await connectReservationRepository();
  await repository.reserve({
    invoiceId: invoiceId(requestedInvoiceId),
    keysetObservedAt: unixTimestamp(CREATED_AT),
    mintUrl: MINT_URL,
    operatorId: operatorId("operator-a"),
    paymentId: paymentId(overrides.paymentId ?? "payment-001"),
    proofReferences: overrides.proofs ?? [proofReference()],
    reservedAt: unixTimestamp(RESERVED_AT),
    unit: "usdc",
  });
}

async function seedInvoice(requestedInvoiceId: string, amount: number): Promise<void> {
  const repository = await connectInvoiceRepository();
  await repository.createOpenInvoice(invoiceRecord(requestedInvoiceId, amount));
}

async function seedKeyset(): Promise<void> {
  const repository = await connectKeysetRepository();
  await repository.persistObservation({
    operatorId: operatorId("operator-a"),
    snapshot: createCashuKeysetSnapshotV1({
      keysets: [
        {
          active: true,
          id: KEYSET_ID,
          keys: { "1": KEYSET_PUBLIC_KEY },
          unit: "usdc",
        },
      ],
      mintUrl: MINT_URL,
      observedAt: CREATED_AT,
    }),
    unit: "usdc",
  });
}

function bundle(options: { readonly invoiceId?: string } = {}) {
  return validatedPayment(options.invoiceId ?? "invoice-001").bearerProofs;
}

function proofReference(): CashuProofReferenceV1 {
  const reference = validatedPayment("invoice-reference").validation.proofReferences[0];
  if (reference === undefined) {
    throw new Error("Expected one validated proof reference.");
  }
  return reference;
}

function validatedPayment(requestedInvoiceId: string) {
  return validateCashuPaymentProofsForCustodyV1({
    keysetSnapshot: createCashuKeysetSnapshotV1({
      keysets: [
        {
          active: true,
          id: KEYSET_ID,
          keys: { "1": KEYSET_PUBLIC_KEY },
          unit: "usdc",
        },
      ],
      mintUrl: MINT_URL,
      observedAt: CREATED_AT,
    }),
    rawPayload: JSON.stringify({
      id: requestedInvoiceId,
      mint: MINT_URL,
      proofs: [
        {
          C: PROOF_SIGNATURE,
          amount: 1,
          dleq: PROOF_DLEQ,
          id: KEYSET_ID,
          secret: PROOF_SECRET,
        },
      ],
      unit: "usdc",
    }),
    validatedAt: CREATED_AT,
  });
}

function custodyInput(
  bearerProofs: ReturnType<typeof bundle>,
  overrides: { readonly createdAt?: number; readonly paymentId?: string } = {},
) {
  return {
    bearerProofs,
    createdAt: unixTimestamp(overrides.createdAt ?? CUSTODY_AT),
    paymentId: paymentId(overrides.paymentId ?? "payment-001"),
  };
}

function invoiceRecord(requestedInvoiceId: string, amount: number): CreateOpenInvoiceRecord {
  const invoice = createInvoiceV1({
    amount: minorUnits(amount),
    createdAt: unixTimestamp(CREATED_AT),
    expiresAt: unixTimestamp(EXPIRES_AT),
    id: invoiceId(requestedInvoiceId),
    merchantId: merchantId("merchant-001"),
  });
  return {
    cashuPaymentRequest: REQUEST_ISSUER.issue({ invoice, issuedAt: invoice.createdAt }),
    idempotencyKey: idempotencyKey(`checkout-${requestedInvoiceId}`),
    invoice,
    requestFingerprint: createFingerprint(requestedInvoiceId),
  };
}

function key(keyId: string, fill: number): CashuProofCustodyKey {
  return createCashuProofCustodyKey(
    cashuProofCustodyKeyId(keyId),
    createSecretKey(new Uint8Array(32).fill(fill)),
  );
}

function cipher(keys: readonly CashuProofCustodyKey[], nonceFill: number) {
  return new Aes256GcmCashuProofCustodyCipher({
    keyProvider: keyProvider(keys),
    randomBytes: () => new Uint8Array(12).fill(nonceFill),
  });
}

function keyProvider(keys: readonly CashuProofCustodyKey[]): CashuProofCustodyKeyProvider {
  const active = keys[0];
  if (active === undefined) {
    throw new Error("A test custody key is required.");
  }
  const byId = new Map<CashuProofCustodyKeyId, CashuProofCustodyKey>(
    keys.map((value) => [value.keyId, value]),
  );
  return {
    activeKey: async () => active,
    findKey: async (keyId) => byId.get(keyId),
  };
}

async function connectCustodyRepository(
  requestedCipher: Aes256GcmCashuProofCustodyCipher,
): Promise<PostgresCashuProofCustodyRepository> {
  const repository = await PostgresCashuProofCustodyRepository.connect({
    cipher: requestedCipher,
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function connectLifecycleRepository(): Promise<PostgresCashuProofReservationLifecycleRepository> {
  const repository = await PostgresCashuProofReservationLifecycleRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function connectReservationRepository(): Promise<PostgresCashuProofReservationRepository> {
  const repository = await PostgresCashuProofReservationRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function connectKeysetRepository(): Promise<PostgresCashuKeysetRepository> {
  const repository = await PostgresCashuKeysetRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function connectInvoiceRepository(): Promise<PostgresInvoiceRepository> {
  const repository = await PostgresInvoiceRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function closeRepository(repository: { close(): Promise<void> }): Promise<void> {
  await repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
}

async function expectCustodyCount(expected: number): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM cashu_bearer_proof_custody",
    );
    expect(result.rows[0]?.count).toBe(String(expected));
  } finally {
    await pool.end();
  }
}

async function expectNonceCount(expected: number): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM cashu_proof_custody_nonce_uses",
    );
    expect(result.rows[0]?.count).toBe(String(expected));
  } finally {
    await pool.end();
  }
}

function requireDatabaseUrl(): string {
  if (DATABASE_URL === undefined) {
    throw new Error("CASHMESH_TEST_DATABASE_URL is required for PostgreSQL integration tests.");
  }
  return DATABASE_URL;
}

function createFingerprint(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}

async function errorFromAsync(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to reject.");
}

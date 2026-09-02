import { createHash, createSecretKey, randomUUID } from "node:crypto";
import {
  type CashuProofReferenceV1,
  createCashuKeysetSnapshotV1,
  validateCashuPaymentProofsForCustodyV1,
} from "@cashmesh/cashu";
import { paymentId } from "@cashmesh/domain";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  Aes256GcmCashuProofCustodyCipher,
  cashuProofCustodyKeyId,
  createCashuProofCustodyKey,
} from "../src/cashu-proof-custody-cipher";
import { EnvelopeAes256GcmCashuProofCustodyCipher } from "../src/cashu-proof-custody-envelope-cipher";
import { PostgresCashuProofCustodyRepository } from "../src/postgres-cashu-proof-custody-repository";
import { applyPostgresMigrations } from "../src/postgres-schema";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const LEGACY_CUSTODY_CREATED_AT = 102;
const LEGACY_CUSTODY_INVOICE_ID = "invoice-v13";
const LEGACY_CUSTODY_KEYSET_ID = "000f715baf5d4c2e";
const LEGACY_CUSTODY_KEYSET_PUBLIC_KEY =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const LEGACY_CUSTODY_MINT_URL = "https://mint-v13.cashmesh.example";
const LEGACY_CUSTODY_OPERATOR_ID = "operator-v13";
const LEGACY_CUSTODY_PAYMENT_ID = "payment-v13";
const LEGACY_CUSTODY_PROOF_DLEQ = {
  e: "b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4",
  r: "a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861",
  s: "8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8",
} as const;
const LEGACY_CUSTODY_PROOF_SIGNATURE =
  "024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc";
const LEGACY_CUSTODY_PROOF_SECRET =
  "daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9";
const LEGACY_CUSTODY_RESERVED_AT = 101;

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL schema migrations", () => {
  it("refuses legacy consumed history without an explicit accounting backfill", async () => {
    await withTemporarySchema(async (client) => {
      await migrate(client, 9);
      await seedIssuedRequest(client);
      await seedLegacyConsumedPayment(client);

      await client.query("BEGIN");
      const error = await errorFromAsync(() => applyPostgresMigrations(client));
      expect(error).toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");

      const state = await client.query<{
        has_operator_count: boolean;
        latest_version: number;
      }>(
        `
          SELECT
            (SELECT MAX(version) FROM cashmesh_schema_migrations) AS latest_version,
            EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'invoice_cashu_requests'
                AND column_name = 'operator_count'
            ) AS has_operator_count
        `,
      );
      expect(state.rows[0]).toEqual({ has_operator_count: false, latest_version: 9 });
    });
  });

  it("refuses legacy issued requests without an authenticated route backfill", async () => {
    await withTemporarySchema(async (client) => {
      await migrate(client, 9);
      await seedIssuedRequest(client);

      await client.query("BEGIN");
      const error = await errorFromAsync(() => applyPostgresMigrations(client));
      expect(error).toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");

      const state = await client.query<{
        has_route_set_fingerprint: boolean;
        latest_version: number;
      }>(
        `
          SELECT
            (SELECT MAX(version) FROM cashmesh_schema_migrations) AS latest_version,
            EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'invoice_cashu_requests'
                AND column_name = 'route_set_fingerprint'
            ) AS has_route_set_fingerprint
        `,
      );
      expect(state.rows[0]).toEqual({ has_route_set_fingerprint: false, latest_version: 9 });
    });
  });

  it("migrates an empty v9 schema through recovery scheduling and envelope custody", async () => {
    await withTemporarySchema(async (client) => {
      await migrate(client, 9);
      await migrate(client);

      const state = await client.query<{
        latest_version: number;
        recovery_jobs_exists: boolean;
        operator_count_nullable: string;
        operator_destination_nullable: string;
        quote_destination_nullable: string;
        route_fingerprint_nullable: string;
      }>(
        `
          SELECT
            (SELECT MAX(version) FROM cashmesh_schema_migrations) AS latest_version,
            to_regclass(current_schema() || '.cashu_stellar_melt_recovery_jobs') IS NOT NULL
              AS recovery_jobs_exists,
            (SELECT is_nullable FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'invoice_cashu_requests'
                AND column_name = 'operator_count') AS operator_count_nullable,
            (SELECT is_nullable FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'invoice_cashu_requests'
                AND column_name = 'route_set_fingerprint') AS route_fingerprint_nullable,
            (SELECT is_nullable FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'invoice_cashu_request_operators'
                AND column_name = 'settlement_destination') AS operator_destination_nullable,
            (SELECT is_nullable FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'cashu_stellar_melt_quote_attempts'
                AND column_name = 'settlement_destination') AS quote_destination_nullable
        `,
      );
      expect(state.rows[0]).toEqual({
        latest_version: 14,
        operator_count_nullable: "NO",
        operator_destination_nullable: "NO",
        quote_destination_nullable: "NO",
        recovery_jobs_exists: true,
        route_fingerprint_nullable: "NO",
      });
    });
  });

  it("serializes a v13 custody writer and preserves its real v1 record", async () => {
    await withTemporarySchema(async (migrator, schema) => {
      await migrate(migrator, 13);
      const fixture = await createLegacyCustodyFixture();
      await seedV13CustodyReservation(migrator, fixture.proofReference);
      const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 2 });
      const writer = await pool.connect();
      const observer = await pool.connect();
      let upgrade: Promise<void> | undefined;
      try {
        await writer.query(`SET search_path TO "${schema}"`);
        await writer.query("BEGIN");
        await writer.query(
          `
          INSERT INTO cashu_proof_custody_nonce_uses (
            key_id, nonce, payment_id, created_at
          ) VALUES ($1, $2, $3, $4)
        `,
          [
            fixture.encrypted.keyId,
            Buffer.from(fixture.encrypted.nonce),
            LEGACY_CUSTODY_PAYMENT_ID,
            LEGACY_CUSTODY_CREATED_AT,
          ],
        );

        const backend = await migrator.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = backend.rows[0]?.pid;
        if (pid === undefined) {
          throw new Error("Expected the migration backend identifier.");
        }
        await migrator.query("BEGIN");
        await migrator.query("SET LOCAL statement_timeout = '5s'");
        upgrade = applyPostgresMigrations(migrator);
        await waitForBackendLock(observer, pid, "cashu_proof_custody_nonce_uses");

        await writer.query(
          `
          INSERT INTO cashu_bearer_proof_custody (
            payment_id,
            binding_fingerprint,
            record_fingerprint,
            schema_version,
            encryption_algorithm,
            key_id,
            nonce,
            authentication_tag,
            ciphertext,
            proof_count,
            created_at
          ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, 1, $9)
        `,
          [
            LEGACY_CUSTODY_PAYMENT_ID,
            fixture.bindingFingerprint,
            fixture.recordFingerprint,
            fixture.encrypted.algorithm,
            fixture.encrypted.keyId,
            Buffer.from(fixture.encrypted.nonce),
            Buffer.from(fixture.encrypted.authenticationTag),
            Buffer.from(fixture.encrypted.ciphertext),
            LEGACY_CUSTODY_CREATED_AT,
          ],
        );
        await writer.query("COMMIT");
        await upgrade;
        await migrator.query("COMMIT");

        const state = await migrator.query<{
          custody_algorithm: string;
          custody_data_key_fingerprint: string | null;
          ciphertext_hex: string;
          latest_version: number;
          nonce_algorithm: string;
          nonce_data_key_fingerprint: string | null;
          record_fingerprint: string;
          wrapped_data_key: Buffer | null;
        }>(`
        SELECT
          custody.encryption_algorithm AS custody_algorithm,
          custody.data_key_fingerprint AS custody_data_key_fingerprint,
          encode(custody.ciphertext, 'hex') AS ciphertext_hex,
          custody.record_fingerprint,
          custody.wrapped_data_key,
          nonce_use.encryption_algorithm AS nonce_algorithm,
          nonce_use.data_key_fingerprint AS nonce_data_key_fingerprint,
          (SELECT MAX(version) FROM cashmesh_schema_migrations) AS latest_version
        FROM cashu_bearer_proof_custody AS custody
        JOIN cashu_proof_custody_nonce_uses AS nonce_use
          ON nonce_use.key_id = custody.key_id
          AND nonce_use.nonce = custody.nonce
          AND nonce_use.payment_id = custody.payment_id
      `);
        expect(state.rows[0]).toEqual({
          custody_algorithm: "aes-256-gcm-v1",
          custody_data_key_fingerprint: null,
          ciphertext_hex: Buffer.from(fixture.encrypted.ciphertext).toString("hex"),
          latest_version: 14,
          nonce_algorithm: "aes-256-gcm-v1",
          nonce_data_key_fingerprint: null,
          record_fingerprint: fixture.recordFingerprint,
          wrapped_data_key: null,
        });

        const reader = await PostgresCashuProofCustodyRepository.connect({
          cipher: new EnvelopeAes256GcmCashuProofCustodyCipher({
            dataKeyProvider: unavailableDataKeyProvider(),
            legacyCipher: fixture.cipher,
          }),
          connectionString: databaseUrlForSchema(schema),
          maxConnections: 1,
        });
        try {
          const restored = await reader.withDecryptedBundle(
            paymentId(LEGACY_CUSTODY_PAYMENT_ID),
            (bundle) => bundle.serializeForEncryption(),
          );
          expect(restored).toEqual(fixture.plaintext);
        } finally {
          await reader.close();
        }

        const malformedEnvelope = await errorFromAsync(() =>
          migrator.query(`
          INSERT INTO cashu_proof_custody_nonce_uses (
            key_id,
            nonce,
            payment_id,
            created_at,
            encryption_algorithm,
            data_key_fingerprint
          ) VALUES (
            'wrapping-key-invalid',
            decode(repeat('04', 12), 'hex'),
            'payment-v13',
            103,
            'aes-256-gcm-envelope-v2',
            NULL
          )
        `),
        );
        expect(malformedEnvelope).toMatchObject({ code: "23514" });
      } finally {
        fixture.plaintext.fill(0);
        await writer.query("ROLLBACK").catch(() => undefined);
        await migrator.query("ROLLBACK").catch(() => undefined);
        if (upgrade !== undefined) {
          await upgrade.catch(() => undefined);
        }
        writer.release();
        observer.release();
        await pool.end();
      }
    });
  });

  it("backfills one scheduled recovery job for an active v12 melt", async () => {
    await withTemporarySchema(async (client) => {
      await migrate(client, 12);
      await seedV12RecoverableMelt(client);

      await migrate(client);

      const result = await client.query<{
        effect_id: string;
        initial_attempt_at: string;
        latest_version: number;
        payment_id: string;
      }>(`
        SELECT
          job.payment_id,
          job.effect_id,
          job.initial_attempt_at,
          (SELECT MAX(version) FROM cashmesh_schema_migrations) AS latest_version
        FROM cashu_stellar_melt_recovery_jobs AS job
      `);
      expect(result.rows).toEqual([
        {
          effect_id: "effect-v12",
          initial_attempt_at: "163",
          latest_version: 14,
          payment_id: "payment-v12",
        },
      ]);
    });
  });

  it("refuses v10 issued routes without a server-authorized settlement destination", async () => {
    await withTemporarySchema(async (client) => {
      await migrate(client, 10);
      await seedV10IssuedRequest(client);

      await client.query("BEGIN");
      const error = await errorFromAsync(() => applyPostgresMigrations(client));
      expect(error).toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");

      const state = await client.query<{
        has_settlement_destination: boolean;
        latest_version: number;
      }>(
        `
          SELECT
            (SELECT MAX(version) FROM cashmesh_schema_migrations) AS latest_version,
            EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'invoice_cashu_request_operators'
                AND column_name = 'settlement_destination'
            ) AS has_settlement_destination
        `,
      );
      expect(state.rows[0]).toEqual({ has_settlement_destination: false, latest_version: 10 });
    });
  });

  it("refuses an active legacy reservation without authenticated route policy", async () => {
    await withTemporarySchema(async (client) => {
      await migrate(client, 9);
      await seedIssuedRequest(client);
      await seedLegacyReservation(client);

      await client.query("BEGIN");
      const error = await errorFromAsync(() => applyPostgresMigrations(client));
      expect(error).toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");

      const migration = await client.query<{ latest_version: number }>(
        "SELECT MAX(version) AS latest_version FROM cashmesh_schema_migrations",
      );
      expect(migration.rows[0]?.latest_version).toBe(9);
    });
  });

  it("serializes accounting migration with a concurrent legacy reservation", async () => {
    await withTemporarySchema(async (migrator, schema) => {
      await migrate(migrator, 9);
      await seedIssuedRequest(migrator);
      const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 2 });
      const writer = await pool.connect();
      const observer = await pool.connect();
      let upgrade: Promise<unknown> | undefined;
      try {
        await writer.query(`SET search_path TO "${schema}"`);
        await writer.query("BEGIN");
        await writer.query("ALTER TABLE cashu_proof_reservations DISABLE TRIGGER USER");
        await insertLegacyReservation(writer, "payment-concurrent", "1");

        const backend = await migrator.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = backend.rows[0]?.pid;
        if (pid === undefined) {
          throw new Error("Expected the migration backend identifier.");
        }
        await migrator.query("BEGIN");
        await migrator.query("SET LOCAL statement_timeout = '5s'");
        upgrade = errorFromAsync(() => applyPostgresMigrations(migrator));
        await waitForBackendLock(observer, pid, "merchant_invoices");
        await writer.query("COMMIT");

        const error = await upgrade;
        expect(error).toMatchObject({ code: "23514" });
        await migrator.query("ROLLBACK");
        const migration = await migrator.query<{ latest_version: number }>(
          "SELECT MAX(version) AS latest_version FROM cashmesh_schema_migrations",
        );
        expect(migration.rows[0]?.latest_version).toBe(9);
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        if (upgrade !== undefined) {
          await upgrade;
        }
        writer.release();
        observer.release();
        await pool.end();
      }
    });
  });

  it("lets an in-flight reservation finish before taking its invoice lock", async () => {
    await withTemporarySchema(async (migrator, schema) => {
      await migrate(migrator, 9);
      await seedIssuedRequest(migrator);
      const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 2 });
      const writer = await pool.connect();
      const observer = await pool.connect();
      let upgrade: Promise<unknown> | undefined;
      try {
        await writer.query(`SET search_path TO "${schema}"`);
        await writer.query("ALTER TABLE cashu_proof_reservations DISABLE TRIGGER USER");
        await writer.query("BEGIN");
        await writer.query(
          "SELECT id FROM merchant_invoices WHERE id = 'invoice-legacy' FOR UPDATE",
        );

        const backend = await migrator.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = backend.rows[0]?.pid;
        if (pid === undefined) {
          throw new Error("Expected the migration backend identifier.");
        }
        await migrator.query("BEGIN");
        await migrator.query("SET LOCAL statement_timeout = '5s'");
        upgrade = errorFromAsync(() => applyPostgresMigrations(migrator));
        await waitForBackendLock(observer, pid, "merchant_invoices");
        await insertLegacyReservation(writer, "payment-in-flight", "2");
        await writer.query("COMMIT");

        const error = await upgrade;
        expect(error).toMatchObject({ code: "23514" });
        await migrator.query("ROLLBACK");
        await writer.query("ALTER TABLE cashu_proof_reservations ENABLE TRIGGER USER");
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        if (upgrade !== undefined) {
          await upgrade;
        }
        await writer
          .query("ALTER TABLE cashu_proof_reservations ENABLE TRIGGER USER")
          .catch(() => undefined);
        writer.release();
        observer.release();
        await pool.end();
      }
    });
  });

  it("serializes accounting migration with concurrent invoice creation in write order", async () => {
    await withTemporarySchema(async (migrator, schema) => {
      await migrate(migrator, 9);
      const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 2 });
      const writer = await pool.connect();
      const observer = await pool.connect();
      let upgrade: Promise<unknown> | undefined;
      try {
        await writer.query(`SET search_path TO "${schema}"`);
        await writer.query("BEGIN");
        await insertLegacyCreationRequest(writer);
        await insertLegacyInvoice(writer);

        const backend = await migrator.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = backend.rows[0]?.pid;
        if (pid === undefined) {
          throw new Error("Expected the migration backend identifier.");
        }
        await migrator.query("BEGIN");
        await migrator.query("SET LOCAL statement_timeout = '5s'");
        upgrade = errorFromAsync(() => applyPostgresMigrations(migrator));
        await waitForBackendLock(observer, pid, "invoice_creation_requests");
        await insertLegacyRequest(writer);
        await writer.query("COMMIT");

        const error = await upgrade;
        expect(error).toMatchObject({ code: "23514" });
        await migrator.query("ROLLBACK");
        const migration = await migrator.query<{ latest_version: number }>(
          "SELECT MAX(version) AS latest_version FROM cashmesh_schema_migrations",
        );
        expect(migration.rows[0]?.latest_version).toBe(9);
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        if (upgrade !== undefined) {
          await upgrade;
        }
        writer.release();
        observer.release();
        await pool.end();
      }
    });
  });
});

async function createLegacyCustodyFixture() {
  const bundle = validateCashuPaymentProofsForCustodyV1({
    keysetSnapshot: createCashuKeysetSnapshotV1({
      keysets: [
        {
          active: true,
          id: LEGACY_CUSTODY_KEYSET_ID,
          keys: { "1": LEGACY_CUSTODY_KEYSET_PUBLIC_KEY },
          unit: "usdc",
        },
      ],
      mintUrl: LEGACY_CUSTODY_MINT_URL,
      observedAt: 100,
    }),
    rawPayload: JSON.stringify({
      id: LEGACY_CUSTODY_INVOICE_ID,
      mint: LEGACY_CUSTODY_MINT_URL,
      proofs: [
        {
          C: LEGACY_CUSTODY_PROOF_SIGNATURE,
          amount: 1,
          dleq: LEGACY_CUSTODY_PROOF_DLEQ,
          id: LEGACY_CUSTODY_KEYSET_ID,
          secret: LEGACY_CUSTODY_PROOF_SECRET,
        },
      ],
      unit: "usdc",
    }),
    validatedAt: 100,
  }).bearerProofs;
  try {
    const proofReference = bundle.proofReferencesForBinding()[0];
    if (proofReference === undefined) {
      throw new Error("Expected one legacy custody proof reference.");
    }
    const plaintext = bundle.serializeForEncryption();
    const bindingFingerprint = sha256({
      createdAt: LEGACY_CUSTODY_CREATED_AT,
      invoiceId: LEGACY_CUSTODY_INVOICE_ID,
      mintUrl: LEGACY_CUSTODY_MINT_URL,
      operatorId: LEGACY_CUSTODY_OPERATOR_ID,
      paymentId: LEGACY_CUSTODY_PAYMENT_ID,
      proofReferences: bundle.proofReferencesForBinding(),
      reservedAt: LEGACY_CUSTODY_RESERVED_AT,
      schemaVersion: 1,
      unit: "usdc",
    });
    const custodyKey = createCashuProofCustodyKey(
      cashuProofCustodyKeyId("legacy-custody-key"),
      createSecretKey(new Uint8Array(32).fill(41)),
    );
    const cipher = new Aes256GcmCashuProofCustodyCipher({
      keyProvider: {
        activeKey: async () => custodyKey,
        findKey: async (keyId) => (keyId === custodyKey.keyId ? custodyKey : undefined),
      },
      randomBytes: () => new Uint8Array(12).fill(1),
    });
    const encrypted = await cipher.encrypt(
      plaintext,
      Uint8Array.from(Buffer.from(bindingFingerprint, "hex")),
    );
    const recordFingerprint = sha256({
      algorithm: encrypted.algorithm,
      authenticationTag: Buffer.from(encrypted.authenticationTag).toString("base64"),
      bindingFingerprint,
      ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
      createdAt: LEGACY_CUSTODY_CREATED_AT,
      keyId: encrypted.keyId,
      nonce: Buffer.from(encrypted.nonce).toString("base64"),
      paymentId: LEGACY_CUSTODY_PAYMENT_ID,
      proofCount: 1,
      schemaVersion: 1,
    });
    return Object.freeze({
      bindingFingerprint,
      cipher,
      encrypted,
      plaintext,
      proofReference,
      recordFingerprint,
    });
  } finally {
    bundle.destroy();
  }
}

async function seedV13CustodyReservation(
  client: PoolClient,
  proofReference: CashuProofReferenceV1,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      INSERT INTO merchant_invoices (
        id, merchant_id, schema_version, unit, amount, created_at, expires_at, state
      ) VALUES ('invoice-v13', 'merchant-v13', 1, 'usdc', 1, 100, 300, 'open')
    `);
    await client.query(`
      INSERT INTO invoice_cashu_requests (
        invoice_id,
        merchant_id,
        schema_version,
        encoded_request,
        encoding,
        issued_at,
        mint_policy,
        transport_url,
        operator_count,
        route_set_fingerprint
      ) VALUES (
        'invoice-v13',
        'merchant-v13',
        1,
        'creqAabc',
        'creqA',
        100,
        'strict',
        'https://pay.cashmesh.example/v1/cashu/payments',
        1,
        repeat('1', 64)
      )
    `);
    await client.query(`
      INSERT INTO invoice_cashu_request_operators (
        invoice_id,
        merchant_id,
        position,
        operator_id,
        mint_url,
        mode,
        tier,
        reason,
        settlement_destination
      ) VALUES (
        'invoice-v13',
        'merchant-v13',
        0,
        'operator-v13',
        'https://mint-v13.cashmesh.example',
        'immediate_conversion',
        'trusted',
        'trusted_operator',
        'GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4'
      )
    `);
    await client.query(
      `
        INSERT INTO cashu_keysets (
          mint_url,
          keyset_id,
          unit,
          input_fee_ppk,
          final_expiry,
          keys,
          identity_fingerprint
        ) VALUES ($1, $2, 'usdc', 0, NULL, $3::jsonb, repeat('2', 64))
      `,
      [
        LEGACY_CUSTODY_MINT_URL,
        LEGACY_CUSTODY_KEYSET_ID,
        JSON.stringify({ "1": LEGACY_CUSTODY_KEYSET_PUBLIC_KEY }),
      ],
    );
    await client.query(
      `
        INSERT INTO cashu_keyset_observations (
          snapshot_fingerprint,
          operator_id,
          mint_url,
          unit,
          schema_version,
          observed_at
        ) VALUES (repeat('3', 64), $1, $2, 'usdc', 1, 100)
      `,
      [LEGACY_CUSTODY_OPERATOR_ID, LEGACY_CUSTODY_MINT_URL],
    );
    await client.query(
      `
        INSERT INTO cashu_keyset_observation_entries (
          snapshot_fingerprint, mint_url, unit, position, keyset_id, active
        ) VALUES (repeat('3', 64), $1, 'usdc', 0, $2, TRUE)
      `,
      [LEGACY_CUSTODY_MINT_URL, LEGACY_CUSTODY_KEYSET_ID],
    );
    await client.query(
      `
        INSERT INTO cashu_proof_reservations (
          payment_id,
          reservation_fingerprint,
          invoice_id,
          operator_id,
          mint_url,
          unit,
          schema_version,
          keyset_observed_at,
          reserved_at,
          gross_amount
        ) VALUES ($1, repeat('4', 64), $2, $3, $4, 'usdc', 1, 100, $5, 1)
      `,
      [
        LEGACY_CUSTODY_PAYMENT_ID,
        LEGACY_CUSTODY_INVOICE_ID,
        LEGACY_CUSTODY_OPERATOR_ID,
        LEGACY_CUSTODY_MINT_URL,
        LEGACY_CUSTODY_RESERVED_AT,
      ],
    );
    await client.query(
      `
        INSERT INTO cashu_reserved_proofs (
          payment_id, mint_url, unit, position, proof_y, keyset_id, amount
        ) VALUES ($1, $2, 'usdc', 0, $3, $4, $5)
      `,
      [
        LEGACY_CUSTODY_PAYMENT_ID,
        LEGACY_CUSTODY_MINT_URL,
        proofReference.y,
        proofReference.keysetId,
        proofReference.amount,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function unavailableDataKeyProvider() {
  return {
    generateDataKey: async () => {
      throw new Error("Envelope writes are not expected in the legacy migration fixture.");
    },
    unwrapDataKey: async () => {
      throw new Error("Envelope reads are not expected in the legacy migration fixture.");
    },
  };
}

function databaseUrlForSchema(schema: string): string {
  const url = new URL(requireDatabaseUrl());
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function withTemporarySchema(
  action: (client: PoolClient, schema: string) => Promise<void>,
): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  const schema = `cashmesh_migration_${randomUUID().replaceAll("-", "_")}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await action(client, schema);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
}

async function migrate(client: PoolClient, targetVersion?: number): Promise<void> {
  await client.query("BEGIN");
  try {
    await applyPostgresMigrations(client, {
      ...(targetVersion !== undefined && { targetVersion }),
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedIssuedRequest(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await insertLegacyInvoice(client);
    await insertLegacyRequest(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedV10IssuedRequest(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await insertLegacyInvoice(client);
    await client.query(`
      INSERT INTO invoice_cashu_requests (
        invoice_id,
        merchant_id,
        schema_version,
        encoded_request,
        encoding,
        issued_at,
        mint_policy,
        operator_count,
        route_set_fingerprint,
        transport_url
      )
      VALUES (
        'invoice-legacy',
        'merchant-legacy',
        1,
        'creqAabc',
        'creqA',
        100,
        'strict',
        1,
        repeat('a', 64),
        'https://pay.cashmesh.example/v1/cashu/payments'
      )
    `);
    await client.query(`
      INSERT INTO invoice_cashu_request_operators (
        invoice_id, merchant_id, position, operator_id, mint_url, mode, tier, reason
      )
      VALUES (
        'invoice-legacy',
        'merchant-legacy',
        0,
        'operator-legacy',
        'https://mint-legacy.example',
        'immediate_conversion',
        'trusted',
        'trusted_operator'
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedV12RecoverableMelt(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      INSERT INTO merchant_invoices (
        id, merchant_id, schema_version, unit, amount, created_at, expires_at, state
      ) VALUES ('invoice-v12', 'merchant-v12', 1, 'usdc', 1, 100, 300, 'open')
    `);
    await client.query(`
      INSERT INTO invoice_creation_requests (
        merchant_id, idempotency_key, request_fingerprint, invoice_id, created_at
      ) VALUES ('merchant-v12', 'request-v12', repeat('1', 64), 'invoice-v12', 100)
    `);
    await client.query(`
      INSERT INTO invoice_cashu_requests (
        invoice_id,
        merchant_id,
        schema_version,
        encoded_request,
        encoding,
        issued_at,
        mint_policy,
        operator_count,
        route_set_fingerprint,
        transport_url
      ) VALUES (
        'invoice-v12',
        'merchant-v12',
        1,
        'creqAabc',
        'creqA',
        100,
        'strict',
        1,
        repeat('2', 64),
        'https://pay.cashmesh.example/v1/cashu/payments'
      )
    `);
    await client.query(`
      INSERT INTO invoice_cashu_request_operators (
        invoice_id,
        merchant_id,
        position,
        operator_id,
        mint_url,
        mode,
        tier,
        reason,
        settlement_destination
      ) VALUES (
        'invoice-v12',
        'merchant-v12',
        0,
        'operator-v12',
        'https://mint-v12.example',
        'immediate_conversion',
        'trusted',
        'trusted_operator',
        'GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4'
      )
    `);
    for (const table of [
      "cashu_proof_reservations",
      "cashu_operator_effects",
      "cashu_proof_reservation_events",
    ]) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    }
    await client.query(`
      INSERT INTO cashu_proof_reservations (
        payment_id,
        reservation_fingerprint,
        invoice_id,
        operator_id,
        mint_url,
        unit,
        schema_version,
        keyset_observed_at,
        reserved_at,
        gross_amount
      ) VALUES (
        'payment-v12',
        repeat('3', 64),
        'invoice-v12',
        'operator-v12',
        'https://mint-v12.example',
        'usdc',
        1,
        100,
        101,
        1
      )
    `);
    await client.query(`
      INSERT INTO cashu_operator_effects (
        effect_id,
        effect_fingerprint,
        dispatch_fingerprint,
        payment_id,
        invoice_id,
        operator_id,
        mint_url,
        effect_kind,
        operator_reference,
        operator_reference_expires_at,
        schema_version,
        started_at
      ) VALUES (
        'effect-v12',
        repeat('4', 64),
        repeat('5', 64),
        'payment-v12',
        'invoice-v12',
        'operator-v12',
        'https://mint-v12.example',
        'melt',
        '019e6d5a-2347-7000-89e2-35fe79f92c0e',
        200,
        1,
        103
      )
    `);
    await client.query(`
      INSERT INTO cashu_proof_reservation_events (
        event_id,
        event_fingerprint,
        payment_id,
        sequence,
        schema_version,
        state,
        recorded_at,
        effect_id,
        evidence_kind,
        evidence_at,
        proof_state_snapshot_fingerprint,
        journal_entry_id
      ) VALUES (
        'event-v12',
        repeat('6', 64),
        'payment-v12',
        0,
        1,
        'dispatch_started',
        103,
        'effect-v12',
        NULL,
        NULL,
        NULL,
        NULL
      )
    `);
    for (const table of [
      "cashu_proof_reservations",
      "cashu_operator_effects",
      "cashu_proof_reservation_events",
    ]) {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertLegacyCreationRequest(client: PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO invoice_creation_requests (
      merchant_id, idempotency_key, request_fingerprint, invoice_id, created_at
    )
    VALUES ('merchant-legacy', 'request-legacy', repeat('9', 64), 'invoice-legacy', 100)
  `);
}

async function insertLegacyInvoice(client: PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO merchant_invoices (
      id, merchant_id, schema_version, unit, amount, created_at, expires_at, state
    )
    VALUES ('invoice-legacy', 'merchant-legacy', 1, 'usdc', 1, 100, 200, 'open')
  `);
}

async function insertLegacyRequest(client: PoolClient): Promise<void> {
  await client.query(`
      INSERT INTO invoice_cashu_requests (
        invoice_id,
        merchant_id,
        schema_version,
        encoded_request,
        encoding,
        issued_at,
        mint_policy,
        transport_url
      )
      VALUES (
        'invoice-legacy',
        'merchant-legacy',
        1,
        'creqAabc',
        'creqA',
        100,
        'strict',
        'https://pay.cashmesh.example/v1/cashu/payments'
      )
  `);
  await client.query(`
      INSERT INTO invoice_cashu_request_operators (
        invoice_id, merchant_id, position, operator_id, mint_url, mode, tier, reason
      )
      VALUES (
        'invoice-legacy',
        'merchant-legacy',
        0,
        'operator-legacy',
        'https://mint-legacy.example',
        'trusted_hold',
        'trusted',
        'trusted_operator'
      )
  `);
}

async function seedLegacyConsumedPayment(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const table of [
      "cashu_proof_reservations",
      "cashu_operator_effects",
      "cashu_proof_state_observations",
      "cashu_proof_reservation_events",
    ]) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    }
    await client.query(`
      INSERT INTO cashu_proof_reservations (
        payment_id,
        reservation_fingerprint,
        invoice_id,
        operator_id,
        mint_url,
        unit,
        schema_version,
        keyset_observed_at,
        reserved_at,
        gross_amount
      )
      VALUES (
        'payment-legacy',
        repeat('a', 64),
        'invoice-legacy',
        'operator-legacy',
        'https://mint-legacy.example',
        'usdc',
        1,
        100,
        101,
        1
      )
    `);
    await client.query(`
      INSERT INTO cashu_operator_effects (
        effect_id,
        effect_fingerprint,
        dispatch_fingerprint,
        payment_id,
        invoice_id,
        operator_id,
        mint_url,
        effect_kind,
        operator_reference,
        operator_reference_expires_at,
        schema_version,
        started_at
      )
      VALUES (
        'effect-legacy',
        repeat('b', 64),
        repeat('c', 64),
        'payment-legacy',
        'invoice-legacy',
        'operator-legacy',
        'https://mint-legacy.example',
        'swap',
        NULL,
        NULL,
        1,
        102
      )
    `);
    await client.query(`
      INSERT INTO cashu_proof_state_observations (
        snapshot_fingerprint,
        payment_id,
        operator_id,
        mint_url,
        unit,
        schema_version,
        observed_at
      )
      VALUES (
        repeat('d', 64),
        'payment-legacy',
        'operator-legacy',
        'https://mint-legacy.example',
        'usdc',
        1,
        103
      )
    `);
    await client.query(`
      INSERT INTO cashu_proof_reservation_events (
        event_id,
        event_fingerprint,
        payment_id,
        sequence,
        schema_version,
        state,
        recorded_at,
        effect_id,
        evidence_kind,
        evidence_at,
        proof_state_snapshot_fingerprint
      )
      VALUES (
        'event-legacy',
        repeat('e', 64),
        'payment-legacy',
        0,
        1,
        'consumed',
        104,
        'effect-legacy',
        'swap_succeeded',
        103,
        repeat('d', 64)
      )
    `);
    for (const table of [
      "cashu_proof_reservations",
      "cashu_operator_effects",
      "cashu_proof_state_observations",
      "cashu_proof_reservation_events",
    ]) {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedLegacyReservation(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("ALTER TABLE cashu_proof_reservations DISABLE TRIGGER USER");
    await insertLegacyReservation(client, "payment-active", "f");
    await client.query("ALTER TABLE cashu_proof_reservations ENABLE TRIGGER USER");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertLegacyReservation(
  client: PoolClient,
  paymentId: string,
  fingerprintCharacter: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO cashu_proof_reservations (
        payment_id,
        reservation_fingerprint,
        invoice_id,
        operator_id,
        mint_url,
        unit,
        schema_version,
        keyset_observed_at,
        reserved_at,
        gross_amount
      )
      VALUES (
        $1,
        repeat($2, 64),
        'invoice-legacy',
        'operator-legacy',
        'https://mint-legacy.example',
        'usdc',
        1,
        100,
        101,
        1
      )
    `,
    [paymentId, fingerprintCharacter],
  );
}

async function waitForBackendLock(
  client: PoolClient,
  pid: number,
  relationName: string,
): Promise<void> {
  let observedRelations: readonly string[] = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await client.query<{ relation_name: string }>(
      `
        SELECT relation.relname AS relation_name
        FROM pg_locks AS lock
        JOIN pg_class AS relation ON relation.oid = lock.relation
        WHERE lock.pid = $1 AND NOT lock.granted
      `,
      [pid],
    );
    observedRelations = state.rows.map((row) => row.relation_name);
    if (observedRelations.includes(relationName)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Migration did not wait for concurrent ${relationName} writer; observed ${observedRelations.join(", ") || "no relation lock"}.`,
  );
}

async function errorFromAsync(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

function requireDatabaseUrl(): string {
  if (DATABASE_URL === undefined) {
    throw new Error("CASHMESH_TEST_DATABASE_URL is required for PostgreSQL tests.");
  }
  return DATABASE_URL;
}

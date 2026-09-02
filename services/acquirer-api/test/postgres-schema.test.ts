import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { applyPostgresMigrations } from "../src/postgres-schema";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;

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

  it("migrates an empty v9 schema with required authenticated route fields", async () => {
    await withTemporarySchema(async (client) => {
      await migrate(client, 9);
      await migrate(client);

      const state = await client.query<{
        latest_version: number;
        operator_count_nullable: string;
        route_fingerprint_nullable: string;
      }>(
        `
          SELECT
            (SELECT MAX(version) FROM cashmesh_schema_migrations) AS latest_version,
            (SELECT is_nullable FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'invoice_cashu_requests'
                AND column_name = 'operator_count') AS operator_count_nullable,
            (SELECT is_nullable FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'invoice_cashu_requests'
                AND column_name = 'route_set_fingerprint') AS route_fingerprint_nullable
        `,
      );
      expect(state.rows[0]).toEqual({
        latest_version: 10,
        operator_count_nullable: "NO",
        route_fingerprint_nullable: "NO",
      });
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
    `Accounting migration did not wait for concurrent ${relationName} writer; observed ${observedRelations.join(", ") || "no relation lock"}.`,
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

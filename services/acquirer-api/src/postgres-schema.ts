import type { PoolClient, QueryResultRow } from "pg";

interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}

interface AppliedMigrationRow extends QueryResultRow {
  readonly name: string;
  readonly version: number;
}

const MIGRATION_LOCK_ID = "1128350001";

const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    name: "create_invoice_issuance",
    sql: `
      CREATE TABLE merchant_invoices (
        id VARCHAR(128) PRIMARY KEY,
        merchant_id VARCHAR(128) NOT NULL,
        schema_version SMALLINT NOT NULL,
        unit TEXT NOT NULL,
        amount BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        state TEXT NOT NULL,
        CONSTRAINT merchant_invoices_identity_unique UNIQUE (id, merchant_id),
        CONSTRAINT merchant_invoices_id_format CHECK (
          id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT merchant_invoices_merchant_format CHECK (
          merchant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT merchant_invoices_schema CHECK (schema_version = 1),
        CONSTRAINT merchant_invoices_unit CHECK (unit = 'usdc'),
        CONSTRAINT merchant_invoices_amount CHECK (
          amount > 0 AND amount <= 9007199254740991
        ),
        CONSTRAINT merchant_invoices_created_at CHECK (
          created_at >= 0 AND created_at <= 9007199254740991
        ),
        CONSTRAINT merchant_invoices_expires_at CHECK (
          expires_at > created_at AND expires_at <= 9007199254740991
        ),
        CONSTRAINT merchant_invoices_state CHECK (state = 'open')
      );

      CREATE INDEX merchant_invoices_owner_created_idx
        ON merchant_invoices (merchant_id, created_at DESC, id);

      CREATE TABLE invoice_creation_requests (
        merchant_id VARCHAR(128) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint TEXT NOT NULL,
        invoice_id VARCHAR(128) NOT NULL,
        created_at BIGINT NOT NULL,
        CONSTRAINT invoice_creation_requests_pkey
          PRIMARY KEY (merchant_id, idempotency_key),
        CONSTRAINT invoice_creation_requests_invoice_unique UNIQUE (invoice_id),
        CONSTRAINT invoice_creation_requests_merchant_format CHECK (
          merchant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT invoice_creation_requests_key_format CHECK (
          idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT invoice_creation_requests_fingerprint CHECK (
          request_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT invoice_creation_requests_created_at CHECK (
          created_at >= 0 AND created_at <= 9007199254740991
        ),
        CONSTRAINT invoice_creation_requests_invoice_fkey
          FOREIGN KEY (invoice_id, merchant_id)
          REFERENCES merchant_invoices (id, merchant_id)
          ON DELETE RESTRICT
          DEFERRABLE INITIALLY DEFERRED
      );
    `,
    version: 1,
  }),
]);

export async function applyPostgresMigrations(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_ID]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS cashmesh_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )
  `);

  const applied = await client.query<AppliedMigrationRow>(
    "SELECT version, name FROM cashmesh_schema_migrations ORDER BY version",
  );
  const knownByVersion = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));

  for (const row of applied.rows) {
    const migration = knownByVersion.get(row.version);
    if (migration === undefined || migration.name !== row.name) {
      throw new Error(
        `Database migration ${row.version}:${row.name} is not supported by this build.`,
      );
    }
  }

  const appliedVersions = new Set(applied.rows.map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }
    await client.query(migration.sql);
    await client.query("INSERT INTO cashmesh_schema_migrations (version, name) VALUES ($1, $2)", [
      migration.version,
      migration.name,
    ]);
  }
}

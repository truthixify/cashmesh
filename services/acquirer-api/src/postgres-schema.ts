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
  Object.freeze({
    name: "persist_cashu_payment_requests",
    sql: `
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM merchant_invoices) THEN
          RAISE EXCEPTION 'Cashu request migration requires an explicit legacy invoice backfill';
        END IF;
      END
      $$;

      CREATE TABLE invoice_cashu_requests (
        invoice_id VARCHAR(128) PRIMARY KEY,
        merchant_id VARCHAR(128) NOT NULL,
        schema_version SMALLINT NOT NULL,
        encoded_request VARCHAR(4096) NOT NULL,
        encoding TEXT NOT NULL,
        issued_at BIGINT NOT NULL,
        mint_policy TEXT NOT NULL,
        transport_url VARCHAR(512) NOT NULL,
        CONSTRAINT invoice_cashu_requests_identity_unique UNIQUE (invoice_id, merchant_id),
        CONSTRAINT invoice_cashu_requests_invoice_format CHECK (
          invoice_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT invoice_cashu_requests_merchant_format CHECK (
          merchant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT invoice_cashu_requests_schema CHECK (schema_version = 1),
        CONSTRAINT invoice_cashu_requests_encoded CHECK (
          encoded_request ~ '^creqA[A-Za-z0-9_-]+={0,2}$'
        ),
        CONSTRAINT invoice_cashu_requests_encoding CHECK (encoding = 'creqA'),
        CONSTRAINT invoice_cashu_requests_issued_at CHECK (
          issued_at >= 0 AND issued_at <= 9007199254740991
        ),
        CONSTRAINT invoice_cashu_requests_mint_policy CHECK (mint_policy = 'strict'),
        CONSTRAINT invoice_cashu_requests_transport CHECK (
          transport_url ~ '^https://[^[:space:]]+$'
        ),
        CONSTRAINT invoice_cashu_requests_invoice_fkey
          FOREIGN KEY (invoice_id, merchant_id)
          REFERENCES merchant_invoices (id, merchant_id)
          ON DELETE RESTRICT
      );

      CREATE TABLE invoice_cashu_request_operators (
        invoice_id VARCHAR(128) NOT NULL,
        merchant_id VARCHAR(128) NOT NULL,
        position SMALLINT NOT NULL,
        operator_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        mode TEXT NOT NULL,
        tier TEXT NOT NULL,
        reason TEXT NOT NULL,
        CONSTRAINT invoice_cashu_request_operators_pkey PRIMARY KEY (invoice_id, position),
        CONSTRAINT invoice_cashu_request_operators_operator_unique UNIQUE (
          invoice_id,
          operator_id
        ),
        CONSTRAINT invoice_cashu_request_operators_mint_unique UNIQUE (invoice_id, mint_url),
        CONSTRAINT invoice_cashu_request_operators_invoice_format CHECK (
          invoice_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT invoice_cashu_request_operators_merchant_format CHECK (
          merchant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT invoice_cashu_request_operators_position CHECK (
          position >= 0 AND position < 16
        ),
        CONSTRAINT invoice_cashu_request_operators_operator_format CHECK (
          operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT invoice_cashu_request_operators_mint_url CHECK (
          mint_url ~ '^https://[^[:space:]]+$'
        ),
        CONSTRAINT invoice_cashu_request_operators_policy CHECK (
          (
            tier = 'trusted'
            AND reason = 'trusted_operator'
            AND mode IN ('trusted_hold', 'immediate_conversion')
          )
          OR (
            tier = 'convertible'
            AND reason = 'conversion_required'
            AND mode = 'immediate_conversion'
          )
        ),
        CONSTRAINT invoice_cashu_request_operators_request_fkey
          FOREIGN KEY (invoice_id, merchant_id)
          REFERENCES invoice_cashu_requests (invoice_id, merchant_id)
          ON DELETE RESTRICT
      );

      CREATE FUNCTION cashmesh_require_cashu_request_operator()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        request_invoice_id VARCHAR(128);
      BEGIN
        IF TG_TABLE_NAME = 'invoice_cashu_requests' THEN
          request_invoice_id := NEW.invoice_id;
        ELSE
          request_invoice_id := OLD.invoice_id;
        END IF;

        IF EXISTS (
          SELECT 1 FROM invoice_cashu_requests WHERE invoice_id = request_invoice_id
        ) AND NOT EXISTS (
          SELECT 1
          FROM invoice_cashu_request_operators
          WHERE invoice_id = request_invoice_id
        ) THEN
          RAISE EXCEPTION 'Cashu payment request requires at least one operator'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER invoice_cashu_requests_operator_required
        AFTER INSERT OR UPDATE ON invoice_cashu_requests
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_cashu_request_operator();

      CREATE CONSTRAINT TRIGGER invoice_cashu_request_operators_required
        AFTER DELETE OR UPDATE ON invoice_cashu_request_operators
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_cashu_request_operator();

      CREATE FUNCTION cashmesh_require_invoice_cashu_request()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        checkout_invoice_id VARCHAR(128);
      BEGIN
        IF TG_TABLE_NAME = 'merchant_invoices' THEN
          checkout_invoice_id := NEW.id;
        ELSE
          checkout_invoice_id := OLD.invoice_id;
        END IF;

        IF EXISTS (
          SELECT 1 FROM merchant_invoices WHERE id = checkout_invoice_id
        ) AND NOT EXISTS (
          SELECT 1 FROM invoice_cashu_requests WHERE invoice_id = checkout_invoice_id
        ) THEN
          RAISE EXCEPTION 'Merchant invoice requires a Cashu payment request'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER merchant_invoices_cashu_request_required
        AFTER INSERT OR UPDATE ON merchant_invoices
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_invoice_cashu_request();

      CREATE CONSTRAINT TRIGGER invoice_cashu_requests_invoice_required
        AFTER DELETE OR UPDATE ON invoice_cashu_requests
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_invoice_cashu_request();
    `,
    version: 2,
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

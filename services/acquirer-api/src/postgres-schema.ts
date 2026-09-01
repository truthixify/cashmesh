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
  Object.freeze({
    name: "persist_cashu_keyset_observations",
    sql: `
      CREATE TABLE cashu_keysets (
        mint_url VARCHAR(512) NOT NULL,
        keyset_id VARCHAR(66) NOT NULL,
        unit VARCHAR(32) NOT NULL,
        input_fee_ppk BIGINT NOT NULL,
        final_expiry BIGINT,
        keys JSONB NOT NULL,
        identity_fingerprint CHAR(64) NOT NULL,
        CONSTRAINT cashu_keysets_pkey PRIMARY KEY (mint_url, keyset_id),
        CONSTRAINT cashu_keysets_mint_id_unit_unique UNIQUE (mint_url, keyset_id, unit),
        CONSTRAINT cashu_keysets_mint_url CHECK (
          mint_url ~ '^https://[^[:space:]]+$'
        ),
        CONSTRAINT cashu_keysets_id CHECK (
          keyset_id ~ '^(00[0-9a-f]{14}|01[0-9a-f]{64})$'
        ),
        CONSTRAINT cashu_keysets_unit CHECK (
          unit ~ '^[a-z0-9][a-z0-9._:-]*$'
        ),
        CONSTRAINT cashu_keysets_input_fee CHECK (
          input_fee_ppk >= 0 AND input_fee_ppk <= 9007199254740991
        ),
        CONSTRAINT cashu_keysets_final_expiry CHECK (
          final_expiry IS NULL
          OR (final_expiry > 0 AND final_expiry <= 9007199254740991)
        ),
        CONSTRAINT cashu_keysets_keys CHECK (
          jsonb_typeof(keys) = 'object' AND keys <> '{}'::jsonb
        ),
        CONSTRAINT cashu_keysets_identity_fingerprint CHECK (
          identity_fingerprint ~ '^[0-9a-f]{64}$'
        )
      );

      CREATE TABLE cashu_keyset_observations (
        snapshot_fingerprint CHAR(64) PRIMARY KEY,
        operator_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        unit VARCHAR(32) NOT NULL,
        schema_version SMALLINT NOT NULL,
        observed_at BIGINT NOT NULL,
        CONSTRAINT cashu_keyset_observations_scope_time_unique UNIQUE (
          operator_id,
          mint_url,
          unit,
          observed_at
        ),
        CONSTRAINT cashu_keyset_observations_fingerprint_scope_unique UNIQUE (
          snapshot_fingerprint,
          mint_url,
          unit
        ),
        CONSTRAINT cashu_keyset_observations_fingerprint CHECK (
          snapshot_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_keyset_observations_operator CHECK (
          operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_keyset_observations_mint_url CHECK (
          mint_url ~ '^https://[^[:space:]]+$'
        ),
        CONSTRAINT cashu_keyset_observations_unit CHECK (
          unit ~ '^[a-z0-9][a-z0-9._:-]*$'
        ),
        CONSTRAINT cashu_keyset_observations_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_keyset_observations_observed_at CHECK (
          observed_at >= 0 AND observed_at <= 9007199254740991
        )
      );

      CREATE INDEX cashu_keyset_observations_latest_idx
        ON cashu_keyset_observations (
          operator_id,
          mint_url,
          unit,
          observed_at DESC,
          snapshot_fingerprint
        );

      CREATE TABLE cashu_keyset_observation_entries (
        snapshot_fingerprint CHAR(64) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        unit VARCHAR(32) NOT NULL,
        position SMALLINT NOT NULL,
        keyset_id VARCHAR(66) NOT NULL,
        active BOOLEAN NOT NULL,
        CONSTRAINT cashu_keyset_observation_entries_pkey PRIMARY KEY (
          snapshot_fingerprint,
          position
        ),
        CONSTRAINT cashu_keyset_observation_entries_keyset_unique UNIQUE (
          snapshot_fingerprint,
          keyset_id
        ),
        CONSTRAINT cashu_keyset_observation_entries_position CHECK (
          position >= 0 AND position < 64
        ),
        CONSTRAINT cashu_keyset_observation_entries_observation_fkey
          FOREIGN KEY (snapshot_fingerprint, mint_url, unit)
          REFERENCES cashu_keyset_observations (snapshot_fingerprint, mint_url, unit)
          ON DELETE RESTRICT,
        CONSTRAINT cashu_keyset_observation_entries_keyset_fkey
          FOREIGN KEY (mint_url, keyset_id, unit)
          REFERENCES cashu_keysets (mint_url, keyset_id, unit)
          ON DELETE RESTRICT
      );

      CREATE FUNCTION cashmesh_reject_cashu_keyset_evidence_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Cashu keyset evidence is append-only'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE TRIGGER cashu_keysets_append_only
        BEFORE UPDATE OR DELETE ON cashu_keysets
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_keyset_evidence_mutation();

      CREATE TRIGGER cashu_keyset_observations_append_only
        BEFORE UPDATE OR DELETE ON cashu_keyset_observations
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_keyset_evidence_mutation();

      CREATE TRIGGER cashu_keyset_observation_entries_append_only
        BEFORE UPDATE OR DELETE ON cashu_keyset_observation_entries
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_keyset_evidence_mutation();

      CREATE FUNCTION cashmesh_require_cashu_keyset_observation_entry()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        observation_fingerprint CHAR(64);
      BEGIN
        IF TG_TABLE_NAME = 'cashu_keyset_observations' THEN
          observation_fingerprint := NEW.snapshot_fingerprint;
        ELSE
          observation_fingerprint := OLD.snapshot_fingerprint;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM cashu_keyset_observations
          WHERE snapshot_fingerprint = observation_fingerprint
        ) AND NOT EXISTS (
          SELECT 1
          FROM cashu_keyset_observation_entries
          WHERE snapshot_fingerprint = observation_fingerprint
        ) THEN
          RAISE EXCEPTION 'Cashu keyset observation requires at least one entry'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER cashu_keyset_observations_entry_required
        AFTER INSERT OR UPDATE ON cashu_keyset_observations
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_cashu_keyset_observation_entry();

      CREATE CONSTRAINT TRIGGER cashu_keyset_observation_entries_required
        AFTER DELETE OR UPDATE ON cashu_keyset_observation_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_cashu_keyset_observation_entry();
    `,
    version: 3,
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

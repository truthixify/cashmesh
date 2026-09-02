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
  Object.freeze({
    name: "reserve_cashu_proof_references",
    sql: `
      ALTER TABLE invoice_cashu_request_operators
        ADD CONSTRAINT invoice_cashu_operators_route_unique
        UNIQUE (invoice_id, operator_id, mint_url);

      CREATE TABLE cashu_proof_reservations (
        payment_id VARCHAR(128) PRIMARY KEY,
        reservation_fingerprint CHAR(64) NOT NULL UNIQUE,
        invoice_id VARCHAR(128) NOT NULL,
        operator_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        unit VARCHAR(32) NOT NULL,
        schema_version SMALLINT NOT NULL,
        keyset_observed_at BIGINT NOT NULL,
        reserved_at BIGINT NOT NULL,
        gross_amount BIGINT NOT NULL,
        CONSTRAINT cashu_proof_reservations_payment_mint_unit_unique UNIQUE (
          payment_id,
          mint_url,
          unit
        ),
        CONSTRAINT cashu_proof_reservations_payment_id CHECK (
          payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_proof_reservations_fingerprint CHECK (
          reservation_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_proof_reservations_invoice_id CHECK (
          invoice_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_proof_reservations_operator_id CHECK (
          operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_proof_reservations_mint_url CHECK (
          mint_url ~ '^https://[^[:space:]]+$'
        ),
        CONSTRAINT cashu_proof_reservations_unit CHECK (
          unit ~ '^[a-z0-9][a-z0-9._:-]*$'
        ),
        CONSTRAINT cashu_proof_reservations_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_proof_reservations_keyset_observed_at CHECK (
          keyset_observed_at >= 0
          AND keyset_observed_at <= reserved_at
          AND keyset_observed_at <= 9007199254740991
        ),
        CONSTRAINT cashu_proof_reservations_reserved_at CHECK (
          reserved_at >= 0 AND reserved_at <= 9007199254740991
        ),
        CONSTRAINT cashu_proof_reservations_gross_amount CHECK (
          gross_amount > 0 AND gross_amount <= 9007199254740991
        ),
        CONSTRAINT cashu_proof_reservations_invoice_fkey
          FOREIGN KEY (invoice_id)
          REFERENCES merchant_invoices (id)
          ON DELETE RESTRICT,
        CONSTRAINT cashu_proof_reservations_route_fkey
          FOREIGN KEY (invoice_id, operator_id, mint_url)
          REFERENCES invoice_cashu_request_operators (invoice_id, operator_id, mint_url)
          ON DELETE RESTRICT
      );

      CREATE INDEX cashu_proof_reservations_invoice_idx
        ON cashu_proof_reservations (invoice_id, reserved_at, payment_id);

      CREATE TABLE cashu_reserved_proofs (
        payment_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        unit VARCHAR(32) NOT NULL,
        position SMALLINT NOT NULL,
        proof_y CHAR(66) NOT NULL,
        keyset_id VARCHAR(66) NOT NULL,
        amount BIGINT NOT NULL,
        CONSTRAINT cashu_reserved_proofs_pkey PRIMARY KEY (payment_id, position),
        CONSTRAINT cashu_reserved_proofs_mint_y_unique UNIQUE (mint_url, proof_y),
        CONSTRAINT cashu_reserved_proofs_payment_y_unique UNIQUE (payment_id, proof_y),
        CONSTRAINT cashu_reserved_proofs_position CHECK (
          position >= 0 AND position < 128
        ),
        CONSTRAINT cashu_reserved_proofs_y CHECK (
          proof_y ~ '^(02|03)[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_reserved_proofs_keyset_id CHECK (
          keyset_id ~ '^(00[0-9a-f]{14}|01[0-9a-f]{64})$'
        ),
        CONSTRAINT cashu_reserved_proofs_amount CHECK (
          amount > 0 AND amount <= 9007199254740991
        ),
        CONSTRAINT cashu_reserved_proofs_reservation_fkey
          FOREIGN KEY (payment_id, mint_url, unit)
          REFERENCES cashu_proof_reservations (payment_id, mint_url, unit)
          ON DELETE RESTRICT,
        CONSTRAINT cashu_reserved_proofs_keyset_fkey
          FOREIGN KEY (mint_url, keyset_id, unit)
          REFERENCES cashu_keysets (mint_url, keyset_id, unit)
          ON DELETE RESTRICT
      );

      CREATE FUNCTION cashmesh_reject_cashu_proof_reservation_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Cashu proof reservations are append-only'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE TRIGGER cashu_proof_reservations_append_only
        BEFORE UPDATE OR DELETE ON cashu_proof_reservations
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_proof_reservation_mutation();

      CREATE TRIGGER cashu_reserved_proofs_append_only
        BEFORE UPDATE OR DELETE ON cashu_reserved_proofs
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_proof_reservation_mutation();

      CREATE FUNCTION cashmesh_validate_cashu_proof_reservation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        reservation_payment_id VARCHAR(128);
        reservation_record cashu_proof_reservations%ROWTYPE;
        invoice_record merchant_invoices%ROWTYPE;
        proof_count BIGINT;
        proof_total NUMERIC;
        maximum_position SMALLINT;
      BEGIN
        IF TG_TABLE_NAME = 'cashu_proof_reservations' THEN
          reservation_payment_id := NEW.payment_id;
        ELSIF TG_OP = 'DELETE' THEN
          reservation_payment_id := OLD.payment_id;
        ELSE
          reservation_payment_id := NEW.payment_id;
        END IF;

        SELECT * INTO reservation_record
        FROM cashu_proof_reservations
        WHERE payment_id = reservation_payment_id;

        IF NOT FOUND THEN
          RETURN NULL;
        END IF;

        SELECT * INTO invoice_record
        FROM merchant_invoices
        WHERE id = reservation_record.invoice_id;

        IF NOT FOUND
          OR invoice_record.state <> 'open'
          OR invoice_record.unit <> reservation_record.unit
          OR reservation_record.reserved_at < invoice_record.created_at
          OR reservation_record.reserved_at >= invoice_record.expires_at
        THEN
          RAISE EXCEPTION 'Cashu proof reservation requires an open invoice window'
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT COUNT(*), COALESCE(SUM(amount), 0), MAX(position)
          INTO proof_count, proof_total, maximum_position
        FROM cashu_reserved_proofs
        WHERE payment_id = reservation_payment_id;

        IF proof_count = 0
          OR proof_count > 128
          OR maximum_position <> proof_count - 1
          OR proof_total <> reservation_record.gross_amount
        THEN
          RAISE EXCEPTION 'Cashu proof reservation entries are incomplete or inconsistent'
            USING ERRCODE = 'check_violation';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM cashu_reserved_proofs AS proof
          WHERE proof.payment_id = reservation_payment_id
            AND NOT EXISTS (
              SELECT 1
              FROM cashu_keyset_observations AS observation
              JOIN cashu_keyset_observation_entries AS entry
                ON entry.snapshot_fingerprint = observation.snapshot_fingerprint
              WHERE observation.operator_id = reservation_record.operator_id
                AND observation.mint_url = reservation_record.mint_url
                AND observation.unit = reservation_record.unit
                AND observation.observed_at = reservation_record.keyset_observed_at
                AND entry.keyset_id = proof.keyset_id
            )
        ) THEN
          RAISE EXCEPTION 'Cashu proof reservation lacks matching keyset observation evidence'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER cashu_proof_reservations_valid
        AFTER INSERT OR UPDATE ON cashu_proof_reservations
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_proof_reservation();

      CREATE CONSTRAINT TRIGGER cashu_reserved_proofs_valid
        AFTER INSERT OR UPDATE OR DELETE ON cashu_reserved_proofs
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_proof_reservation();
    `,
    version: 4,
  }),
  Object.freeze({
    name: "persist_cashu_proof_state_observations",
    sql: `
      ALTER TABLE cashu_proof_reservations
        ADD CONSTRAINT cashu_proof_reservations_state_scope_unique
        UNIQUE (payment_id, operator_id, mint_url, unit);

      CREATE TABLE cashu_proof_state_observations (
        snapshot_fingerprint CHAR(64) PRIMARY KEY,
        payment_id VARCHAR(128) NOT NULL,
        operator_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        unit VARCHAR(32) NOT NULL,
        schema_version SMALLINT NOT NULL,
        observed_at BIGINT NOT NULL,
        CONSTRAINT cashu_proof_state_observations_fingerprint_payment_unique UNIQUE (
          snapshot_fingerprint,
          payment_id
        ),
        CONSTRAINT cashu_proof_state_observations_payment_time_unique UNIQUE (
          payment_id,
          observed_at
        ),
        CONSTRAINT cashu_proof_state_observations_fingerprint CHECK (
          snapshot_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_proof_state_observations_payment_id CHECK (
          payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_proof_state_observations_operator_id CHECK (
          operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_proof_state_observations_mint_url CHECK (
          mint_url ~ '^https://[^[:space:]]+$'
        ),
        CONSTRAINT cashu_proof_state_observations_unit CHECK (
          unit ~ '^[a-z0-9][a-z0-9._:-]*$'
        ),
        CONSTRAINT cashu_proof_state_observations_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_proof_state_observations_observed_at CHECK (
          observed_at >= 0 AND observed_at <= 9007199254740991
        ),
        CONSTRAINT cashu_proof_state_observations_reservation_fkey
          FOREIGN KEY (payment_id, operator_id, mint_url, unit)
          REFERENCES cashu_proof_reservations (payment_id, operator_id, mint_url, unit)
          ON DELETE RESTRICT
      );

      CREATE INDEX cashu_proof_state_observations_latest_idx
        ON cashu_proof_state_observations (
          payment_id,
          operator_id,
          mint_url,
          unit,
          observed_at DESC,
          snapshot_fingerprint
        );

      CREATE TABLE cashu_proof_state_observation_entries (
        snapshot_fingerprint CHAR(64) NOT NULL,
        payment_id VARCHAR(128) NOT NULL,
        position SMALLINT NOT NULL,
        proof_y CHAR(66) NOT NULL,
        state TEXT NOT NULL,
        CONSTRAINT cashu_proof_state_observation_entries_pkey PRIMARY KEY (
          snapshot_fingerprint,
          position
        ),
        CONSTRAINT cashu_proof_state_observation_entries_proof_unique UNIQUE (
          snapshot_fingerprint,
          proof_y
        ),
        CONSTRAINT cashu_proof_state_observation_entries_position CHECK (
          position >= 0 AND position < 128
        ),
        CONSTRAINT cashu_proof_state_observation_entries_y CHECK (
          proof_y ~ '^(02|03)[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_proof_state_observation_entries_state CHECK (
          state IN ('UNSPENT', 'PENDING', 'SPENT')
        ),
        CONSTRAINT cashu_proof_state_observation_entries_observation_fkey
          FOREIGN KEY (snapshot_fingerprint, payment_id)
          REFERENCES cashu_proof_state_observations (snapshot_fingerprint, payment_id)
          ON DELETE RESTRICT,
        CONSTRAINT cashu_proof_state_observation_entries_reservation_fkey
          FOREIGN KEY (payment_id, proof_y)
          REFERENCES cashu_reserved_proofs (payment_id, proof_y)
          ON DELETE RESTRICT
      );

      CREATE FUNCTION cashmesh_reject_cashu_proof_state_evidence_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Cashu proof-state evidence is append-only'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE TRIGGER cashu_proof_state_observations_append_only
        BEFORE UPDATE OR DELETE ON cashu_proof_state_observations
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_proof_state_evidence_mutation();

      CREATE TRIGGER cashu_proof_state_observation_entries_append_only
        BEFORE UPDATE OR DELETE ON cashu_proof_state_observation_entries
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_proof_state_evidence_mutation();

      CREATE FUNCTION cashmesh_validate_cashu_proof_state_observation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        entry_count INTEGER;
        expected_count INTEGER;
        first_position INTEGER;
        last_position INTEGER;
        observation_fingerprint CHAR(64);
        observation_record cashu_proof_state_observations%ROWTYPE;
        reservation_record cashu_proof_reservations%ROWTYPE;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          observation_fingerprint := OLD.snapshot_fingerprint;
        ELSE
          observation_fingerprint := NEW.snapshot_fingerprint;
        END IF;

        SELECT * INTO observation_record
        FROM cashu_proof_state_observations
        WHERE snapshot_fingerprint = observation_fingerprint;

        IF NOT FOUND THEN
          RETURN NULL;
        END IF;

        SELECT * INTO reservation_record
        FROM cashu_proof_reservations
        WHERE payment_id = observation_record.payment_id;

        IF NOT FOUND
          OR reservation_record.operator_id <> observation_record.operator_id
          OR reservation_record.mint_url <> observation_record.mint_url
          OR reservation_record.unit <> observation_record.unit
          OR observation_record.observed_at < reservation_record.reserved_at
        THEN
          RAISE EXCEPTION 'Cashu proof-state observation requires its exact reservation scope'
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT COUNT(*), MIN(position), MAX(position)
          INTO entry_count, first_position, last_position
        FROM cashu_proof_state_observation_entries
        WHERE snapshot_fingerprint = observation_fingerprint;

        SELECT COUNT(*) INTO expected_count
        FROM cashu_reserved_proofs
        WHERE payment_id = observation_record.payment_id;

        IF entry_count = 0
          OR entry_count <> expected_count
          OR first_position <> 0
          OR last_position <> entry_count - 1
          OR EXISTS (
            SELECT 1
            FROM cashu_reserved_proofs AS proof
            WHERE proof.payment_id = observation_record.payment_id
              AND NOT EXISTS (
                SELECT 1
                FROM cashu_proof_state_observation_entries AS entry
                WHERE entry.snapshot_fingerprint = observation_fingerprint
                  AND entry.payment_id = observation_record.payment_id
                  AND entry.proof_y = proof.proof_y
              )
          )
        THEN
          RAISE EXCEPTION 'Cashu proof-state observation entries are incomplete or inconsistent'
            USING ERRCODE = 'check_violation';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM cashu_proof_state_observation_entries AS current_entry
          JOIN cashu_proof_state_observations AS other_observation
            ON other_observation.payment_id = observation_record.payment_id
            AND other_observation.snapshot_fingerprint <> observation_fingerprint
          JOIN cashu_proof_state_observation_entries AS other_entry
            ON other_entry.snapshot_fingerprint = other_observation.snapshot_fingerprint
            AND other_entry.proof_y = current_entry.proof_y
          WHERE current_entry.snapshot_fingerprint = observation_fingerprint
            AND (
              (
                other_observation.observed_at < observation_record.observed_at
                AND other_entry.state = 'SPENT'
                AND current_entry.state <> 'SPENT'
              )
              OR (
                other_observation.observed_at > observation_record.observed_at
                AND current_entry.state = 'SPENT'
                AND other_entry.state <> 'SPENT'
              )
            )
        ) THEN
          RAISE EXCEPTION 'Cashu proof-state SPENT evidence is terminal'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER cashu_proof_state_observations_valid
        AFTER INSERT OR UPDATE ON cashu_proof_state_observations
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_proof_state_observation();

      CREATE CONSTRAINT TRIGGER cashu_proof_state_observation_entries_valid
        AFTER UPDATE OR DELETE ON cashu_proof_state_observation_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_proof_state_observation();
    `,
    version: 5,
  }),
  Object.freeze({
    name: "add_cashu_proof_reservation_lifecycle",
    sql: `
      ALTER TABLE cashu_proof_reservations
        ADD CONSTRAINT cashu_proof_reservations_lifecycle_scope_unique
        UNIQUE (payment_id, invoice_id, operator_id, mint_url);

      ALTER TABLE cashu_reserved_proofs
        ADD CONSTRAINT cashu_reserved_proofs_payment_mint_y_unique
        UNIQUE (payment_id, mint_url, proof_y);

      CREATE TABLE cashu_active_proof_claims (
        mint_url VARCHAR(512) NOT NULL,
        proof_y CHAR(66) NOT NULL,
        payment_id VARCHAR(128) NOT NULL,
        CONSTRAINT cashu_active_proof_claims_pkey PRIMARY KEY (mint_url, proof_y),
        CONSTRAINT cashu_active_proof_claims_payment_y_unique UNIQUE (payment_id, proof_y),
        CONSTRAINT cashu_active_proof_claims_reserved_proof_fkey
          FOREIGN KEY (payment_id, mint_url, proof_y)
          REFERENCES cashu_reserved_proofs (payment_id, mint_url, proof_y)
          ON DELETE RESTRICT
      );

      INSERT INTO cashu_active_proof_claims (mint_url, proof_y, payment_id)
      SELECT mint_url, proof_y, payment_id
      FROM cashu_reserved_proofs;

      ALTER TABLE cashu_reserved_proofs
        DROP CONSTRAINT cashu_reserved_proofs_mint_y_unique;

      CREATE FUNCTION cashmesh_claim_cashu_reserved_proof()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO cashu_active_proof_claims (mint_url, proof_y, payment_id)
        VALUES (NEW.mint_url, NEW.proof_y, NEW.payment_id);
        RETURN NULL;
      END
      $$;

      CREATE TRIGGER cashu_reserved_proofs_claim_active
        AFTER INSERT ON cashu_reserved_proofs
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_claim_cashu_reserved_proof();

      CREATE TABLE cashu_operator_effects (
        effect_id VARCHAR(128) PRIMARY KEY,
        effect_fingerprint CHAR(64) NOT NULL UNIQUE,
        dispatch_fingerprint CHAR(64) NOT NULL,
        payment_id VARCHAR(128) NOT NULL UNIQUE,
        invoice_id VARCHAR(128) NOT NULL,
        operator_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        effect_kind TEXT NOT NULL,
        operator_reference VARCHAR(128),
        operator_reference_expires_at BIGINT,
        schema_version SMALLINT NOT NULL,
        started_at BIGINT NOT NULL,
        CONSTRAINT cashu_operator_effects_effect_payment_unique UNIQUE (effect_id, payment_id),
        CONSTRAINT cashu_operator_effects_effect_payment_invoice_unique UNIQUE (
          effect_id,
          payment_id,
          invoice_id
        ),
        CONSTRAINT cashu_operator_effects_remote_reference_unique UNIQUE (
          mint_url,
          effect_kind,
          operator_reference
        ),
        CONSTRAINT cashu_operator_effects_dispatch_unique UNIQUE (
          mint_url,
          effect_kind,
          dispatch_fingerprint
        ),
        CONSTRAINT cashu_operator_effects_id CHECK (
          effect_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_operator_effects_fingerprint CHECK (
          effect_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_operator_effects_dispatch_fingerprint CHECK (
          dispatch_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_operator_effects_kind CHECK (effect_kind IN ('swap', 'melt')),
        CONSTRAINT cashu_operator_effects_reference CHECK (
          (
            effect_kind = 'swap'
            AND operator_reference IS NULL
            AND operator_reference_expires_at IS NULL
          )
          OR (
            effect_kind = 'melt'
            AND operator_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
            AND operator_reference_expires_at > started_at
            AND operator_reference_expires_at <= 9007199254740991
          )
        ),
        CONSTRAINT cashu_operator_effects_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_operator_effects_started_at CHECK (
          started_at >= 0 AND started_at <= 9007199254740991
        ),
        CONSTRAINT cashu_operator_effects_reservation_fkey
          FOREIGN KEY (payment_id, invoice_id, operator_id, mint_url)
          REFERENCES cashu_proof_reservations (payment_id, invoice_id, operator_id, mint_url)
          ON DELETE RESTRICT
      );

      CREATE TABLE cashu_active_invoice_payment_claims (
        invoice_id VARCHAR(128) PRIMARY KEY,
        payment_id VARCHAR(128) NOT NULL UNIQUE,
        effect_id VARCHAR(128) NOT NULL UNIQUE,
        CONSTRAINT cashu_active_invoice_payment_claims_effect_fkey
          FOREIGN KEY (effect_id, payment_id, invoice_id)
          REFERENCES cashu_operator_effects (effect_id, payment_id, invoice_id)
          ON DELETE RESTRICT
      );

      CREATE FUNCTION cashmesh_claim_cashu_operator_effect_invoice()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO cashu_active_invoice_payment_claims (invoice_id, payment_id, effect_id)
        VALUES (NEW.invoice_id, NEW.payment_id, NEW.effect_id);
        RETURN NULL;
      END
      $$;

      CREATE TRIGGER cashu_operator_effects_claim_invoice
        AFTER INSERT ON cashu_operator_effects
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_claim_cashu_operator_effect_invoice();

      CREATE TABLE cashu_proof_reservation_events (
        event_id VARCHAR(128) PRIMARY KEY,
        event_fingerprint CHAR(64) NOT NULL UNIQUE,
        payment_id VARCHAR(128) NOT NULL,
        sequence SMALLINT NOT NULL,
        schema_version SMALLINT NOT NULL,
        state TEXT NOT NULL,
        recorded_at BIGINT NOT NULL,
        effect_id VARCHAR(128),
        evidence_kind TEXT,
        evidence_at BIGINT,
        proof_state_snapshot_fingerprint CHAR(64),
        CONSTRAINT cashu_proof_reservation_events_payment_sequence_unique UNIQUE (
          payment_id,
          sequence
        ),
        CONSTRAINT cashu_proof_reservation_events_id CHECK (
          event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_proof_reservation_events_fingerprint CHECK (
          event_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_proof_reservation_events_sequence CHECK (
          sequence >= 0 AND sequence < 1024
        ),
        CONSTRAINT cashu_proof_reservation_events_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_proof_reservation_events_state CHECK (
          state IN (
            'dispatch_started',
            'pending',
            'needs_attention',
            'consumed',
            'released'
          )
        ),
        CONSTRAINT cashu_proof_reservation_events_recorded_at CHECK (
          recorded_at >= 0 AND recorded_at <= 9007199254740991
        ),
        CONSTRAINT cashu_proof_reservation_events_evidence_at CHECK (
          evidence_at IS NULL
          OR (evidence_at >= 0 AND evidence_at <= recorded_at)
        ),
        CONSTRAINT cashu_proof_reservation_events_shape CHECK (
          (
            state = 'dispatch_started'
            AND effect_id IS NOT NULL
            AND evidence_kind IS NULL
            AND evidence_at IS NULL
            AND proof_state_snapshot_fingerprint IS NULL
          )
          OR (
            state = 'pending'
            AND effect_id IS NOT NULL
            AND evidence_kind = 'operator_pending'
            AND evidence_at IS NOT NULL
            AND proof_state_snapshot_fingerprint IS NULL
          )
          OR (
            state = 'needs_attention'
            AND effect_id IS NOT NULL
            AND evidence_kind IN (
              'transport_ambiguous',
              'operator_state_unknown',
              'operator_response_invalid'
            )
            AND evidence_at IS NOT NULL
            AND proof_state_snapshot_fingerprint IS NULL
          )
          OR (
            state = 'consumed'
            AND effect_id IS NOT NULL
            AND evidence_kind IN ('swap_succeeded', 'melt_paid')
            AND evidence_at IS NOT NULL
            AND proof_state_snapshot_fingerprint IS NOT NULL
          )
          OR (
            state = 'released'
            AND effect_id IS NULL
            AND evidence_kind = 'pre_dispatch'
            AND evidence_at IS NULL
            AND proof_state_snapshot_fingerprint IS NULL
          )
          OR (
            state = 'released'
            AND effect_id IS NOT NULL
            AND evidence_kind IN ('swap_rejected', 'melt_unpaid_after_expiry')
            AND evidence_at IS NOT NULL
            AND proof_state_snapshot_fingerprint IS NOT NULL
          )
        ),
        CONSTRAINT cashu_proof_reservation_events_reservation_fkey
          FOREIGN KEY (payment_id)
          REFERENCES cashu_proof_reservations (payment_id)
          ON DELETE RESTRICT,
        CONSTRAINT cashu_proof_reservation_events_effect_fkey
          FOREIGN KEY (effect_id, payment_id)
          REFERENCES cashu_operator_effects (effect_id, payment_id)
          ON DELETE RESTRICT,
        CONSTRAINT cashu_proof_reservation_events_proof_state_fkey
          FOREIGN KEY (proof_state_snapshot_fingerprint, payment_id)
          REFERENCES cashu_proof_state_observations (snapshot_fingerprint, payment_id)
          ON DELETE RESTRICT
      );

      CREATE INDEX cashu_proof_reservation_events_latest_idx
        ON cashu_proof_reservation_events (payment_id, sequence DESC);

      CREATE FUNCTION cashmesh_reject_cashu_reservation_lifecycle_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Cashu reservation lifecycle evidence is append-only'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE TRIGGER cashu_operator_effects_append_only
        BEFORE UPDATE OR DELETE ON cashu_operator_effects
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_reservation_lifecycle_mutation();

      CREATE TRIGGER cashu_proof_reservation_events_append_only
        BEFORE UPDATE OR DELETE ON cashu_proof_reservation_events
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_reservation_lifecycle_mutation();

      CREATE FUNCTION cashmesh_reject_cashu_active_claim_update()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Cashu active claims cannot be updated'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE TRIGGER cashu_active_proof_claims_no_update
        BEFORE UPDATE ON cashu_active_proof_claims
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_active_claim_update();

      CREATE TRIGGER cashu_active_invoice_payment_claims_no_update
        BEFORE UPDATE ON cashu_active_invoice_payment_claims
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_active_claim_update();

      CREATE FUNCTION cashmesh_validate_cashu_reservation_event()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        effect_record cashu_operator_effects%ROWTYPE;
        invoice_record merchant_invoices%ROWTYPE;
        matching_state_count INTEGER;
        observation_record cashu_proof_state_observations%ROWTYPE;
        previous_event cashu_proof_reservation_events%ROWTYPE;
        reservation_record cashu_proof_reservations%ROWTYPE;
        state_entry_count INTEGER;
      BEGIN
        SELECT * INTO reservation_record
        FROM cashu_proof_reservations
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;

        IF NOT FOUND OR NEW.recorded_at < reservation_record.reserved_at THEN
          RAISE EXCEPTION 'Cashu reservation event requires its reservation time boundary'
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT * INTO previous_event
        FROM cashu_proof_reservation_events
        WHERE payment_id = NEW.payment_id
        ORDER BY sequence DESC
        LIMIT 1;

        IF FOUND THEN
          IF NEW.sequence <> previous_event.sequence + 1
            OR NEW.recorded_at < previous_event.recorded_at
            OR previous_event.state IN ('consumed', 'released')
            OR NEW.state = 'dispatch_started'
            OR NEW.effect_id IS DISTINCT FROM previous_event.effect_id
            OR NEW.state NOT IN ('pending', 'needs_attention', 'consumed', 'released')
          THEN
            RAISE EXCEPTION 'Cashu reservation lifecycle transition is invalid'
              USING ERRCODE = 'check_violation';
          END IF;
        ELSE
          IF NEW.sequence <> 0
            OR NEW.state NOT IN ('dispatch_started', 'released')
            OR (NEW.state = 'released' AND NEW.evidence_kind <> 'pre_dispatch')
          THEN
            RAISE EXCEPTION 'Cashu reservation lifecycle must begin at dispatch or release'
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;

        IF NEW.effect_id IS NOT NULL THEN
          SELECT * INTO effect_record
          FROM cashu_operator_effects
          WHERE effect_id = NEW.effect_id
            AND payment_id = NEW.payment_id;

          IF NOT FOUND
            OR effect_record.started_at > NEW.recorded_at
            OR (
              NEW.evidence_at IS NOT NULL
              AND NEW.evidence_at < effect_record.started_at
            )
          THEN
            RAISE EXCEPTION 'Cashu reservation event does not match its operator effect'
              USING ERRCODE = 'check_violation';
          END IF;

          IF NEW.state = 'dispatch_started' THEN
            SELECT * INTO invoice_record
            FROM merchant_invoices
            WHERE id = reservation_record.invoice_id;

            IF effect_record.started_at <> NEW.recorded_at
              OR NOT FOUND
              OR invoice_record.state <> 'open'
              OR effect_record.started_at < invoice_record.created_at
              OR effect_record.started_at >= invoice_record.expires_at
            THEN
              RAISE EXCEPTION 'Cashu operator effect requires an open invoice window'
                USING ERRCODE = 'check_violation';
            END IF;
          END IF;

          IF (NEW.evidence_kind = 'swap_succeeded' AND effect_record.effect_kind <> 'swap')
            OR (NEW.evidence_kind = 'melt_paid' AND effect_record.effect_kind <> 'melt')
            OR (NEW.evidence_kind = 'swap_rejected' AND effect_record.effect_kind <> 'swap')
            OR (
              NEW.evidence_kind = 'melt_unpaid_after_expiry'
              AND (
                effect_record.effect_kind <> 'melt'
                OR NEW.evidence_at < effect_record.operator_reference_expires_at
              )
            )
            OR (NEW.evidence_kind = 'operator_pending' AND effect_record.effect_kind <> 'melt')
          THEN
            RAISE EXCEPTION 'Cashu operator evidence does not match the effect kind'
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;

        IF NEW.proof_state_snapshot_fingerprint IS NOT NULL THEN
          SELECT * INTO observation_record
          FROM cashu_proof_state_observations
          WHERE snapshot_fingerprint = NEW.proof_state_snapshot_fingerprint
            AND payment_id = NEW.payment_id;

          IF NOT FOUND
            OR observation_record.observed_at < NEW.evidence_at
            OR observation_record.observed_at > NEW.recorded_at
          THEN
            RAISE EXCEPTION 'Cashu terminal lifecycle event lacks ordered proof-state evidence'
              USING ERRCODE = 'check_violation';
          END IF;

          SELECT
            COUNT(*),
            COUNT(*) FILTER (
              WHERE state = CASE WHEN NEW.state = 'consumed' THEN 'SPENT' ELSE 'UNSPENT' END
            )
            INTO state_entry_count, matching_state_count
          FROM cashu_proof_state_observation_entries
          WHERE snapshot_fingerprint = NEW.proof_state_snapshot_fingerprint;

          IF state_entry_count = 0 OR matching_state_count <> state_entry_count THEN
            RAISE EXCEPTION 'Cashu terminal lifecycle event requires one uniform proof state'
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;

        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_proof_reservation_events_validate
        BEFORE INSERT ON cashu_proof_reservation_events
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_reservation_event();

      CREATE FUNCTION cashmesh_require_cashu_operator_effect_event()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM cashu_proof_reservation_events
          WHERE payment_id = NEW.payment_id
            AND sequence = 0
            AND state = 'dispatch_started'
            AND effect_id = NEW.effect_id
            AND recorded_at = NEW.started_at
        ) THEN
          RAISE EXCEPTION 'Cashu operator effect requires a matching dispatch event'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER cashu_operator_effects_event_required
        AFTER INSERT ON cashu_operator_effects
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_cashu_operator_effect_event();

      CREATE FUNCTION cashmesh_validate_cashu_active_claims()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        active_invoice_count INTEGER;
        active_proof_count INTEGER;
        effect_exists BOOLEAN;
        effect_record cashu_operator_effects%ROWTYPE;
        expected_proof_count INTEGER;
        latest_state TEXT;
        reservation_payment_id VARCHAR(128);
      BEGIN
        IF TG_OP = 'DELETE' THEN
          reservation_payment_id := OLD.payment_id;
        ELSE
          reservation_payment_id := NEW.payment_id;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM cashu_proof_reservations WHERE payment_id = reservation_payment_id
        ) THEN
          RETURN NULL;
        END IF;

        SELECT state INTO latest_state
        FROM cashu_proof_reservation_events
        WHERE payment_id = reservation_payment_id
        ORDER BY sequence DESC
        LIMIT 1;
        latest_state := COALESCE(latest_state, 'reserved');

        SELECT COUNT(*) INTO expected_proof_count
        FROM cashu_reserved_proofs
        WHERE payment_id = reservation_payment_id;

        SELECT COUNT(*) INTO active_proof_count
        FROM cashu_active_proof_claims AS claim
        JOIN cashu_reserved_proofs AS proof
          ON proof.payment_id = claim.payment_id
          AND proof.mint_url = claim.mint_url
          AND proof.proof_y = claim.proof_y
        WHERE claim.payment_id = reservation_payment_id;

        IF (latest_state = 'released' AND active_proof_count <> 0)
          OR (
            latest_state <> 'released'
            AND active_proof_count <> expected_proof_count
          )
        THEN
          RAISE EXCEPTION 'Cashu active proof claims do not match lifecycle state'
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT * INTO effect_record
        FROM cashu_operator_effects
        WHERE payment_id = reservation_payment_id;
        effect_exists := FOUND;

        SELECT COUNT(*) INTO active_invoice_count
        FROM cashu_active_invoice_payment_claims
        WHERE payment_id = reservation_payment_id;

        IF (latest_state = 'released' AND active_invoice_count <> 0)
          OR (
            latest_state <> 'released'
            AND effect_exists
            AND active_invoice_count <> 1
          )
          OR (
            latest_state <> 'released'
            AND NOT effect_exists
            AND active_invoice_count <> 0
          )
        THEN
          RAISE EXCEPTION 'Cashu active invoice claim does not match lifecycle state'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER cashu_active_proof_claims_valid
        AFTER INSERT OR UPDATE OR DELETE ON cashu_active_proof_claims
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_active_claims();

      CREATE CONSTRAINT TRIGGER cashu_active_invoice_payment_claims_valid
        AFTER INSERT OR UPDATE OR DELETE ON cashu_active_invoice_payment_claims
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_active_claims();

      CREATE CONSTRAINT TRIGGER cashu_operator_effects_active_claims_valid
        AFTER INSERT ON cashu_operator_effects
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_active_claims();

      CREATE CONSTRAINT TRIGGER cashu_proof_reservation_events_active_claims_valid
        AFTER INSERT ON cashu_proof_reservation_events
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_active_claims();

      CREATE CONSTRAINT TRIGGER cashu_reserved_proofs_active_claims_valid
        AFTER INSERT OR UPDATE OR DELETE ON cashu_reserved_proofs
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_active_claims();
    `,
    version: 6,
  }),
  Object.freeze({
    name: "add_encrypted_cashu_proof_custody",
    sql: `
      CREATE TABLE cashu_proof_custody_nonce_uses (
        key_id VARCHAR(128) NOT NULL,
        nonce BYTEA NOT NULL,
        payment_id VARCHAR(128) NOT NULL,
        created_at BIGINT NOT NULL,
        CONSTRAINT cashu_proof_custody_nonce_uses_pkey PRIMARY KEY (key_id, nonce),
        CONSTRAINT cashu_proof_custody_nonce_uses_scope_unique UNIQUE (
          key_id,
          nonce,
          payment_id
        ),
        CONSTRAINT cashu_proof_custody_nonce_uses_key_id CHECK (
          key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_proof_custody_nonce_uses_nonce CHECK (
          OCTET_LENGTH(nonce) = 12
        ),
        CONSTRAINT cashu_proof_custody_nonce_uses_created_at CHECK (
          created_at >= 0 AND created_at <= 9007199254740991
        ),
        CONSTRAINT cashu_proof_custody_nonce_uses_reservation_fkey
          FOREIGN KEY (payment_id)
          REFERENCES cashu_proof_reservations (payment_id)
          ON DELETE RESTRICT
      );

      CREATE TABLE cashu_bearer_proof_custody (
        payment_id VARCHAR(128) PRIMARY KEY,
        binding_fingerprint CHAR(64) NOT NULL,
        record_fingerprint CHAR(64) NOT NULL UNIQUE,
        schema_version SMALLINT NOT NULL,
        encryption_algorithm TEXT NOT NULL,
        key_id VARCHAR(128) NOT NULL,
        nonce BYTEA NOT NULL,
        authentication_tag BYTEA NOT NULL,
        ciphertext BYTEA NOT NULL,
        proof_count SMALLINT NOT NULL,
        created_at BIGINT NOT NULL,
        CONSTRAINT cashu_bearer_proof_custody_binding_fingerprint CHECK (
          binding_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_bearer_proof_custody_record_fingerprint CHECK (
          record_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_bearer_proof_custody_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_bearer_proof_custody_algorithm CHECK (
          encryption_algorithm = 'aes-256-gcm-v1'
        ),
        CONSTRAINT cashu_bearer_proof_custody_key_id CHECK (
          key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_bearer_proof_custody_nonce CHECK (
          OCTET_LENGTH(nonce) = 12
        ),
        CONSTRAINT cashu_bearer_proof_custody_authentication_tag CHECK (
          OCTET_LENGTH(authentication_tag) = 16
        ),
        CONSTRAINT cashu_bearer_proof_custody_ciphertext CHECK (
          OCTET_LENGTH(ciphertext) > 0 AND OCTET_LENGTH(ciphertext) <= 65536
        ),
        CONSTRAINT cashu_bearer_proof_custody_proof_count CHECK (
          proof_count > 0 AND proof_count <= 128
        ),
        CONSTRAINT cashu_bearer_proof_custody_created_at CHECK (
          created_at >= 0 AND created_at <= 9007199254740991
        ),
        CONSTRAINT cashu_bearer_proof_custody_reservation_fkey
          FOREIGN KEY (payment_id)
          REFERENCES cashu_proof_reservations (payment_id)
          ON DELETE RESTRICT,
        CONSTRAINT cashu_bearer_proof_custody_nonce_use_fkey
          FOREIGN KEY (key_id, nonce, payment_id)
          REFERENCES cashu_proof_custody_nonce_uses (key_id, nonce, payment_id)
          ON DELETE RESTRICT
      );

      CREATE FUNCTION cashmesh_reject_cashu_proof_custody_nonce_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Cashu proof custody nonce history is append-only'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE TRIGGER cashu_proof_custody_nonce_uses_append_only
        BEFORE UPDATE OR DELETE ON cashu_proof_custody_nonce_uses
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_cashu_proof_custody_nonce_mutation();

      CREATE FUNCTION cashmesh_validate_cashu_bearer_proof_custody_insert()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        active_proof_count INTEGER;
        effect_count INTEGER;
        invoice_record merchant_invoices%ROWTYPE;
        latest_state TEXT;
        reservation_record cashu_proof_reservations%ROWTYPE;
        reserved_proof_count INTEGER;
      BEGIN
        SELECT * INTO reservation_record
        FROM cashu_proof_reservations
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;

        IF reservation_record.payment_id IS NULL THEN
          RAISE EXCEPTION 'Cashu bearer proof custody requires an existing reservation'
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT * INTO invoice_record
        FROM merchant_invoices
        WHERE id = reservation_record.invoice_id;

        SELECT state INTO latest_state
        FROM cashu_proof_reservation_events
        WHERE payment_id = NEW.payment_id
        ORDER BY sequence DESC
        LIMIT 1;

        SELECT COUNT(*) INTO effect_count
        FROM cashu_operator_effects
        WHERE payment_id = NEW.payment_id;

        SELECT COUNT(*) INTO reserved_proof_count
        FROM cashu_reserved_proofs
        WHERE payment_id = NEW.payment_id;

        SELECT COUNT(*) INTO active_proof_count
        FROM cashu_active_proof_claims
        WHERE payment_id = NEW.payment_id;

        IF invoice_record.id IS NULL
          OR invoice_record.state <> 'open'
          OR NEW.created_at < reservation_record.reserved_at
          OR NEW.created_at < invoice_record.created_at
          OR NEW.created_at >= invoice_record.expires_at
          OR latest_state IS NOT NULL
          OR effect_count <> 0
          OR reserved_proof_count = 0
          OR NEW.proof_count <> reserved_proof_count
          OR active_proof_count <> reserved_proof_count
        THEN
          RAISE EXCEPTION 'Cashu bearer proof custody requires a pre-dispatch active reservation'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_bearer_proof_custody_validate_insert
        BEFORE INSERT ON cashu_bearer_proof_custody
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_bearer_proof_custody_insert();

      CREATE FUNCTION cashmesh_guard_cashu_bearer_proof_custody_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        latest_state TEXT;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'Cashu bearer proof ciphertext is immutable'
            USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;

        SELECT state INTO latest_state
        FROM cashu_proof_reservation_events
        WHERE payment_id = OLD.payment_id
        ORDER BY sequence DESC
        LIMIT 1;

        IF latest_state IS NULL OR latest_state NOT IN ('consumed', 'released') THEN
          RAISE EXCEPTION 'Cashu bearer proof ciphertext requires a terminal lifecycle before deletion'
            USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;

        RETURN OLD;
      END
      $$;

      CREATE TRIGGER cashu_bearer_proof_custody_guard_mutation
        BEFORE UPDATE OR DELETE ON cashu_bearer_proof_custody
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_guard_cashu_bearer_proof_custody_mutation();

      CREATE FUNCTION cashmesh_destroy_terminal_cashu_bearer_proof_custody()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.state IN ('consumed', 'released') THEN
          DELETE FROM cashu_bearer_proof_custody
          WHERE payment_id = NEW.payment_id;
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE TRIGGER cashu_proof_reservation_events_destroy_custody
        AFTER INSERT ON cashu_proof_reservation_events
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_destroy_terminal_cashu_bearer_proof_custody();
    `,
    version: 7,
  }),
  Object.freeze({
    name: "persist_stellar_melt_quote_attempts",
    sql: `
      CREATE TABLE cashu_stellar_melt_quote_attempts (
        attempt_id VARCHAR(128) PRIMARY KEY,
        attempt_fingerprint CHAR(64) NOT NULL UNIQUE,
        payment_id VARCHAR(128) NOT NULL UNIQUE,
        invoice_id VARCHAR(128) NOT NULL,
        operator_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        method TEXT NOT NULL,
        unit VARCHAR(32) NOT NULL,
        amount BIGINT NOT NULL,
        request VARCHAR(4096) NOT NULL,
        schema_version SMALLINT NOT NULL,
        started_at BIGINT NOT NULL,
        CONSTRAINT cashu_stellar_quote_attempts_scope_unique UNIQUE (
          attempt_id,
          payment_id,
          mint_url
        ),
        CONSTRAINT cashu_stellar_quote_attempts_id CHECK (
          attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_stellar_quote_attempts_fingerprint CHECK (
          attempt_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_stellar_quote_attempts_payment_id CHECK (
          payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_stellar_quote_attempts_invoice_id CHECK (
          invoice_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_stellar_quote_attempts_operator_id CHECK (
          operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_stellar_quote_attempts_mint_url CHECK (
          mint_url ~ '^https://[^[:space:]]+$'
        ),
        CONSTRAINT cashu_stellar_quote_attempts_method CHECK (method = 'stellar'),
        CONSTRAINT cashu_stellar_quote_attempts_unit CHECK (unit = 'usdc'),
        CONSTRAINT cashu_stellar_quote_attempts_amount CHECK (
          amount >= 1 AND amount <= 25000
        ),
        CONSTRAINT cashu_stellar_quote_attempts_request CHECK (
          LENGTH(request) >= 1 AND LENGTH(request) <= 4096
        ),
        CONSTRAINT cashu_stellar_quote_attempts_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_stellar_quote_attempts_started_at CHECK (
          started_at >= 0 AND started_at <= 9007199254740991
        ),
        CONSTRAINT cashu_stellar_quote_attempts_reservation_fkey
          FOREIGN KEY (payment_id, invoice_id, operator_id, mint_url)
          REFERENCES cashu_proof_reservations (
            payment_id,
            invoice_id,
            operator_id,
            mint_url
          )
          ON DELETE RESTRICT
      );

      CREATE INDEX cashu_stellar_quote_attempts_invoice_idx
        ON cashu_stellar_melt_quote_attempts (invoice_id, started_at, attempt_id);

      CREATE TABLE cashu_stellar_melt_quote_outcomes (
        attempt_id VARCHAR(128) PRIMARY KEY,
        outcome_fingerprint CHAR(64) NOT NULL UNIQUE,
        payment_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        outcome_kind TEXT NOT NULL,
        ambiguity_reason TEXT,
        quote_id VARCHAR(36),
        fee_reserve BIGINT,
        expiry BIGINT,
        schema_version SMALLINT NOT NULL,
        recorded_at BIGINT NOT NULL,
        CONSTRAINT cashu_stellar_quote_outcomes_scope_unique UNIQUE (
          attempt_id,
          payment_id,
          mint_url,
          quote_id
        ),
        CONSTRAINT cashu_stellar_quote_outcomes_fingerprint CHECK (
          outcome_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_stellar_quote_outcomes_kind CHECK (
          outcome_kind IN ('ambiguous', 'quoted')
        ),
        CONSTRAINT cashu_stellar_quote_outcomes_quote_id CHECK (
          quote_id IS NULL
          OR quote_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
        CONSTRAINT cashu_stellar_quote_outcomes_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_stellar_quote_outcomes_recorded_at CHECK (
          recorded_at >= 0 AND recorded_at <= 9007199254740991
        ),
        CONSTRAINT cashu_stellar_quote_outcomes_shape CHECK (
          (
            outcome_kind = 'ambiguous'
            AND ambiguity_reason = 'transport_ambiguous'
            AND quote_id IS NULL
            AND fee_reserve IS NULL
            AND expiry IS NULL
          )
          OR (
            outcome_kind = 'quoted'
            AND ambiguity_reason IS NULL
            AND quote_id IS NOT NULL
            AND fee_reserve >= 0
            AND fee_reserve <= 9007199254740991
            AND expiry > recorded_at
            AND expiry <= 9007199254740991
          )
        ),
        CONSTRAINT cashu_stellar_quote_outcomes_attempt_fkey
          FOREIGN KEY (attempt_id, payment_id, mint_url)
          REFERENCES cashu_stellar_melt_quote_attempts (attempt_id, payment_id, mint_url)
          ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX cashu_stellar_quote_outcomes_mint_quote_unique
        ON cashu_stellar_melt_quote_outcomes (mint_url, quote_id)
        WHERE outcome_kind = 'quoted';

      CREATE TABLE cashu_stellar_melt_quote_observations (
        snapshot_fingerprint CHAR(64) PRIMARY KEY,
        attempt_id VARCHAR(128) NOT NULL,
        payment_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        quote_id VARCHAR(36) NOT NULL,
        schema_version SMALLINT NOT NULL,
        observed_at BIGINT NOT NULL,
        state TEXT NOT NULL,
        CONSTRAINT cashu_stellar_quote_observations_attempt_time_unique UNIQUE (
          attempt_id,
          observed_at
        ),
        CONSTRAINT cashu_stellar_quote_observations_fingerprint CHECK (
          snapshot_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT cashu_stellar_quote_observations_quote_id CHECK (
          quote_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
        CONSTRAINT cashu_stellar_quote_observations_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_stellar_quote_observations_observed_at CHECK (
          observed_at >= 0 AND observed_at <= 9007199254740991
        ),
        CONSTRAINT cashu_stellar_quote_observations_state CHECK (
          state IN ('UNPAID', 'PENDING', 'PAID')
        ),
        CONSTRAINT cashu_stellar_quote_observations_outcome_fkey
          FOREIGN KEY (attempt_id, payment_id, mint_url, quote_id)
          REFERENCES cashu_stellar_melt_quote_outcomes (
            attempt_id,
            payment_id,
            mint_url,
            quote_id
          )
          ON DELETE RESTRICT
      );

      CREATE INDEX cashu_stellar_quote_observations_latest_idx
        ON cashu_stellar_melt_quote_observations (
          attempt_id,
          observed_at DESC,
          snapshot_fingerprint
        );

      CREATE FUNCTION cashmesh_reject_stellar_quote_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Cashu Stellar melt quote evidence is append-only'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE TRIGGER cashu_stellar_quote_attempts_append_only
        BEFORE UPDATE OR DELETE ON cashu_stellar_melt_quote_attempts
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_stellar_quote_mutation();

      CREATE TRIGGER cashu_stellar_quote_outcomes_append_only
        BEFORE UPDATE OR DELETE ON cashu_stellar_melt_quote_outcomes
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_stellar_quote_mutation();

      CREATE TRIGGER cashu_stellar_quote_observations_append_only
        BEFORE UPDATE OR DELETE ON cashu_stellar_melt_quote_observations
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_stellar_quote_mutation();

      CREATE FUNCTION cashmesh_validate_stellar_quote_attempt()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        active_proof_count INTEGER;
        custody_created_at BIGINT;
        effect_count INTEGER;
        event_count INTEGER;
        invoice_record merchant_invoices%ROWTYPE;
        reservation_record cashu_proof_reservations%ROWTYPE;
        reserved_proof_count INTEGER;
      BEGIN
        SELECT * INTO reservation_record
        FROM cashu_proof_reservations
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;

        SELECT * INTO invoice_record
        FROM merchant_invoices
        WHERE id = NEW.invoice_id;

        SELECT created_at INTO custody_created_at
        FROM cashu_bearer_proof_custody
        WHERE payment_id = NEW.payment_id;

        SELECT COUNT(*) INTO effect_count
        FROM cashu_operator_effects
        WHERE payment_id = NEW.payment_id;

        SELECT COUNT(*) INTO event_count
        FROM cashu_proof_reservation_events
        WHERE payment_id = NEW.payment_id;

        SELECT COUNT(*) INTO reserved_proof_count
        FROM cashu_reserved_proofs
        WHERE payment_id = NEW.payment_id;

        SELECT COUNT(*) INTO active_proof_count
        FROM cashu_active_proof_claims
        WHERE payment_id = NEW.payment_id;

        IF reservation_record.payment_id IS NULL
          OR invoice_record.id IS NULL
          OR reservation_record.invoice_id <> NEW.invoice_id
          OR reservation_record.operator_id <> NEW.operator_id
          OR reservation_record.mint_url <> NEW.mint_url
          OR reservation_record.unit <> NEW.unit
          OR invoice_record.unit <> NEW.unit
          OR invoice_record.amount <> NEW.amount
          OR invoice_record.state <> 'open'
          OR NEW.started_at < reservation_record.reserved_at
          OR NEW.started_at < invoice_record.created_at
          OR NEW.started_at >= invoice_record.expires_at
          OR custody_created_at IS NULL
          OR NEW.started_at < custody_created_at
          OR effect_count <> 0
          OR event_count <> 0
          OR reserved_proof_count = 0
          OR active_proof_count <> reserved_proof_count
        THEN
          RAISE EXCEPTION 'Cashu Stellar quote attempt requires an active custodial reservation'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_stellar_quote_attempts_validate
        BEFORE INSERT ON cashu_stellar_melt_quote_attempts
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_stellar_quote_attempt();

      CREATE FUNCTION cashmesh_validate_stellar_quote_outcome()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        attempt_record cashu_stellar_melt_quote_attempts%ROWTYPE;
        effect_count INTEGER;
        event_count INTEGER;
      BEGIN
        PERFORM payment_id
        FROM cashu_proof_reservations
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;

        SELECT * INTO attempt_record
        FROM cashu_stellar_melt_quote_attempts
        WHERE attempt_id = NEW.attempt_id
        FOR UPDATE;

        SELECT COUNT(*) INTO effect_count
        FROM cashu_operator_effects
        WHERE payment_id = NEW.payment_id;

        SELECT COUNT(*) INTO event_count
        FROM cashu_proof_reservation_events
        WHERE payment_id = NEW.payment_id;

        IF attempt_record.attempt_id IS NULL
          OR NEW.recorded_at < attempt_record.started_at
          OR effect_count <> 0
          OR event_count <> 0
          OR NOT EXISTS (
            SELECT 1
            FROM cashu_bearer_proof_custody
            WHERE payment_id = NEW.payment_id
          )
          OR (
            NEW.outcome_kind = 'quoted'
            AND (
              NEW.expiry > attempt_record.started_at + 900
              OR NEW.fee_reserve > 9007199254740991 - attempt_record.amount
            )
          )
        THEN
          RAISE EXCEPTION 'Cashu Stellar quote outcome violates its pre-dispatch attempt'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_stellar_quote_outcomes_validate
        BEFORE INSERT ON cashu_stellar_melt_quote_outcomes
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_stellar_quote_outcome();

      CREATE FUNCTION cashmesh_validate_stellar_quote_observation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        latest_observation cashu_stellar_melt_quote_observations%ROWTYPE;
        outcome_record cashu_stellar_melt_quote_outcomes%ROWTYPE;
      BEGIN
        SELECT * INTO outcome_record
        FROM cashu_stellar_melt_quote_outcomes
        WHERE attempt_id = NEW.attempt_id
        FOR UPDATE;

        SELECT * INTO latest_observation
        FROM cashu_stellar_melt_quote_observations
        WHERE attempt_id = NEW.attempt_id
        ORDER BY observed_at DESC
        LIMIT 1;

        IF outcome_record.attempt_id IS NULL
          OR outcome_record.outcome_kind <> 'quoted'
          OR outcome_record.payment_id <> NEW.payment_id
          OR outcome_record.mint_url <> NEW.mint_url
          OR outcome_record.quote_id <> NEW.quote_id
          OR NEW.observed_at < outcome_record.recorded_at
          OR (
            latest_observation.attempt_id IS NULL
            AND (
              NEW.observed_at <> outcome_record.recorded_at
              OR NEW.state <> 'UNPAID'
            )
          )
          OR (
            latest_observation.attempt_id IS NOT NULL
            AND (
              NEW.observed_at <= latest_observation.observed_at
              OR (
                latest_observation.state = 'PAID'
                AND NEW.state <> 'PAID'
              )
            )
          )
        THEN
          RAISE EXCEPTION 'Cashu Stellar quote observation transition is invalid'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_stellar_quote_observations_validate
        BEFORE INSERT ON cashu_stellar_melt_quote_observations
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_stellar_quote_observation();

      CREATE FUNCTION cashmesh_require_stellar_quote_observation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        first_observation cashu_stellar_melt_quote_observations%ROWTYPE;
        observation_count INTEGER;
        outcome_record cashu_stellar_melt_quote_outcomes%ROWTYPE;
        requested_attempt_id VARCHAR(128);
      BEGIN
        requested_attempt_id := CASE
          WHEN TG_OP = 'DELETE' THEN OLD.attempt_id
          ELSE NEW.attempt_id
        END;

        SELECT * INTO outcome_record
        FROM cashu_stellar_melt_quote_outcomes
        WHERE attempt_id = requested_attempt_id;

        IF outcome_record.attempt_id IS NULL THEN
          RETURN NULL;
        END IF;

        SELECT COUNT(*) INTO observation_count
        FROM cashu_stellar_melt_quote_observations
        WHERE attempt_id = requested_attempt_id;

        SELECT * INTO first_observation
        FROM cashu_stellar_melt_quote_observations
        WHERE attempt_id = requested_attempt_id
        ORDER BY observed_at
        LIMIT 1;

        IF (
          outcome_record.outcome_kind = 'ambiguous'
          AND observation_count <> 0
        )
        OR (
          outcome_record.outcome_kind = 'quoted'
          AND (
            observation_count = 0
            OR first_observation.observed_at <> outcome_record.recorded_at
            OR first_observation.state <> 'UNPAID'
          )
        )
        THEN
          RAISE EXCEPTION 'Cashu Stellar quote outcome lacks its exact initial observation'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER cashu_stellar_quote_outcomes_observation_required
        AFTER INSERT OR UPDATE OR DELETE ON cashu_stellar_melt_quote_outcomes
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_stellar_quote_observation();

      CREATE CONSTRAINT TRIGGER cashu_stellar_quote_observations_complete
        AFTER INSERT OR UPDATE OR DELETE ON cashu_stellar_melt_quote_observations
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_stellar_quote_observation();
    `,
    version: 8,
  }),
  Object.freeze({
    name: "bind_melt_effects_to_stellar_quotes",
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM cashu_operator_effects AS effect
          LEFT JOIN cashu_stellar_melt_quote_attempts AS attempt
            ON attempt.payment_id = effect.payment_id
          LEFT JOIN cashu_stellar_melt_quote_outcomes AS outcome
            ON outcome.attempt_id = attempt.attempt_id
          LEFT JOIN LATERAL (
            SELECT observation.state
            FROM cashu_stellar_melt_quote_observations AS observation
            WHERE observation.attempt_id = attempt.attempt_id
              AND observation.observed_at <= effect.started_at
            ORDER BY observation.observed_at DESC
            LIMIT 1
          ) AS dispatch ON TRUE
          WHERE effect.effect_kind = 'melt'
            AND (
              attempt.attempt_id IS NULL
              OR attempt.mint_url <> effect.mint_url
              OR outcome.outcome_kind IS DISTINCT FROM 'quoted'
              OR outcome.quote_id IS DISTINCT FROM effect.operator_reference
              OR outcome.expiry IS DISTINCT FROM effect.operator_reference_expires_at
              OR outcome.recorded_at > effect.started_at
              OR dispatch.state IS DISTINCT FROM 'UNPAID'
            )
        ) THEN
          RAISE EXCEPTION 'Melt effect quote binding migration requires an explicit legacy backfill';
        END IF;
      END
      $$;

      CREATE FUNCTION cashmesh_validate_cashu_melt_effect_quote()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        latest_observed_at BIGINT;
        latest_state TEXT;
        quote_expiry BIGINT;
        quote_id VARCHAR(36);
        quote_mint_url VARCHAR(512);
        quote_observed_at BIGINT;
      BEGIN
        IF NEW.effect_kind <> 'melt' THEN
          RETURN NEW;
        END IF;

        SELECT
          attempt.mint_url,
          outcome.quote_id,
          outcome.expiry,
          outcome.recorded_at,
          latest.state,
          latest.observed_at
        INTO
          quote_mint_url,
          quote_id,
          quote_expiry,
          quote_observed_at,
          latest_state,
          latest_observed_at
        FROM cashu_stellar_melt_quote_attempts AS attempt
        JOIN cashu_stellar_melt_quote_outcomes AS outcome
          ON outcome.attempt_id = attempt.attempt_id
          AND outcome.outcome_kind = 'quoted'
        JOIN LATERAL (
          SELECT observation.state, observation.observed_at
          FROM cashu_stellar_melt_quote_observations AS observation
          WHERE observation.attempt_id = attempt.attempt_id
          ORDER BY observation.observed_at DESC
          LIMIT 1
        ) AS latest ON TRUE
        WHERE attempt.payment_id = NEW.payment_id
        FOR UPDATE OF attempt;

        IF NOT FOUND
          OR quote_mint_url <> NEW.mint_url
          OR quote_id IS DISTINCT FROM NEW.operator_reference
          OR quote_expiry IS DISTINCT FROM NEW.operator_reference_expires_at
          OR quote_observed_at > NEW.started_at
          OR latest_observed_at > NEW.started_at
          OR latest_state <> 'UNPAID'
          OR NEW.started_at >= quote_expiry
        THEN
          RAISE EXCEPTION 'Cashu melt effect requires matching dispatchable quote evidence'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_operator_effects_validate_melt_quote
        BEFORE INSERT ON cashu_operator_effects
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_melt_effect_quote();
    `,
    version: 9,
  }),
  Object.freeze({
    name: "account_cashu_invoice_payments",
    sql: `
      LOCK TABLE
        invoice_creation_requests,
        merchant_invoices,
        invoice_cashu_requests,
        invoice_cashu_request_operators,
        cashu_proof_reservations,
        cashu_proof_reservation_events
        IN ACCESS EXCLUSIVE MODE;

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM cashu_proof_reservation_events WHERE state = 'consumed'
        ) THEN
          RAISE EXCEPTION 'Cashu payment accounting migration requires an explicit consumed-payment backfill'
            USING ERRCODE = 'check_violation';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM cashu_proof_reservations AS reservation
          LEFT JOIN LATERAL (
            SELECT event.state
            FROM cashu_proof_reservation_events AS event
            WHERE event.payment_id = reservation.payment_id
            ORDER BY event.sequence DESC
            LIMIT 1
          ) AS latest ON TRUE
          WHERE latest.state IS NULL OR latest.state <> 'released'
        ) THEN
          RAISE EXCEPTION 'Cashu payment accounting migration requires an explicit active-payment route backfill'
            USING ERRCODE = 'check_violation';
        END IF;

        IF EXISTS (SELECT 1 FROM invoice_cashu_requests) THEN
          RAISE EXCEPTION 'Cashu payment accounting migration requires an explicit issued-route backfill'
            USING ERRCODE = 'check_violation';
        END IF;
      END
      $$;

      ALTER TABLE invoice_cashu_requests
        ADD COLUMN operator_count SMALLINT,
        ADD COLUMN route_set_fingerprint CHAR(64) NOT NULL;

      UPDATE invoice_cashu_requests AS request
      SET operator_count = (
        SELECT COUNT(*)
        FROM invoice_cashu_request_operators AS operator
        WHERE operator.invoice_id = request.invoice_id
      );

      SET CONSTRAINTS
        invoice_cashu_requests_operator_required,
        invoice_cashu_requests_invoice_required
        IMMEDIATE;

      ALTER TABLE invoice_cashu_requests
        ALTER COLUMN operator_count SET NOT NULL,
        ADD CONSTRAINT invoice_cashu_requests_operator_count CHECK (
          operator_count >= 1 AND operator_count <= 16
        ),
        ADD CONSTRAINT invoice_cashu_requests_route_set_fingerprint CHECK (
          route_set_fingerprint ~ '^[0-9a-f]{64}$'
        );

      SET CONSTRAINTS
        invoice_cashu_requests_operator_required,
        invoice_cashu_requests_invoice_required
        DEFERRED;

      CREATE OR REPLACE FUNCTION cashmesh_require_cashu_request_operator()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        actual_operator_count INTEGER;
        expected_operator_count INTEGER;
        request_invoice_id VARCHAR(128);
      BEGIN
        IF TG_TABLE_NAME = 'invoice_cashu_requests' THEN
          request_invoice_id := NEW.invoice_id;
        ELSIF TG_OP = 'DELETE' THEN
          request_invoice_id := OLD.invoice_id;
        ELSE
          request_invoice_id := NEW.invoice_id;
        END IF;

        SELECT operator_count INTO expected_operator_count
        FROM invoice_cashu_requests
        WHERE invoice_id = request_invoice_id;

        IF expected_operator_count IS NULL THEN
          RETURN NULL;
        END IF;

        SELECT COUNT(*) INTO actual_operator_count
        FROM invoice_cashu_request_operators
        WHERE invoice_id = request_invoice_id;

        IF actual_operator_count <> expected_operator_count THEN
          RAISE EXCEPTION 'Cashu payment request operator count does not match issuance'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER invoice_cashu_request_operators_count_valid
        AFTER INSERT ON invoice_cashu_request_operators
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_cashu_request_operator();

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM invoice_cashu_requests AS request
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS actual_operator_count
            FROM invoice_cashu_request_operators AS operator
            WHERE operator.invoice_id = request.invoice_id
          ) AS operators ON TRUE
          WHERE request.operator_count <> operators.actual_operator_count
        ) THEN
          RAISE EXCEPTION 'Cashu payment request operator count backfill is inconsistent'
            USING ERRCODE = 'check_violation';
        END IF;
      END
      $$;

      ALTER TABLE merchant_invoices
        DROP CONSTRAINT merchant_invoices_state,
        ADD COLUMN paid_at BIGINT,
        ADD CONSTRAINT merchant_invoices_state CHECK (
          (state = 'open' AND paid_at IS NULL)
          OR (
            state = 'paid'
            AND paid_at >= created_at
            AND paid_at < expires_at
            AND paid_at <= 9007199254740991
          )
        );

      CREATE TABLE merchant_invoice_payment_journals (
        journal_entry_id VARCHAR(128) PRIMARY KEY,
        journal_fingerprint CHAR(64) NOT NULL UNIQUE,
        invoice_id VARCHAR(128) NOT NULL UNIQUE,
        merchant_id VARCHAR(128) NOT NULL,
        payment_id VARCHAR(128) NOT NULL UNIQUE,
        operator_id VARCHAR(128) NOT NULL,
        mint_url VARCHAR(512) NOT NULL,
        settlement_mode TEXT NOT NULL,
        asset_account_kind TEXT NOT NULL,
        asset_account_id VARCHAR(128) NOT NULL,
        schema_version SMALLINT NOT NULL,
        accepted_at BIGINT NOT NULL,
        effective_at BIGINT NOT NULL,
        gross_amount BIGINT NOT NULL,
        fee_amount BIGINT NOT NULL,
        net_amount BIGINT NOT NULL,
        CONSTRAINT merchant_invoice_payment_journals_journal_payment_unique UNIQUE (
          journal_entry_id,
          payment_id
        ),
        CONSTRAINT merchant_invoice_payment_journals_id CHECK (
          journal_entry_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT merchant_invoice_payment_journals_fingerprint CHECK (
          journal_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT merchant_invoice_payment_journals_invoice_id CHECK (
          invoice_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT merchant_invoice_payment_journals_merchant_id CHECK (
          merchant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT merchant_invoice_payment_journals_payment_id CHECK (
          payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT merchant_invoice_payment_journals_operator_id CHECK (
          operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT merchant_invoice_payment_journals_mint_url CHECK (
          mint_url ~ '^https://[^[:space:]]+$'
        ),
        CONSTRAINT merchant_invoice_payment_journals_account CHECK (
          settlement_mode = 'immediate_conversion'
          AND asset_account_kind = 'settlement_asset'
          AND asset_account_id = 'stellar-testnet-usdc-circle'
        ),
        CONSTRAINT merchant_invoice_payment_journals_schema CHECK (schema_version = 1),
        CONSTRAINT merchant_invoice_payment_journals_time CHECK (
          accepted_at >= 0
          AND accepted_at <= effective_at
          AND effective_at <= 9007199254740991
        ),
        CONSTRAINT merchant_invoice_payment_journals_amounts CHECK (
          gross_amount > 0
          AND gross_amount <= 9007199254740991
          AND fee_amount >= 0
          AND fee_amount < gross_amount
          AND net_amount = gross_amount - fee_amount
        ),
        CONSTRAINT merchant_invoice_payment_journals_invoice_fkey
          FOREIGN KEY (invoice_id, merchant_id)
          REFERENCES merchant_invoices (id, merchant_id)
          ON DELETE RESTRICT,
        CONSTRAINT merchant_invoice_payment_journals_reservation_fkey
          FOREIGN KEY (payment_id, invoice_id, operator_id, mint_url)
          REFERENCES cashu_proof_reservations (payment_id, invoice_id, operator_id, mint_url)
          ON DELETE RESTRICT
      );

      CREATE TABLE merchant_invoice_payment_postings (
        journal_entry_id VARCHAR(128) NOT NULL,
        position SMALLINT NOT NULL,
        side TEXT NOT NULL,
        account_kind TEXT NOT NULL,
        account_id VARCHAR(128),
        amount BIGINT NOT NULL,
        CONSTRAINT merchant_invoice_payment_postings_pkey PRIMARY KEY (
          journal_entry_id,
          position
        ),
        CONSTRAINT merchant_invoice_payment_postings_position CHECK (
          position >= 0 AND position < 3
        ),
        CONSTRAINT merchant_invoice_payment_postings_side CHECK (side IN ('debit', 'credit')),
        CONSTRAINT merchant_invoice_payment_postings_account CHECK (
          (
            account_kind IN ('operator_ecash', 'settlement_asset', 'merchant_payable')
            AND account_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
          )
          OR (account_kind = 'fee_revenue' AND account_id IS NULL)
        ),
        CONSTRAINT merchant_invoice_payment_postings_amount CHECK (
          amount > 0 AND amount <= 9007199254740991
        ),
        CONSTRAINT merchant_invoice_payment_postings_journal_fkey
          FOREIGN KEY (journal_entry_id)
          REFERENCES merchant_invoice_payment_journals (journal_entry_id)
          ON DELETE RESTRICT
      );

      ALTER TABLE cashu_proof_reservation_events
        ADD COLUMN journal_entry_id VARCHAR(128),
        ADD CONSTRAINT cashu_proof_reservation_events_accounting_shape CHECK (
          (state = 'consumed' AND journal_entry_id IS NOT NULL)
          OR (state <> 'consumed' AND journal_entry_id IS NULL)
        ),
        ADD CONSTRAINT cashu_proof_reservation_events_journal_fkey
          FOREIGN KEY (journal_entry_id, payment_id)
          REFERENCES merchant_invoice_payment_journals (journal_entry_id, payment_id)
          ON DELETE RESTRICT;

      CREATE FUNCTION cashmesh_reject_issued_cashu_request_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Issued Cashu request state is append-only'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE FUNCTION cashmesh_require_issued_cashu_route_fingerprint()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.route_set_fingerprint IS NULL THEN
          RAISE EXCEPTION 'New Cashu payment requests require an authenticated route set'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER invoice_cashu_requests_route_set_fingerprint_required
        BEFORE INSERT ON invoice_cashu_requests
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_issued_cashu_route_fingerprint();

      CREATE FUNCTION cashmesh_require_accountable_cashu_reservation_route()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        route_fingerprint CHAR(64);
      BEGIN
        SELECT request.route_set_fingerprint INTO route_fingerprint
        FROM invoice_cashu_requests AS request
        WHERE request.invoice_id = NEW.invoice_id;

        IF route_fingerprint IS NULL THEN
          RAISE EXCEPTION 'Cashu proof reservations require an authenticated issued route set'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_proof_reservations_accountable_route_required
        BEFORE INSERT ON cashu_proof_reservations
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_require_accountable_cashu_reservation_route();

      CREATE TRIGGER invoice_cashu_requests_append_only
        BEFORE UPDATE OR DELETE ON invoice_cashu_requests
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_issued_cashu_request_mutation();

      CREATE TRIGGER invoice_cashu_request_operators_append_only
        BEFORE UPDATE OR DELETE ON invoice_cashu_request_operators
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_issued_cashu_request_mutation();

      CREATE FUNCTION cashmesh_guard_merchant_invoice_update()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.id IS DISTINCT FROM NEW.id
          OR OLD.merchant_id IS DISTINCT FROM NEW.merchant_id
          OR OLD.schema_version IS DISTINCT FROM NEW.schema_version
          OR OLD.unit IS DISTINCT FROM NEW.unit
          OR OLD.amount IS DISTINCT FROM NEW.amount
          OR OLD.created_at IS DISTINCT FROM NEW.created_at
          OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
          OR OLD.state <> 'open'
          OR OLD.paid_at IS NOT NULL
          OR NEW.state <> 'paid'
          OR NEW.paid_at IS NULL
        THEN
          RAISE EXCEPTION 'Merchant invoice mutation is not an allowed payment transition'
            USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER merchant_invoices_payment_transition_only
        BEFORE UPDATE ON merchant_invoices
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_guard_merchant_invoice_update();

      CREATE FUNCTION cashmesh_reject_merchant_payment_accounting_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Merchant payment accounting is append-only'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE TRIGGER merchant_invoice_payment_journals_append_only
        BEFORE UPDATE OR DELETE ON merchant_invoice_payment_journals
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_merchant_payment_accounting_mutation();

      CREATE TRIGGER merchant_invoice_payment_postings_append_only
        BEFORE UPDATE OR DELETE ON merchant_invoice_payment_postings
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_merchant_payment_accounting_mutation();

      CREATE FUNCTION cashmesh_validate_merchant_payment_journal()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        asset_debit_count INTEGER;
        credit_total NUMERIC;
        debit_count INTEGER;
        debit_total NUMERIC;
        entry_count INTEGER;
        fee_credit_count INTEGER;
        first_position INTEGER;
        journal_record merchant_invoice_payment_journals%ROWTYPE;
        last_position INTEGER;
        merchant_credit_count INTEGER;
      BEGIN
        SELECT * INTO journal_record
        FROM merchant_invoice_payment_journals
        WHERE journal_entry_id = NEW.journal_entry_id;

        IF journal_record.journal_entry_id IS NULL THEN
          RETURN NULL;
        END IF;

        SELECT
          COUNT(*),
          MIN(position),
          MAX(position),
          COUNT(*) FILTER (WHERE side = 'debit'),
          COALESCE(SUM(amount) FILTER (WHERE side = 'debit'), 0),
          COALESCE(SUM(amount) FILTER (WHERE side = 'credit'), 0),
          COUNT(*) FILTER (
            WHERE side = 'debit'
              AND position = 0
              AND account_kind = journal_record.asset_account_kind
              AND account_id = journal_record.asset_account_id
              AND amount = journal_record.gross_amount
          ),
          COUNT(*) FILTER (
            WHERE side = 'credit'
              AND position = 1
              AND account_kind = 'merchant_payable'
              AND account_id = journal_record.merchant_id
              AND amount = journal_record.net_amount
          ),
          COUNT(*) FILTER (
            WHERE side = 'credit'
              AND position = 2
              AND account_kind = 'fee_revenue'
              AND account_id IS NULL
              AND amount = journal_record.fee_amount
          )
          INTO
            entry_count,
            first_position,
            last_position,
            debit_count,
            debit_total,
            credit_total,
            asset_debit_count,
            merchant_credit_count,
            fee_credit_count
        FROM merchant_invoice_payment_postings
        WHERE journal_entry_id = journal_record.journal_entry_id;

        IF entry_count <> (CASE WHEN journal_record.fee_amount = 0 THEN 2 ELSE 3 END)
          OR first_position <> 0
          OR last_position <> entry_count - 1
          OR debit_count <> 1
          OR debit_total <> journal_record.gross_amount
          OR credit_total <> journal_record.gross_amount
          OR asset_debit_count <> 1
          OR merchant_credit_count <> 1
          OR fee_credit_count <> (CASE WHEN journal_record.fee_amount = 0 THEN 0 ELSE 1 END)
        THEN
          RAISE EXCEPTION 'Merchant payment journal postings are incomplete or unbalanced'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER merchant_invoice_payment_journals_postings_valid
        AFTER INSERT ON merchant_invoice_payment_journals
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_merchant_payment_journal();

      CREATE CONSTRAINT TRIGGER merchant_invoice_payment_postings_journal_valid
        AFTER INSERT ON merchant_invoice_payment_postings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_merchant_payment_journal();

      CREATE FUNCTION cashmesh_validate_cashu_payment_accounting()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        consumed_event cashu_proof_reservation_events%ROWTYPE;
        effect_record cashu_operator_effects%ROWTYPE;
        invoice_record merchant_invoices%ROWTYPE;
        journal_record merchant_invoice_payment_journals%ROWTYPE;
        proof_observed_at BIGINT;
        reservation_record cashu_proof_reservations%ROWTYPE;
        route_fingerprint CHAR(64);
        route_mode TEXT;
        target_invoice_id VARCHAR(128);
      BEGIN
        IF TG_TABLE_NAME = 'cashu_proof_reservation_events' THEN
          IF NEW.state <> 'consumed' THEN
            RETURN NULL;
          END IF;
          SELECT invoice_id INTO target_invoice_id
          FROM cashu_proof_reservations
          WHERE payment_id = NEW.payment_id;
        ELSIF TG_TABLE_NAME = 'merchant_invoice_payment_journals' THEN
          target_invoice_id := NEW.invoice_id;
        ELSE
          IF NEW.state <> 'paid' THEN
            RETURN NULL;
          END IF;
          target_invoice_id := NEW.id;
        END IF;

        SELECT * INTO invoice_record
        FROM merchant_invoices
        WHERE id = target_invoice_id;

        SELECT * INTO journal_record
        FROM merchant_invoice_payment_journals
        WHERE invoice_id = target_invoice_id;

        IF journal_record.journal_entry_id IS NOT NULL THEN
          SELECT * INTO reservation_record
          FROM cashu_proof_reservations
          WHERE payment_id = journal_record.payment_id;

          SELECT * INTO effect_record
          FROM cashu_operator_effects
          WHERE payment_id = journal_record.payment_id;

          SELECT * INTO consumed_event
          FROM cashu_proof_reservation_events
          WHERE payment_id = journal_record.payment_id
            AND state = 'consumed';

          SELECT observed_at INTO proof_observed_at
          FROM cashu_proof_state_observations
          WHERE payment_id = journal_record.payment_id
            AND snapshot_fingerprint = consumed_event.proof_state_snapshot_fingerprint;

          SELECT operator.mode, request.route_set_fingerprint
          INTO route_mode, route_fingerprint
          FROM invoice_cashu_request_operators AS operator
          JOIN invoice_cashu_requests AS request
            ON request.invoice_id = operator.invoice_id
          WHERE operator.invoice_id = journal_record.invoice_id
            AND operator.operator_id = journal_record.operator_id
            AND operator.mint_url = journal_record.mint_url;
        END IF;

        IF invoice_record.id IS NULL
          OR invoice_record.state <> 'paid'
          OR journal_record.journal_entry_id IS NULL
          OR reservation_record.payment_id IS NULL
          OR effect_record.effect_id IS NULL
          OR consumed_event.event_id IS NULL
          OR proof_observed_at IS NULL
          OR route_mode IS NULL
          OR route_fingerprint IS NULL
          OR journal_record.invoice_id <> invoice_record.id
          OR journal_record.merchant_id <> invoice_record.merchant_id
          OR journal_record.gross_amount <> invoice_record.amount
          OR journal_record.accepted_at <> invoice_record.paid_at
          OR journal_record.payment_id <> reservation_record.payment_id
          OR journal_record.invoice_id <> reservation_record.invoice_id
          OR journal_record.operator_id <> reservation_record.operator_id
          OR journal_record.mint_url <> reservation_record.mint_url
          OR journal_record.payment_id <> effect_record.payment_id
          OR journal_record.journal_entry_id <> consumed_event.journal_entry_id
          OR journal_record.payment_id <> consumed_event.payment_id
          OR journal_record.accepted_at <> proof_observed_at
          OR journal_record.effective_at <> consumed_event.recorded_at
          OR journal_record.settlement_mode <> route_mode
          OR consumed_event.evidence_kind <> 'melt_paid'
          OR effect_record.effect_kind <> 'melt'
          OR journal_record.settlement_mode <> 'immediate_conversion'
          OR NOT EXISTS (
            SELECT 1
            FROM cashu_stellar_melt_quote_attempts AS attempt
            JOIN cashu_stellar_melt_quote_outcomes AS outcome
              ON outcome.attempt_id = attempt.attempt_id
              AND outcome.outcome_kind = 'quoted'
              AND outcome.quote_id = effect_record.operator_reference
              AND outcome.expiry = effect_record.operator_reference_expires_at
            JOIN cashu_stellar_melt_quote_observations AS observation
              ON observation.attempt_id = attempt.attempt_id
              AND observation.observed_at = consumed_event.evidence_at
              AND observation.state = 'PAID'
            WHERE attempt.payment_id = journal_record.payment_id
              AND attempt.mint_url = journal_record.mint_url
          )
        THEN
          RAISE EXCEPTION 'Cashu consumption requires its exact paid invoice and journal'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE CONSTRAINT TRIGGER merchant_invoices_cashu_payment_valid
        AFTER INSERT OR UPDATE ON merchant_invoices
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_payment_accounting();

      CREATE CONSTRAINT TRIGGER merchant_invoice_payment_journals_cashu_valid
        AFTER INSERT ON merchant_invoice_payment_journals
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_payment_accounting();

      CREATE CONSTRAINT TRIGGER cashu_consumed_events_accounting_valid
        AFTER INSERT ON cashu_proof_reservation_events
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_cashu_payment_accounting();
    `,
    version: 10,
  }),
  Object.freeze({
    name: "bind_stellar_settlement_destinations",
    sql: `
      LOCK TABLE
        invoice_creation_requests,
        merchant_invoices,
        invoice_cashu_requests,
        invoice_cashu_request_operators,
        cashu_proof_reservations,
        cashu_stellar_melt_quote_attempts
        IN ACCESS EXCLUSIVE MODE;

      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM invoice_cashu_requests) THEN
          RAISE EXCEPTION 'Stellar settlement destination migration requires an explicit issued-route backfill'
            USING ERRCODE = 'check_violation';
        END IF;
      END
      $$;

      ALTER TABLE invoice_cashu_request_operators
        ADD COLUMN settlement_destination VARCHAR(69) NOT NULL,
        ADD CONSTRAINT invoice_cashu_request_operators_settlement_destination CHECK (
          settlement_destination ~ '^(G[A-Z2-7]{55}|M[A-Z2-7]{68})$'
        ),
        ADD CONSTRAINT invoice_cashu_operators_settlement_route_unique UNIQUE (
          invoice_id,
          operator_id,
          mint_url,
          settlement_destination
        );

      ALTER TABLE cashu_stellar_melt_quote_attempts
        ADD COLUMN settlement_destination VARCHAR(69) NOT NULL,
        ADD CONSTRAINT cashu_stellar_quote_attempts_settlement_destination CHECK (
          settlement_destination ~ '^(G[A-Z2-7]{55}|M[A-Z2-7]{68})$'
        ),
        ADD CONSTRAINT cashu_stellar_quote_attempts_settlement_route_fkey
          FOREIGN KEY (
            invoice_id,
            operator_id,
            mint_url,
            settlement_destination
          )
          REFERENCES invoice_cashu_request_operators (
            invoice_id,
            operator_id,
            mint_url,
            settlement_destination
          )
          ON DELETE RESTRICT;

      CREATE FUNCTION cashmesh_validate_stellar_quote_destination()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        route_destination VARCHAR(69);
        route_mode TEXT;
      BEGIN
        SELECT operator.settlement_destination, operator.mode
        INTO route_destination, route_mode
        FROM invoice_cashu_request_operators AS operator
        WHERE operator.invoice_id = NEW.invoice_id
          AND operator.operator_id = NEW.operator_id
          AND operator.mint_url = NEW.mint_url;

        IF NOT FOUND
          OR route_mode <> 'immediate_conversion'
          OR route_destination <> NEW.settlement_destination
        THEN
          RAISE EXCEPTION 'Cashu Stellar melt quote requires its authorized settlement route'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_stellar_quote_attempts_destination_valid
        BEFORE INSERT ON cashu_stellar_melt_quote_attempts
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_stellar_quote_destination();
    `,
    version: 11,
  }),
  Object.freeze({
    name: "serialize_terminal_melt_recovery",
    sql: `
      LOCK TABLE
        cashu_proof_reservations,
        cashu_stellar_melt_quote_observations,
        cashu_proof_state_observations,
        cashu_proof_reservation_events
        IN ACCESS EXCLUSIVE MODE;

      CREATE FUNCTION cashmesh_guard_cashu_observation_append()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        latest_state TEXT;
      BEGIN
        PERFORM payment_id
        FROM cashu_proof_reservations
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Cashu observation requires its reservation'
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT state INTO latest_state
        FROM cashu_proof_reservation_events
        WHERE payment_id = NEW.payment_id
        ORDER BY sequence DESC
        LIMIT 1;

        IF latest_state IN ('consumed', 'released') THEN
          RAISE EXCEPTION 'Cashu observations cannot extend a terminal reservation'
            USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;

        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_stellar_quote_observations_terminal_guard
        BEFORE INSERT ON cashu_stellar_melt_quote_observations
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_guard_cashu_observation_append();

      CREATE TRIGGER cashu_proof_state_observations_terminal_guard
        BEFORE INSERT ON cashu_proof_state_observations
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_guard_cashu_observation_append();

      CREATE FUNCTION cashmesh_validate_latest_melt_release_evidence()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        effect_record cashu_operator_effects%ROWTYPE;
        latest_proof_fingerprint CHAR(64);
        latest_proof_observed_at BIGINT;
        latest_quote_expiry BIGINT;
        latest_quote_id VARCHAR(36);
        latest_quote_observed_at BIGINT;
        latest_quote_state TEXT;
      BEGIN
        IF NEW.state <> 'released' OR NEW.evidence_kind <> 'melt_unpaid_after_expiry' THEN
          RETURN NEW;
        END IF;

        PERFORM payment_id
        FROM cashu_proof_reservations
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;

        SELECT * INTO effect_record
        FROM cashu_operator_effects
        WHERE effect_id = NEW.effect_id
          AND payment_id = NEW.payment_id;

        SELECT observation.state, observation.observed_at, observation.quote_id, outcome.expiry
          INTO latest_quote_state, latest_quote_observed_at, latest_quote_id, latest_quote_expiry
        FROM cashu_stellar_melt_quote_observations AS observation
        JOIN cashu_stellar_melt_quote_outcomes AS outcome
          ON outcome.attempt_id = observation.attempt_id
          AND outcome.payment_id = observation.payment_id
          AND outcome.mint_url = observation.mint_url
          AND outcome.quote_id = observation.quote_id
        WHERE observation.payment_id = NEW.payment_id
        ORDER BY observation.observed_at DESC
        LIMIT 1;

        SELECT snapshot_fingerprint, observed_at
          INTO latest_proof_fingerprint, latest_proof_observed_at
        FROM cashu_proof_state_observations
        WHERE payment_id = NEW.payment_id
        ORDER BY observed_at DESC
        LIMIT 1;

        IF effect_record.effect_id IS NULL
          OR effect_record.effect_kind <> 'melt'
          OR latest_quote_state IS DISTINCT FROM 'UNPAID'
          OR latest_quote_observed_at IS DISTINCT FROM NEW.evidence_at
          OR latest_quote_id IS DISTINCT FROM effect_record.operator_reference
          OR latest_quote_expiry IS DISTINCT FROM effect_record.operator_reference_expires_at
          OR latest_proof_fingerprint IS DISTINCT FROM NEW.proof_state_snapshot_fingerprint
          OR latest_proof_observed_at < NEW.evidence_at
          OR latest_proof_observed_at > NEW.recorded_at
        THEN
          RAISE EXCEPTION 'Cashu melt release requires the latest failure evidence pair'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_proof_reservation_events_latest_melt_release
        BEFORE INSERT ON cashu_proof_reservation_events
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_latest_melt_release_evidence();
    `,
    version: 12,
  }),
  Object.freeze({
    name: "schedule_stellar_melt_recovery",
    sql: `
      LOCK TABLE
        cashu_proof_reservations,
        cashu_operator_effects,
        cashu_proof_reservation_events
        IN ACCESS EXCLUSIVE MODE;

      CREATE TABLE cashu_stellar_melt_recovery_jobs (
        payment_id VARCHAR(128) PRIMARY KEY,
        effect_id VARCHAR(128) NOT NULL UNIQUE,
        schema_version SMALLINT NOT NULL,
        initial_attempt_at BIGINT NOT NULL,
        CONSTRAINT cashu_stellar_melt_recovery_jobs_payment_id CHECK (
          payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_stellar_melt_recovery_jobs_effect_id CHECK (
          effect_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_stellar_melt_recovery_jobs_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_stellar_melt_recovery_jobs_initial_attempt_at CHECK (
          initial_attempt_at >= 0 AND initial_attempt_at <= 9007199254740991
        ),
        CONSTRAINT cashu_stellar_melt_recovery_jobs_effect_fkey
          FOREIGN KEY (effect_id, payment_id)
          REFERENCES cashu_operator_effects (effect_id, payment_id)
          ON DELETE RESTRICT
      );

      CREATE TABLE cashu_stellar_melt_recovery_leases (
        lease_token VARCHAR(128) PRIMARY KEY,
        payment_id VARCHAR(128) NOT NULL,
        attempt_number SMALLINT NOT NULL,
        worker_id VARCHAR(128) NOT NULL,
        schema_version SMALLINT NOT NULL,
        claimed_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        CONSTRAINT cashu_stellar_melt_recovery_leases_scope_unique UNIQUE (
          lease_token,
          payment_id
        ),
        CONSTRAINT cashu_stellar_melt_recovery_leases_attempt_unique UNIQUE (
          payment_id,
          attempt_number
        ),
        CONSTRAINT cashu_stellar_melt_recovery_leases_token CHECK (
          lease_token ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_stellar_melt_recovery_leases_worker CHECK (
          worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
        CONSTRAINT cashu_stellar_melt_recovery_leases_attempt CHECK (
          attempt_number > 0 AND attempt_number <= 1024
        ),
        CONSTRAINT cashu_stellar_melt_recovery_leases_schema CHECK (schema_version = 1),
        CONSTRAINT cashu_stellar_melt_recovery_leases_claimed_at CHECK (
          claimed_at >= 0 AND claimed_at <= 9007199254740991
        ),
        CONSTRAINT cashu_stellar_melt_recovery_leases_expires_at CHECK (
          expires_at > claimed_at
          AND expires_at <= 9007199254740991
          AND expires_at - claimed_at <= 300
        ),
        CONSTRAINT cashu_stellar_melt_recovery_leases_job_fkey
          FOREIGN KEY (payment_id)
          REFERENCES cashu_stellar_melt_recovery_jobs (payment_id)
          ON DELETE RESTRICT
      );

      CREATE INDEX cashu_stellar_melt_recovery_leases_latest_idx
        ON cashu_stellar_melt_recovery_leases (payment_id, attempt_number DESC);

      CREATE TABLE cashu_stellar_melt_recovery_outcomes (
        lease_token VARCHAR(128) PRIMARY KEY,
        payment_id VARCHAR(128) NOT NULL,
        outcome_kind TEXT NOT NULL,
        reason TEXT,
        recorded_at BIGINT NOT NULL,
        next_attempt_at BIGINT,
        CONSTRAINT cashu_stellar_melt_recovery_outcomes_kind CHECK (
          outcome_kind IN ('accepted', 'released', 'retry_scheduled', 'attention_required')
        ),
        CONSTRAINT cashu_stellar_melt_recovery_outcomes_recorded_at CHECK (
          recorded_at >= 0 AND recorded_at <= 9007199254740991
        ),
        CONSTRAINT cashu_stellar_melt_recovery_outcomes_next_attempt_at CHECK (
          next_attempt_at IS NULL
          OR (next_attempt_at > recorded_at AND next_attempt_at <= 9007199254740991)
        ),
        CONSTRAINT cashu_stellar_melt_recovery_outcomes_shape CHECK (
          (
            outcome_kind IN ('accepted', 'released')
            AND reason IS NULL
            AND next_attempt_at IS NULL
          )
          OR (
            outcome_kind = 'retry_scheduled'
            AND reason IN (
              'nonterminal_evidence',
              'operator_state_unknown',
              'storage_unavailable',
              'worker_aborted'
            )
            AND next_attempt_at IS NOT NULL
          )
          OR (
            outcome_kind = 'attention_required'
            AND reason IN (
              'evidence_invalid',
              'operator_response_invalid',
              'recovery_configuration_invalid',
              'retry_exhausted'
            )
            AND next_attempt_at IS NULL
          )
        ),
        CONSTRAINT cashu_stellar_melt_recovery_outcomes_lease_fkey
          FOREIGN KEY (lease_token, payment_id)
          REFERENCES cashu_stellar_melt_recovery_leases (lease_token, payment_id)
          ON DELETE RESTRICT
      );

      CREATE FUNCTION cashmesh_validate_stellar_melt_recovery_job()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        effect_record cashu_operator_effects%ROWTYPE;
      BEGIN
        SELECT * INTO effect_record
        FROM cashu_operator_effects
        WHERE effect_id = NEW.effect_id
          AND payment_id = NEW.payment_id;

        IF NOT FOUND
          OR effect_record.effect_kind <> 'melt'
          OR NEW.initial_attempt_at <> LEAST(
            9007199254740991::BIGINT,
            effect_record.started_at + 60
          )
        THEN
          RAISE EXCEPTION 'Cashu Stellar melt recovery job does not match its effect'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_stellar_melt_recovery_jobs_valid
        BEFORE INSERT ON cashu_stellar_melt_recovery_jobs
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_stellar_melt_recovery_job();

      INSERT INTO cashu_stellar_melt_recovery_jobs (
        payment_id,
        effect_id,
        schema_version,
        initial_attempt_at
      )
      SELECT
        effect.payment_id,
        effect.effect_id,
        1,
        LEAST(9007199254740991::BIGINT, effect.started_at + 60)
      FROM cashu_operator_effects AS effect
      WHERE effect.effect_kind = 'melt';

      CREATE FUNCTION cashmesh_schedule_stellar_melt_recovery()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.effect_kind = 'melt' THEN
          INSERT INTO cashu_stellar_melt_recovery_jobs (
            payment_id,
            effect_id,
            schema_version,
            initial_attempt_at
          )
          VALUES (
            NEW.payment_id,
            NEW.effect_id,
            1,
            LEAST(9007199254740991::BIGINT, NEW.started_at + 60)
          );
        END IF;
        RETURN NULL;
      END
      $$;

      CREATE TRIGGER cashu_operator_effects_schedule_stellar_melt_recovery
        AFTER INSERT ON cashu_operator_effects
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_schedule_stellar_melt_recovery();

      CREATE FUNCTION cashmesh_lock_stellar_melt_recovery_for_lifecycle_event()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM payment_id
        FROM cashu_proof_reservations
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;

        PERFORM payment_id
        FROM cashu_stellar_melt_recovery_jobs
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_proof_reservation_events_lock_stellar_melt_recovery
        BEFORE INSERT ON cashu_proof_reservation_events
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_lock_stellar_melt_recovery_for_lifecycle_event();

      CREATE FUNCTION cashmesh_validate_stellar_melt_recovery_lease()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        eligible_at BIGINT;
        job_record cashu_stellar_melt_recovery_jobs%ROWTYPE;
        latest_lease cashu_stellar_melt_recovery_leases%ROWTYPE;
        latest_outcome cashu_stellar_melt_recovery_outcomes%ROWTYPE;
        lifecycle_state TEXT;
      BEGIN
        SELECT * INTO job_record
        FROM cashu_stellar_melt_recovery_jobs
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;

        SELECT state INTO lifecycle_state
        FROM cashu_proof_reservation_events
        WHERE payment_id = NEW.payment_id
        ORDER BY sequence DESC
        LIMIT 1;

        IF job_record.payment_id IS NULL
          OR lifecycle_state IS NULL
          OR lifecycle_state IN ('consumed', 'released')
        THEN
          RAISE EXCEPTION 'Cashu Stellar melt recovery job is not active'
            USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;

        SELECT * INTO latest_lease
        FROM cashu_stellar_melt_recovery_leases
        WHERE payment_id = NEW.payment_id
        ORDER BY attempt_number DESC
        LIMIT 1;

        IF latest_lease.lease_token IS NULL THEN
          eligible_at := job_record.initial_attempt_at;
          IF NEW.attempt_number <> 1 THEN
            RAISE EXCEPTION 'Cashu Stellar melt recovery lease sequence is invalid'
              USING ERRCODE = 'check_violation';
          END IF;
        ELSE
          IF NEW.attempt_number <> latest_lease.attempt_number + 1 THEN
            RAISE EXCEPTION 'Cashu Stellar melt recovery lease sequence is invalid'
              USING ERRCODE = 'check_violation';
          END IF;

          SELECT * INTO latest_outcome
          FROM cashu_stellar_melt_recovery_outcomes
          WHERE lease_token = latest_lease.lease_token;

          IF latest_outcome.lease_token IS NULL THEN
            eligible_at := latest_lease.expires_at;
          ELSIF latest_outcome.outcome_kind = 'retry_scheduled' THEN
            eligible_at := latest_outcome.next_attempt_at;
          ELSE
            RAISE EXCEPTION 'Cashu Stellar melt recovery job is not retryable'
              USING ERRCODE = 'object_not_in_prerequisite_state';
          END IF;
        END IF;

        IF eligible_at IS NULL OR NEW.claimed_at < eligible_at THEN
          RAISE EXCEPTION 'Cashu Stellar melt recovery lease is not yet eligible'
            USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_stellar_melt_recovery_leases_valid
        BEFORE INSERT ON cashu_stellar_melt_recovery_leases
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_stellar_melt_recovery_lease();

      CREATE FUNCTION cashmesh_validate_stellar_melt_recovery_outcome()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        latest_lease cashu_stellar_melt_recovery_leases%ROWTYPE;
        lifecycle_state TEXT;
      BEGIN
        PERFORM payment_id
        FROM cashu_stellar_melt_recovery_jobs
        WHERE payment_id = NEW.payment_id
        FOR UPDATE;

        SELECT * INTO latest_lease
        FROM cashu_stellar_melt_recovery_leases
        WHERE payment_id = NEW.payment_id
        ORDER BY attempt_number DESC
        LIMIT 1;

        SELECT state INTO lifecycle_state
        FROM cashu_proof_reservation_events
        WHERE payment_id = NEW.payment_id
        ORDER BY sequence DESC
        LIMIT 1;

        IF latest_lease.lease_token IS DISTINCT FROM NEW.lease_token
          OR NEW.recorded_at < latest_lease.claimed_at
          OR NEW.recorded_at > latest_lease.expires_at
          OR (
            NEW.outcome_kind = 'accepted'
            AND lifecycle_state IS DISTINCT FROM 'consumed'
          )
          OR (
            NEW.outcome_kind = 'released'
            AND lifecycle_state IS DISTINCT FROM 'released'
          )
          OR (
            NEW.outcome_kind IN ('retry_scheduled', 'attention_required')
            AND (
              lifecycle_state IS NULL
              OR lifecycle_state NOT IN ('dispatch_started', 'pending', 'needs_attention')
            )
          )
        THEN
          RAISE EXCEPTION 'Cashu Stellar melt recovery lease is no longer current'
            USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER cashu_stellar_melt_recovery_outcomes_valid
        BEFORE INSERT ON cashu_stellar_melt_recovery_outcomes
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_validate_stellar_melt_recovery_outcome();

      CREATE FUNCTION cashmesh_reject_stellar_melt_recovery_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Cashu Stellar melt recovery scheduling history is append-only'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END
      $$;

      CREATE TRIGGER cashu_stellar_melt_recovery_jobs_append_only
        BEFORE UPDATE OR DELETE ON cashu_stellar_melt_recovery_jobs
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_stellar_melt_recovery_mutation();

      CREATE TRIGGER cashu_stellar_melt_recovery_leases_append_only
        BEFORE UPDATE OR DELETE ON cashu_stellar_melt_recovery_leases
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_stellar_melt_recovery_mutation();

      CREATE TRIGGER cashu_stellar_melt_recovery_outcomes_append_only
        BEFORE UPDATE OR DELETE ON cashu_stellar_melt_recovery_outcomes
        FOR EACH ROW
        EXECUTE FUNCTION cashmesh_reject_stellar_melt_recovery_mutation();
    `,
    version: 13,
  }),
]);

export async function applyPostgresMigrations(
  client: PoolClient,
  options: { readonly targetVersion?: number } = {},
): Promise<void> {
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
  const latestVersion = MIGRATIONS.at(-1)?.version;
  const targetVersion = options.targetVersion ?? latestVersion;
  if (
    latestVersion === undefined ||
    !Number.isSafeInteger(targetVersion) ||
    targetVersion === undefined ||
    !knownByVersion.has(targetVersion)
  ) {
    throw new Error("PostgreSQL migration target is not supported by this build.");
  }

  for (const row of applied.rows) {
    const migration = knownByVersion.get(row.version);
    if (migration === undefined || migration.name !== row.name) {
      throw new Error(
        `Database migration ${row.version}:${row.name} is not supported by this build.`,
      );
    }
    if (row.version > targetVersion) {
      throw new Error(`Database migration ${row.version} is newer than target ${targetVersion}.`);
    }
  }

  const appliedVersions = new Set(applied.rows.map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (migration.version > targetVersion) {
      break;
    }
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

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

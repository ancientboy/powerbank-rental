-- PostgreSQL reference schema: NOT DEPLOYED; NOT a migration used by this demo.
-- Requires review, approved business rules, migration implementation and real integration tests.
-- UUIDs supplied by application. All dates UTC timestamptz. No destructive reset statements.
-- JSON snapshots are intentional immutable evidence, not replacements for entity relations.
-- IMPORTANT outstanding cross-row invariants: transactionally lock user_rental_guards;
-- validate active_count against approved limit; lock original money operation before summing
-- pending/succeeded refunds/captures; enforce currency and rental consistency across intents;
-- validate state transitions, trusted evidence, timezone names and immutable asset identities.
-- Partial unique indexes below enforce only the explicitly represented allocation predicates.
BEGIN;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('ACTIVE','DISABLED','DELETED')),
  preferred_locale text NOT NULL DEFAULT 'en',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE auth_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_subject text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  profile_snapshot jsonb NOT NULL DEFAULT '{}',
  UNIQUE(provider,provider_subject),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  device_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE consent_records (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  document_type text NOT NULL,
  version text NOT NULL,
  accepted_at timestamptz NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE stations (
  id uuid PRIMARY KEY,
  public_code text NOT NULL UNIQUE,
  name text NOT NULL,
  address text NOT NULL,
  lat numeric(8,5) CHECK(lat BETWEEN -90 AND 90),
  lng numeric(8,5) CHECK(lng BETWEEN -180 AND 180),
  timezone text NOT NULL,
  opening_hours jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('ONLINE','OFFLINE','PAUSED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE cabinets (
  id uuid PRIMARY KEY,
  station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_cabinet_id text NOT NULL,
  firmware_version text,
  status text NOT NULL,
  last_seen_at timestamptz,
  UNIQUE(provider,provider_cabinet_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE powerbanks (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_bank_id text NOT NULL,
  status text NOT NULL,
  last_slot_id uuid,
  last_seen_at timestamptz,
  UNIQUE(provider,provider_bank_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE slots (
  id uuid PRIMARY KEY,
  cabinet_id uuid NOT NULL REFERENCES cabinets(id) ON DELETE RESTRICT,
  provider_slot_id text NOT NULL,
  status text NOT NULL,
  observed_powerbank_id uuid REFERENCES powerbanks(id) ON DELETE RESTRICT,
  observed_at timestamptz,
  UNIQUE(cabinet_id,provider_slot_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE inventory_observations (
  id uuid PRIMARY KEY,
  cabinet_id uuid NOT NULL REFERENCES cabinets(id) ON DELETE RESTRICT,
  source_event_id uuid,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE qr_codes (
  id uuid PRIMARY KEY,
  public_token_hash text NOT NULL UNIQUE,
  cabinet_id uuid NOT NULL REFERENCES cabinets(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK(version>0),
  status text NOT NULL CHECK(status IN ('ACTIVE','REVOKED','EXPIRED')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE pricing_versions (
  id uuid PRIMARY KEY,
  version text NOT NULL UNIQUE,
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  rules_json jsonb NOT NULL,
  effective_from timestamptz,
  approval_ref text,
  status text NOT NULL CHECK(status IN ('DRAFT','APPROVED','ACTIVE','RETIRED')),
  CHECK(status NOT IN ('APPROVED','ACTIVE') OR approval_ref IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cabinet_id uuid NOT NULL REFERENCES cabinets(id) ON DELETE RESTRICT,
  pricing_version_id uuid NOT NULL REFERENCES pricing_versions(id) ON DELETE RESTRICT,
  price_snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  UNIQUE(id,user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE rentals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL UNIQUE,
  powerbank_id uuid NOT NULL REFERENCES powerbanks(id) ON DELETE RESTRICT,
  origin_cabinet_id uuid NOT NULL REFERENCES cabinets(id) ON DELETE RESTRICT,
  return_cabinet_id uuid REFERENCES cabinets(id) ON DELETE RESTRICT,
  physical_status text NOT NULL CHECK(physical_status IN ('AWAITING_FUNDS','PREPARING','DISPENSE_UNKNOWN','ACTIVE','OVERDUE','RETURNED','NOT_DISPENSED','CANCELLED','EXPIRED','REVIEW_REQUIRED')),
  financial_status text NOT NULL CHECK(financial_status IN ('PENDING','SETTLED','REVIEW_REQUIRED')),
  started_at timestamptz,
  ended_at timestamptz,
  price_snapshot jsonb NOT NULL,
  FOREIGN KEY(quote_id,user_id) REFERENCES quotes(id,user_id) ON DELETE RESTRICT,
  CHECK(ended_at IS NULL OR (started_at IS NOT NULL AND ended_at>=started_at)),
  UNIQUE(id,powerbank_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  rental_id uuid NOT NULL UNIQUE,
  powerbank_id uuid NOT NULL REFERENCES powerbanks(id) ON DELETE RESTRICT,
  origin_slot_id uuid NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
  asset_status text NOT NULL CHECK(asset_status IN ('HELD','QUARANTINED','CONSUMED','RELEASED')),
  slot_lock_status text NOT NULL CHECK(slot_lock_status IN ('LOCKED','QUARANTINED','RELEASED')),
  expires_at timestamptz NOT NULL,
  quarantine_reason text,
  FOREIGN KEY(rental_id,powerbank_id) REFERENCES rentals(id,powerbank_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE user_rental_guards (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  active_count integer NOT NULL CHECK(active_count>=0),
  limit_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE payment_intents (
  id uuid PRIMARY KEY,
  rental_id uuid NOT NULL REFERENCES rentals(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  merchant_account_id text NOT NULL,
  instrument_type text NOT NULL,
  funding_mode text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  status text NOT NULL,
  provider_ref text,
  UNIQUE(provider,merchant_account_id,provider_ref),
  UNIQUE(id,currency),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE payment_operations (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL,
  provider text NOT NULL,
  merchant_account_id text NOT NULL,
  merchant_operation_id text NOT NULL,
  operation_type text NOT NULL CHECK(operation_type IN ('AUTHORIZE','CAPTURE','RELEASE','CHARGE','REFUND')),
  idempotency_key text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK(status IN ('CREATED','PENDING','UNKNOWN','SUCCEEDED','FAILED','CANCELLED')),
  provider_operation_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_query_at timestamptz,
  FOREIGN KEY(intent_id,currency) REFERENCES payment_intents(id,currency) ON DELETE RESTRICT,
  UNIQUE(provider,merchant_account_id,merchant_operation_id),
  UNIQUE(provider,merchant_account_id,idempotency_key),
  UNIQUE(provider,merchant_account_id,provider_operation_id),
  UNIQUE(id,currency),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY,
  rental_id uuid NOT NULL REFERENCES rentals(id) ON DELETE RESTRICT,
  original_operation_id uuid NOT NULL,
  refund_operation_id uuid UNIQUE REFERENCES payment_operations(id) ON DELETE RESTRICT,
  requested_minor bigint NOT NULL CHECK(requested_minor>=0),
  currency char(3) NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  provider_ref text,
  FOREIGN KEY(original_operation_id,currency) REFERENCES payment_operations(id,currency) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE billing_statements (
  id uuid PRIMARY KEY,
  rental_id uuid NOT NULL REFERENCES rentals(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK(version>0),
  duration_seconds bigint NOT NULL CHECK(duration_seconds>=0),
  rule_snapshot jsonb NOT NULL,
  fee_minor bigint NOT NULL CHECK(fee_minor>=0),
  deposit_minor bigint NOT NULL CHECK(deposit_minor>=0),
  adjustment_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  finalized_at timestamptz NOT NULL,
  UNIQUE(rental_id,version),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY,
  rental_id uuid NOT NULL REFERENCES rentals(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  entry_type text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  currency char(3) NOT NULL,
  effective_at timestamptz NOT NULL,
  reversal_of uuid REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  FOREIGN KEY(operation_id,currency) REFERENCES payment_operations(id,currency) ON DELETE RESTRICT,
  UNIQUE(operation_id,entry_type),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE device_commands (
  id uuid PRIMARY KEY,
  rental_id uuid NOT NULL REFERENCES rentals(id) ON DELETE RESTRICT,
  cabinet_id uuid NOT NULL REFERENCES cabinets(id) ON DELETE RESTRICT,
  powerbank_id uuid NOT NULL REFERENCES powerbanks(id) ON DELETE RESTRICT,
  command_type text NOT NULL,
  provider_command_id text,
  status text NOT NULL CHECK(status IN ('CREATED','SENT','ACKNOWLEDGED','UNKNOWN','SUCCEEDED','FAILED')),
  sent_at timestamptz,
  ack_at timestamptz,
  resolved_at timestamptz,
  UNIQUE(cabinet_id,provider_command_id),
  UNIQUE(rental_id,command_type),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE device_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_namespace text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  cabinet_id uuid REFERENCES cabinets(id) ON DELETE RESTRICT,
  powerbank_id uuid REFERENCES powerbanks(id) ON DELETE RESTRICT,
  sequence bigint CHECK(sequence>=0),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  verification_status text NOT NULL CHECK(verification_status IN ('PENDING','VERIFIED','REJECTED','REVIEW_REQUIRED')),
  payload_ref text NOT NULL,
  UNIQUE(provider,provider_namespace,provider_event_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE return_evidence (
  id uuid PRIMARY KEY,
  rental_id uuid NOT NULL,
  device_event_id uuid REFERENCES device_events(id) ON DELETE RESTRICT,
  powerbank_id uuid NOT NULL,
  trusted_return_at timestamptz,
  confidence text NOT NULL,
  review_status text NOT NULL,
  manual_audit_id uuid,
  FOREIGN KEY(rental_id,powerbank_id) REFERENCES rentals(id,powerbank_id) ON DELETE RESTRICT,
  CHECK(device_event_id IS NOT NULL OR manual_audit_id IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE inbox_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_namespace text NOT NULL,
  external_event_id text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL,
  processing_status text NOT NULL CHECK(processing_status IN ('PENDING','PROCESSING','DONE','REVIEW_REQUIRED','REJECTED')),
  processed_at timestamptz,
  UNIQUE(provider,provider_namespace,external_event_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  aggregate_id uuid NOT NULL,
  type text NOT NULL,
  payload_version integer NOT NULL CHECK(payload_version>0),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('PENDING','CLAIMED','DONE','FAILED','UNKNOWN')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at timestamptz NOT NULL,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE idempotency_records (
  scope text NOT NULL,
  key text NOT NULL,
  actor_id uuid NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  response_ref text,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(scope,actor_id,key),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL,
  source_ref text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}',
  CHECK(period_end>period_start),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE support_cases (
  id uuid PRIMARY KEY,
  rental_id uuid REFERENCES rentals(id) ON DELETE RESTRICT,
  category text NOT NULL,
  status text NOT NULL CHECK(status IN ('OPEN','REVIEW_REQUIRED','RESOLVED')),
  assignee uuid,
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE reconciliation_items (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  operation_id uuid REFERENCES payment_operations(id) ON DELETE RESTRICT,
  provider_ref text,
  expected_minor bigint CHECK(expected_minor>=0),
  actual_minor bigint CHECK(actual_minor>=0),
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  difference_type text NOT NULL,
  case_id uuid REFERENCES support_cases(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE admin_users_roles (
  admin_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL,
  status text NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
  auth_subject text NOT NULL,
  granted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY(admin_id,role),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_ref text,
  after_ref text,
  reason text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0 CHECK(row_version>=0)
);

ALTER TABLE powerbanks ADD CONSTRAINT bank_last_slot_fk FOREIGN KEY(last_slot_id) REFERENCES slots(id) ON DELETE RESTRICT;
ALTER TABLE inventory_observations ADD CONSTRAINT observation_event_fk FOREIGN KEY(source_event_id) REFERENCES device_events(id) ON DELETE RESTRICT;
ALTER TABLE return_evidence ADD CONSTRAINT manual_return_audit_fk FOREIGN KEY(manual_audit_id) REFERENCES audit_logs(id) ON DELETE RESTRICT;
ALTER TABLE support_cases ADD CONSTRAINT case_assignee_fk FOREIGN KEY(assignee) REFERENCES users(id) ON DELETE RESTRICT;
-- A retained physical bank allocation is different from its former slot lock.
CREATE UNIQUE INDEX reservation_active_bank ON reservations(powerbank_id) WHERE asset_status IN ('HELD','QUARANTINED','CONSUMED');
CREATE UNIQUE INDEX reservation_locked_slot ON reservations(origin_slot_id) WHERE slot_lock_status IN ('LOCKED','QUARANTINED');
CREATE UNIQUE INDEX rental_active_bank ON rentals(powerbank_id) WHERE physical_status IN ('AWAITING_FUNDS','PREPARING','DISPENSE_UNKNOWN','ACTIVE','OVERDUE');
-- One-user-active-rental is a proposed MVP rule, requiring D08 approval before deployment.
CREATE UNIQUE INDEX rental_one_active_user ON rentals(user_id) WHERE physical_status IN ('AWAITING_FUNDS','PREPARING','DISPENSE_UNKNOWN','ACTIVE','OVERDUE');
CREATE INDEX sessions_expiry ON sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX identities_user ON auth_identities(user_id);
CREATE INDEX cabinets_station ON cabinets(station_id);
CREATE INDEX inventory_freshness ON inventory_observations(cabinet_id,observed_at DESC);
CREATE INDEX quotes_user_expiry ON quotes(user_id,expires_at);
CREATE INDEX rentals_user_history ON rentals(user_id,created_at DESC,id);
CREATE INDEX rentals_status ON rentals(physical_status,financial_status);
CREATE INDEX intent_rental ON payment_intents(rental_id);
CREATE INDEX operation_query ON payment_operations(next_query_at) WHERE status IN ('PENDING','UNKNOWN');
CREATE INDEX refunds_original ON refunds(original_operation_id,status);
CREATE INDEX ledger_rental ON ledger_entries(rental_id,effective_at);
CREATE INDEX command_rental ON device_commands(rental_id,status);
CREATE INDEX event_bank_timeline ON device_events(powerbank_id,occurred_at);
CREATE INDEX evidence_rental ON return_evidence(rental_id);
CREATE INDEX inbox_work ON inbox_events(processing_status,received_at);
CREATE INDEX outbox_work ON outbox_events(next_attempt_at,lease_until) WHERE status IN ('PENDING','CLAIMED','UNKNOWN');
CREATE INDEX idempotency_expiry ON idempotency_records(expires_at);
CREATE INDEX reconciliation_run_items ON reconciliation_items(run_id);
CREATE INDEX support_rental ON support_cases(rental_id,status);
CREATE INDEX audit_target ON audit_logs(target_type,target_id,created_at);
-- SQL provides structural constraints, not a completed financial/state-transition service.
-- Ordinary runtime roles must have no direct UPDATE/DELETE rights on evidence/ledger/audit.
CREATE FUNCTION reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Append-only evidence: append a correction instead'; END;
$$;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation();
CREATE TRIGGER billing_append_only BEFORE UPDATE OR DELETE ON billing_statements FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation();
CREATE TRIGGER consent_append_only BEFORE UPDATE OR DELETE ON consent_records FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation();
CREATE FUNCTION protect_published_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('APPROVED','ACTIVE','RETIRED') THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Published pricing cannot be deleted'; END IF;
    IF NEW.rules_json IS DISTINCT FROM OLD.rules_json OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.version IS DISTINCT FROM OLD.version OR NEW.approval_ref IS DISTINCT FROM OLD.approval_ref
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
      RAISE EXCEPTION 'Published price content is immutable; append a version';
    END IF;
    IF NOT (NEW.status=OLD.status OR (OLD.status='APPROVED' AND NEW.status IN ('ACTIVE','RETIRED'))
            OR (OLD.status='ACTIVE' AND NEW.status='RETIRED')) THEN
      RAISE EXCEPTION 'Invalid published pricing lifecycle transition';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER published_price_immutable BEFORE UPDATE OR DELETE ON pricing_versions FOR EACH ROW EXECUTE FUNCTION protect_published_price();
COMMIT;
-- Schema has not been executed against PostgreSQL in this delivery. Validate with a temporary
-- approved database, migration rollback/compatibility checks and concurrency tests before use.

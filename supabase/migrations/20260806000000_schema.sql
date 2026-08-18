-- members: un registro por email, estado y expiración de membresía
CREATE TABLE IF NOT EXISTS members (
  email            TEXT        PRIMARY KEY,
  name             TEXT,
  circle_member_id INTEGER,
  status           TEXT        NOT NULL DEFAULT 'inactive'
                               CHECK (status IN ('active', 'inactive')),
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- subscription_payments: historial de pagos para calcular racha
CREATE TABLE IF NOT EXISTS subscription_payments (
  shopify_order_id TEXT        PRIMARY KEY,
  member_email     TEXT        NOT NULL REFERENCES members(email) ON DELETE CASCADE,
  paid_at          TIMESTAMPTZ NOT NULL,
  period_end       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- webhook_attempts: dedup e idempotencia por order_id
CREATE TABLE IF NOT EXISTS webhook_attempts (
  shopify_order_id TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'processing'
                   CHECK (status IN ('processing', 'completed', 'failed')),
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_members_status_expires ON members (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_payments_email_paid ON subscription_payments (member_email, paid_at DESC);

-- Auto-update updated_at en members
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS members_updated_at ON members;
CREATE TRIGGER members_updated_at
  BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

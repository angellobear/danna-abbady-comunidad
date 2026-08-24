-- Raw Shopify webhook payloads for auditing / debugging
CREATE TABLE IF NOT EXISTS shopify_webhook_logs (
  id               BIGSERIAL   PRIMARY KEY,
  shopify_order_id TEXT        NOT NULL,
  payload          JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_order ON shopify_webhook_logs (shopify_order_id);

-- Shopify customer ID — useful to look up subscription contracts via Shopify API for future cancellations
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS shopify_customer_id TEXT;

-- Shopify selling_plan_id identifies which subscription plan; stored per payment
ALTER TABLE subscription_payments
  ADD COLUMN IF NOT EXISTS shopify_selling_plan_id TEXT;

-- Update upsert_member_payment to store new fields
CREATE OR REPLACE FUNCTION upsert_member_payment(
  p_email                 TEXT,
  p_name                  TEXT,
  p_circle_id             INTEGER,
  p_order_id              TEXT,
  p_paid_at               TIMESTAMPTZ,
  p_period_end            TIMESTAMPTZ,
  p_shopify_customer_id   TEXT DEFAULT NULL,
  p_shopify_selling_plan  TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_email));

  INSERT INTO members (email, name, circle_member_id, status, expires_at, shopify_customer_id)
  VALUES (p_email, p_name, p_circle_id, 'active', p_period_end, p_shopify_customer_id)
  ON CONFLICT (email) DO UPDATE SET
    name                 = COALESCE(EXCLUDED.name, members.name),
    circle_member_id     = COALESCE(EXCLUDED.circle_member_id, members.circle_member_id),
    shopify_customer_id  = COALESCE(EXCLUDED.shopify_customer_id, members.shopify_customer_id),
    status               = 'active',
    expires_at           = GREATEST(members.expires_at, EXCLUDED.expires_at);

  INSERT INTO subscription_payments (shopify_order_id, member_email, paid_at, period_end, shopify_selling_plan_id)
  VALUES (p_order_id, p_email, p_paid_at, p_period_end, p_shopify_selling_plan)
  ON CONFLICT (shopify_order_id) DO NOTHING;
END;
$$;

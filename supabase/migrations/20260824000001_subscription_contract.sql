-- Shopify subscription contract ID — used to cancel the subscription via Shopify API
ALTER TABLE subscription_payments
  ADD COLUMN IF NOT EXISTS shopify_subscription_contract_id TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_contract ON subscription_payments (shopify_subscription_contract_id)
  WHERE shopify_subscription_contract_id IS NOT NULL;

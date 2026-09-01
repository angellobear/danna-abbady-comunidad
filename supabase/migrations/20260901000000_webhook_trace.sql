-- Traza del webhook en la MISMA fila del payload: un solo registro por
-- ejecucion, con todos los pasos como array JSON en `steps`.
ALTER TABLE shopify_webhook_logs
  ADD COLUMN IF NOT EXISTS rid   TEXT,
  ADD COLUMN IF NOT EXISTS ms    INTEGER,
  ADD COLUMN IF NOT EXISTS steps JSONB;

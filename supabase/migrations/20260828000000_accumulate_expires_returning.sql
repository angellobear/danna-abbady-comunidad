-- La BD tenía dos upsert_member_payment conviviendo (6 y 8 params): PostgREST
-- no puede resolver el overload y cualquier llamada con 6 args falla PGRST203.
-- Se elimina la vieja y se recrea la de 8 devolviendo el expires_at acumulado,
-- para que el correo muestre la fecha real y no pago+30d.
DROP FUNCTION IF EXISTS upsert_member_payment(text, text, integer, text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS upsert_member_payment(text, text, integer, text, timestamptz, timestamptz, text, text);

CREATE FUNCTION upsert_member_payment(
  p_email                 TEXT,
  p_name                  TEXT,
  p_circle_id             INTEGER,
  p_order_id              TEXT,
  p_paid_at               TIMESTAMPTZ,
  p_period_end            TIMESTAMPTZ,
  p_shopify_customer_id   TEXT DEFAULT NULL,
  p_shopify_selling_plan  TEXT DEFAULT NULL
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
  v_duration INTERVAL := p_period_end - p_paid_at;
  v_new_expires TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_email));

  -- Apila días desde la expiración vigente, o desde hoy si ya expiró
  SELECT GREATEST(expires_at, now()) + v_duration
  INTO v_new_expires
  FROM members
  WHERE email = p_email;

  v_new_expires := COALESCE(v_new_expires, p_period_end);

  INSERT INTO members (email, name, circle_member_id, status, expires_at, shopify_customer_id)
  VALUES (p_email, p_name, p_circle_id, 'active', v_new_expires, p_shopify_customer_id)
  ON CONFLICT (email) DO UPDATE SET
    name                 = COALESCE(EXCLUDED.name, members.name),
    circle_member_id     = COALESCE(EXCLUDED.circle_member_id, members.circle_member_id),
    shopify_customer_id  = COALESCE(EXCLUDED.shopify_customer_id, members.shopify_customer_id),
    status               = 'active',
    expires_at           = v_new_expires;

  -- period_end guarda la cobertura del pago individual (lo usa el streak),
  -- NO el acumulado
  INSERT INTO subscription_payments (shopify_order_id, member_email, paid_at, period_end, shopify_selling_plan_id)
  VALUES (p_order_id, p_email, p_paid_at, p_period_end, p_shopify_selling_plan)
  ON CONFLICT (shopify_order_id) DO NOTHING;

  RETURN v_new_expires;
END;
$$;

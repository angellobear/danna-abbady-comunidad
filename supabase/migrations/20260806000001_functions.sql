-- get_member_streak: meses consecutivos de membresía activa (con 3 días de gracia)
CREATE OR REPLACE FUNCTION get_member_streak(p_email TEXT)
RETURNS INTEGER
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  streak     INTEGER := 0;
  prev_paid  TIMESTAMPTZ;
  rec        RECORD;
BEGIN
  FOR rec IN
    SELECT paid_at, period_end
    FROM subscription_payments
    WHERE member_email = p_email
    ORDER BY paid_at DESC
  LOOP
    IF streak = 0 THEN
      IF rec.period_end >= now() - INTERVAL '3 days' THEN
        streak    := 1;
        prev_paid := rec.paid_at;
      ELSE
        EXIT;
      END IF;
    ELSE
      IF prev_paid <= rec.period_end + INTERVAL '3 days' THEN
        streak    := streak + 1;
        prev_paid := rec.paid_at;
      ELSE
        EXIT;
      END IF;
    END IF;
  END LOOP;
  RETURN streak;
END;
$$;

-- upsert_member_payment: upsert atómico con advisory lock por email
CREATE OR REPLACE FUNCTION upsert_member_payment(
  p_email          TEXT,
  p_name           TEXT,
  p_circle_id      INTEGER,
  p_order_id       TEXT,
  p_paid_at        TIMESTAMPTZ,
  p_period_end     TIMESTAMPTZ
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_email));

  INSERT INTO members (email, name, circle_member_id, status, expires_at)
  VALUES (p_email, p_name, p_circle_id, 'active', p_period_end)
  ON CONFLICT (email) DO UPDATE SET
    name             = COALESCE(EXCLUDED.name, members.name),
    circle_member_id = COALESCE(EXCLUDED.circle_member_id, members.circle_member_id),
    status           = 'active',
    expires_at       = GREATEST(members.expires_at, EXCLUDED.expires_at);

  INSERT INTO subscription_payments (shopify_order_id, member_email, paid_at, period_end)
  VALUES (p_order_id, p_email, p_paid_at, p_period_end)
  ON CONFLICT (shopify_order_id) DO NOTHING;
END;
$$;

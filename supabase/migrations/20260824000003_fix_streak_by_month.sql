-- Fix: streak counts distinct calendar months, not individual payments.
-- Multiple payments in the same month = 1 month streak, not N.
CREATE OR REPLACE FUNCTION get_member_streak(p_email TEXT)
RETURNS INTEGER
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  streak     INTEGER := 0;
  prev_month DATE;
  rec        RECORD;
BEGIN
  FOR rec IN
    SELECT DATE_TRUNC('month', paid_at)::DATE AS month,
           MAX(period_end) AS period_end
    FROM subscription_payments
    WHERE member_email = p_email
    GROUP BY DATE_TRUNC('month', paid_at)
    ORDER BY month DESC
  LOOP
    IF streak = 0 THEN
      IF rec.period_end >= now() - INTERVAL '3 days' THEN
        streak     := 1;
        prev_month := rec.month;
      ELSE
        EXIT;
      END IF;
    ELSE
      IF prev_month = rec.month + INTERVAL '1 month' THEN
        streak     := streak + 1;
        prev_month := rec.month;
      ELSE
        EXIT;
      END IF;
    END IF;
  END LOOP;
  RETURN streak;
END;
$$;

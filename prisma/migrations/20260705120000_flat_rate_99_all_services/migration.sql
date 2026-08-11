-- Flat ₹99/hour pricing across all services.
-- Rate cards are append-only: close every open card that isn't already ₹99,
-- then open a fresh ₹99 card for any service left without an active card.
--
-- Guarded on `rate_cards` existing. When this migration was written the table
-- had only ever been created by `prisma db push`, so it is absent during a
-- replay from scratch and this migration aborted the whole reset. The table is
-- created properly by 20260811120000_reconcile_db_push_drift, which runs after
-- this one. Nothing is lost by skipping: on a fresh database `services` is
-- still empty at this point, so there is no rate to correct — the seed creates
-- the services and their ₹99 cards together.

DO $$ BEGIN
  IF to_regclass('public.rate_cards') IS NULL THEN
    RAISE NOTICE 'rate_cards does not exist yet; flat-rate backfill deferred to the reconcile migration.';
    RETURN;
  END IF;

  UPDATE rate_cards
  SET effective_to = NOW()
  WHERE effective_to IS NULL
    AND hourly_rate <> 99;

  INSERT INTO rate_cards (service_id, hourly_rate, effective_from)
  SELECT s.id, 99, NOW()
  FROM services s
  WHERE NOT EXISTS (
    SELECT 1 FROM rate_cards rc
    WHERE rc.service_id = s.id AND rc.effective_to IS NULL
  );
END $$;

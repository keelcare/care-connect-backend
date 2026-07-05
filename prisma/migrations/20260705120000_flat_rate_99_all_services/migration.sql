-- Flat ₹99/hour pricing across all services.
-- Rate cards are append-only: close every open card that isn't already ₹99,
-- then open a fresh ₹99 card for any service left without an active card.

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

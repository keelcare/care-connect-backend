-- Multi-address support: parents (and any user) can save more than one address.
-- Backfills each user's existing single profiles.address/lat/lng into a default
-- addresses row so booking/matching logic can move to reading from here.

CREATE TABLE "addresses" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "label" VARCHAR(50) NOT NULL DEFAULT 'Home',
    "address" TEXT NOT NULL,
    "lat" DECIMAL(10,8) NOT NULL,
    "lng" DECIMAL(11,8) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) DEFAULT now(),

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "addresses_user_id_idx" ON "addresses"("user_id");

ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Backfill: one default address per user that already had a saved location.
INSERT INTO "addresses" (id, user_id, label, address, lat, lng, is_default, created_at, updated_at)
SELECT uuid_generate_v4(), user_id, 'Home',
       COALESCE(address, location_address, 'Saved address'),
       lat, lng, true, now(), now()
FROM "profiles"
WHERE lat IS NOT NULL AND lng IS NOT NULL;

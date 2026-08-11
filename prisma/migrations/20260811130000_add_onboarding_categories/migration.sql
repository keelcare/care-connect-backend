-- Service categories are now chosen during nanny onboarding rather than at
-- signup, so they need somewhere to live before the nanny_details row exists.
-- `completeMine` copies this onto nanny_details.categories.
ALTER TABLE "nanny_onboarding_details"
  ADD COLUMN IF NOT EXISTS "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

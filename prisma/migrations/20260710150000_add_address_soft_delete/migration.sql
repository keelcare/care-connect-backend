-- Soft delete for addresses: rows are retained so completed bookings keep
-- their address history and removals leave an audit trail. All application
-- reads filter deleted_at IS NULL (see src/addresses/addresses.service.ts).
ALTER TABLE "addresses" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

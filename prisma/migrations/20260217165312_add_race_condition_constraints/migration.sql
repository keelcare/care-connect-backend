-- CreateUniqueIndex on assignments
CREATE UNIQUE INDEX assignments_request_id_nanny_id_key ON assignments (request_id, nanny_id);

-- CreatePartialUniqueIndex on bookings
CREATE UNIQUE INDEX unique_active_booking_per_request ON bookings (request_id) WHERE status != 'CANCELLED';

-- CreatePartialUniqueIndex on nanny_category_requests
CREATE UNIQUE INDEX unique_pending_category_request ON nanny_category_requests (nanny_id) WHERE status = 'pending';
# Dev B — Matching · Data Integrity · Missing Modules · Code Quality

Source: Care Connect Backend Workload Split PDF fileciteturn0file0

---

# Critical

## Task 3 — Remove dead unreachable return in transaction block
**File:** `requests.service.ts:586–588`

```ts
return { assignment, booking: updatedBooking };
return assignment; // ← DEAD CODE, UNREACHABLE
```

The first return already exits the block. This is a leftover from refactoring and signals the function was partially rewritten without cleanup. Remove the second `return assignment` line.

---

## Task 6 — Fix broken Prisma filter in findAllByParent
**File:** `requests.service.ts:838–843`

```ts
bookings: {
 OR: [
   { id: { equals: undefined } }, // ← This is always false/no-op in Prisma
   { status: 'CANCELLED' },
 ],
},
```

`{ id: { equals: undefined } }` is a Prisma no-op — it does not filter for “no booking.” This means requests with active bookings may still appear in the parent’s request list, causing UI duplication (the same job appears in both Requests and Bookings views).

Replace with an explicit `isNot: null` / `none` relation filter to properly exclude requests that have non-cancelled bookings.

---

# Logic Bugs

## Task 14 — Define BookingStatus enum and replace all mixed-case status strings
**Files:** `requests.service.ts`, `bookings.service.ts` (all status field references)

Booking statuses are inconsistently cased throughout the codebase:

- `"CONFIRMED"`, `"IN_PROGRESS"`, `"COMPLETED"`, `"CANCELLED"` (uppercase)
- `"requested"`, `"pending"`, `"accepted"` (lowercase)

This causes live bugs such as in `rescheduleBooking`:

```ts
if (!['CONFIRMED', 'REQUESTED', 'requested'].includes(booking.status)) {
```

`'REQUESTED'` is listed but bookings are created with `'requested'`. The uppercase version is never set, so filter queries miss records.

Define a `BookingStatus` enum in a shared types file and replace every raw string comparison across the codebase.

> This task must be completed and merged before Dev A begins work on Tasks #4 and #21.

---

## Task 15 — Include IN_PROGRESS bookings in busy-nanny exclusion during matching
**File:** `requests.service.ts (triggerMatching)`

```ts
const busyNannies = await this.prisma.bookings.findMany({
 where: {
   status: 'CONFIRMED', // ← What about IN_PROGRESS bookings?
```

A nanny who is currently `IN_PROGRESS` on a booking can be re-assigned to a new booking that starts before their current one ends.

Add `IN_PROGRESS` (and `requested`) statuses to the exclusion filter.

---

## Task 16 — Fix combineDateAndTime double-shifting IST near midnight
**File:** `time.utils.ts (combineDateAndTime)`

```ts
const combined = new Date(`${datePart}T${timePart}:00+05:30`);
```

When Date objects are retrieved from Postgres (already UTC), extracting `.toISOString().split('T')[0]` and re-applying `+05:30` will double-shift times for date components near midnight IST.

Refactor to properly extract the IST date component before recombining, without re-applying an offset to an already-converted value.

---

## Task 17 — Fix getEndTime month overflow for recurring bookings
**File:** `requests.service.ts (getEndTime)`

```ts
endDate.setMonth(endDate.getMonth() + (request.plan_duration_months || 1));
```

`setMonth()` overflows in JavaScript.

Example:
- January 31 + 1 month = March 2
- Expected: February 28

Recurring booking end dates will be wrong for services starting on the 29th, 30th, or 31st.

Replace with a date library (e.g. `date-fns addMonths`) that handles month-end correctly.

---

## Task 18 — Add ownership check in cancelRequest service method
**File:** `requests.service.ts (cancelRequest)`

```ts
async cancelRequest(id: string) { // ← parentId is not passed
```

The service method takes only the request ID and performs no ownership check.

If the controller guard is ever bypassed or called incorrectly, any user could cancel any request.

Pass `parentId` into the method and validate ownership inside the service.

---

## Task 19 — Replace hardcoded session count in pricing with value from service request
**File:** `requests.service.ts (pricing logic)`

```ts
const sessionsPerMonth = planType === 'ONE_TIME' ? 1 : 4;
const monthlyCost = sessionCostAfterDiscount * sessionsPerMonth;
const totalAmount = monthlyCost * planMonths;
```

The “4 sessions per month” is hardcoded.

If a booking is for 2 sessions per week (8/month), pricing will be wrong.

Read the sessions-per-month value from the service request data instead of the magic constant.

---

## Task 22 — Fix reportNoShow wiping existing booking tags
**File:** `bookings.service.ts (reportNoShow)`

```ts
data: {
 tags: ['noshow', noShowTag], // ← replaces existing tags array
}
```

If the booking already had tags (e.g. `['subscription']`), they will be lost.

Use Prisma’s `{ push: [...] }` or merge with the existing tags array before writing.

---

# Missing Features

## Task 24 — Implement Progress Reports module
**File:** `src/ (module does not exist)`

The schema has:

- `progress_reports`
- `report_answers`
- `report_templates`
- `report_template_questions`

There is no `progress-reports` module in `src/`.

Missing:
- No controller
- No service
- No endpoints

The feature exists in the DB but is completely unreachable via API.

Create the module with full CRUD endpoints and wire the `due_at` / `OVERDUE` status to the overdue cron (coordinated with Dev A — Task 23).

---

## Task 26 — Implement recurring booking generation
**File:** `recurring-bookings.module.ts`

`recurring_bookings` rows are created when a subscription is matched, but:

- No endpoint generates future bookings from the recurrence pattern
- No cron job creates the next month’s booking
- `recurring_booking_logs` is never written anywhere in code
- The `RecurringBookingsModule` exists but does nothing operationally

Implement the logic to:

- Generate the next period’s booking from the recurrence pattern
- Write logs to `recurring_booking_logs`
- Coordinate the renewal cron with Dev A’s Task 23

---

## Task 27 — Add write endpoint for location_updates (nanny GPS tracking)
**File:** `location.module.ts`

`location_updates` is in the schema and referenced in bookings.

There is no visible endpoint that writes nanny GPS pings during `IN_PROGRESS` bookings.

The geofence check at booking start works, but real-time tracking during the session is missing.

Add a POST endpoint such as:

```http
PATCH /bookings/:id/location
```

Requirements:
- Writes nanny GPS pings
- Callable only when the booking is `IN_PROGRESS`

---

## Task 28 — Make WhatsApp conversation flow two-way
**File:** `whatsapp.module.ts`

The WhatsApp module collects enquiries via conversation steps:

`WELCOME → COLLECT_NAME → ...`

But:

- There is no webhook to receive replies from users
- The `assigned_user` on `whatsapp_enquiries` is never notified in-app
- No integration with actual booking flow — enquiries are dead-end data

Implement:

- Inbound webhook
- In-app notifications to `assigned_user`
- Integration from completed enquiries into the booking request flow

---

## Task 29 — Write to matching_feedback after each match attempt
**File:** `requests.service.ts (post-matching logic)`

The `matching_feedback` table exists in the schema with:

- `was_successful`
- `feedback_data`

But no service or endpoint creates records in it.

The matching algorithm has no learning loop.

After each `triggerMatching` run, write a record indicating:

- Whether a match was made
- Which nanny was selected
- The scoring data used

---

# Code Quality

## Task 31 — Replace all console.log with NestJS Logger
**Files:** `requests.service.ts`, `bookings.service.ts`, and all other services

Issues:

- `requests.service.ts` has 15+ raw `console.log()` calls
- Logs include full JSON serialization of parent objects, nanny scores, and SQL query debug info
- `bookings.service.ts` logs every nanny cancellation
- None use the NestJS `Logger` class

Replace all instances with:

```ts
private readonly logger = new Logger(ServiceName.name)
```

Use:

- `this.logger.log()`
- `this.logger.warn()`
- `this.logger.error()`

---

## Task 32 — Replace any types with proper TypeScript types
**Files:**
- `bookings.service.ts:1029`
- `requests.service.ts:101`
- `payments.service.ts:432`
- `assignments.service.ts:142`

Examples:

```ts
const updateData: any = {} // bookings
} as any // requests
tx: any // payments
tx: any // assignments
```

These defeat TypeScript’s type safety and can silently mask runtime errors.

Define proper interfaces or use Prisma-generated types for each case.

---

## Task 33 — Extract magic numbers into constants.ts
**Files:** `requests.service.ts`, `bookings.service.ts`

Examples:

```ts
const radiusKm = 15;
const unstartedCutoff = new Date(now.getTime() - 4 * 60 * 60 * 1000);
const inProgressCutoff = new Date(now.getTime() - 8 * 60 * 60 * 1000);
const amountInPaise = Math.round(amountInRupees * 100);
const response_deadline: new Date(Date.now() + 15 * 60 * 1000),
```

All business-critical thresholds are hardcoded inline.

Create a central `constants.ts` (or pull from `system_settings`) and reference values from there.

> Dev A must import from this file rather than define their own inline constants.

---

## Task 34 — Fix N+1 query in triggerMatching availability check
**File:** `requests.service.ts (triggerMatching)`

```ts
const nanniesWithBlocks = await this.prisma.availability_blocks.findMany({...});
for (const block of nanniesWithBlocks) {
 const isUnavailable = !(await this.availabilityService.isNannyAvailable(...));
```

For each availability block, a separate DB query is issued inside a loop.

If 100 nannies have blocks, this results in 100+ sequential queries during every matching run.

Refactor to batch-load all required availability data before the loop.

---

## Task 35 — Eliminate double getBookingById fetch on protected booking actions
**Files:** `bookings.controller.ts`, `bookings.service.ts`

```ts
async startBooking(@Param('id') id: string, ...) {
 const booking = await this.bookingsService.getBookingById(id); // ← First fetch
 if (booking.nanny_id !== req.user.id) throw ForbiddenException;
 return this.bookingsService.startBooking(id, ...); // ← Second fetch inside service
}
```

Every protected booking action fetches the booking twice — two round-trips to Postgres per request.

Pass the pre-fetched booking object into the service method rather than re-fetching by ID.

---

## Task 36 — Route inline +05:30 in rescheduleBooking through TimeUtils
**File:** `bookings.service.ts (rescheduleBooking)`

```ts
const newStartDateTime = new Date(`${newDate}T${formatTime(newStartTime)}+05:30`);
```

Unlike `TimeUtils.combineDateAndTime`, this hardcodes `+05:30` inline without going through the centralized utility.

Any future timezone change must be found and updated in multiple places.

Replace with a call to `TimeUtils.combineDateAndTime()` after Dev B’s fix in Task 16 is merged.

---

# Conflict Prevention Rules Relevant to Dev B

| Rule | Detail |
|---|---|
| `bookings.service.ts` is shared | Dev A owns: `completeBooking`, `startBooking`, `handleNoShow`, `checkExpiredBookings`. Dev B owns: `reportNoShow`, `rescheduleBooking`. Both must PR against a shared feature branch — not main — and merge sequentially. |
| `requests.service.ts` is primarily Dev B’s | Dev A touches it only for the transaction wrap (Task 8). Dev B must complete and merge their changes first so Dev A can rebase cleanly. |
| `time.utils.ts` is split by function | Dev A fixes `nowIST()` (Task 2). Dev B fixes `combineDateAndTime()` (Task 16). These are independent functions and can be merged in parallel. |
| `BookingStatus` enum (Task 14) blocks Dev A | Dev B must define and export the enum first. Dev A must import it rather than define their own. |
| `constants.ts` (Task 33) is Dev B’s file | If Dev A needs constants during their work, they should request additions rather than define inline constants. |

---

# Recommended Week 1 Execution Order (Dev B)

| Priority | Task | Notes |
|---|---|---|
| 2 | #14 — BookingStatus enum | Day 1 — unblocks Tasks 4, 15, 21 |
| 5 | #6 — findAllByParent broken filter | Day 1 |
| 8 | #15 — IN_PROGRESS nannies double-booked | Day 2 — after Task 14 merged |
| 10 | #33 — constants.ts | Day 3 — unblocks quality pass |


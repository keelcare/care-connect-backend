# Caregiver Attendance

## What is being measured

**The unit of attendance is the committed session, not the calendar day and not time spent online.**

A caregiver on this platform is not a gig worker roaming for jobs — she is staffed onto a plan (`recurring_service_requests.nanny_id`) serving one family at one address. Time spent with the app open proves nothing about whether a child was cared for, so it cannot be the primary signal. What *is* verifiable, and already produced by the system today, is:

| Signal | Produced by |
|---|---|
| Geofenced arrival at the care address | `BookingsService.startBooking` — rejects a check-in outside `geofence_radius` |
| Departure | `BookingsService.completeBooking` → `actual_end_time` |
| Position trail during the session | `LocationGateway` → `location_updates` |
| Cancellation and its notice period | `BookingsService.cancelBooking` |
| Abandoned sessions | `BookingsService.checkExpiredBookings` |

Attendance is therefore *scheduled slot vs. geo-verified check-in*, with presence used only as a secondary signal, and only while a session is actually running.

## Criteria

Thresholds and weights live in exactly one place: [`src/attendance/attendance.constants.ts`](../src/attendance/attendance.constants.ts).

| Outcome | Rule | Session credit |
|---|---|---|
| `CHECK_IN` | Arrived ≤ 10 min after slot start | 1.00 |
| `LATE_CHECK_IN` | 10–30 min late | 0.80 |
| `LATE_CHECK_IN` | > 30 min late | 0.60 |
| `NO_SHOW` | No check-in by start + 30 min | **−0.50** |
| `LATE_CANCEL` | Caregiver cancelled < 24 h before start | 0.00 |
| `ADVANCE_CANCEL` | Caregiver cancelled ≥ 24 h before start | 0.50 |
| `EARLY_CHECK_OUT` | Left > 15 min before scheduled end | −0.20 (modifier) |
| `MISSED_CHECK_OUT` | System had to auto-close the session | −0.10 (modifier) |
| `GEOFENCE_BREACH` | Outside the fence ≥ 10 min continuously | −0.20 (modifier) |
| `OFFLINE_DURING_SESSION` | No heartbeat > 20 min mid-session | −0.20 (modifier) |

The 24-hour cancellation boundary is deliberately the same one the cancellation *fee* uses. One notion of "short notice" across money and attendance, or the two will eventually disagree in front of a caregiver disputing both.

A no-show scores below zero rather than at zero because it is worse than the session never having existed: a family was left without care and without notice to arrange any.

## The score

```
score = clamp(100 × Σ credit / count(session outcomes), 0, 100)
```

over a rolling **60 days**, published only once the caregiver has **5 settled sessions** in the window.

Three properties worth stating, because each is a decision rather than an accident:

- **Rate-based, not a demerit tally.** A caregiver serving thirty sessions a month would otherwise accumulate more absolute penalty than one serving five, for the same standard of reliability. Only the five outcome events form the denominator; modifiers subtract from the numerator, so nobody can dilute a geofence breach by working more.
- **Weights are frozen per row** (`nanny_attendance_events.score_weight`) rather than resolved from current policy at read time — the same principle `price_snapshots` applies to GST. Retuning the policy moves future scores; it never rewrites the record someone was already judged on.
- **Below the minimum session count the score is `null`**, not zero. A single bad day out of three swings the number twenty points, which reads as a verdict when it is really noise.

Bands: `EXCELLENT` ≥ 90, `GOOD` ≥ 75, `NEEDS_IMPROVEMENT` ≥ 60, `AT_RISK` below. The score is denormalised onto `nanny_details.attendance_score` by the nightly job, so matching and admin ranking read one number instead of replaying the event log — the trade-off `acceptance_rate` already makes.

## Fairness rules

These are load-bearing. An attendance score that a caregiver experiences as arbitrary is worse than none at all, because it attaches consequences to noise.

1. **Parent-side failures never count.** A booking in `PARENT_NO_SHOW`, or cancelled by the parent or an admin, produces no caregiver event — she made the trip either way. Enforced in `isCaregiverAccountable` and in the listener's `cancelledByUserId !== nanny_id` check.
2. **Every event is waivable** by an admin, with a mandatory ≥ 10-character reason. Waived events stay on the timeline marked as excused and stop counting — nothing is deleted, because a dispute usually turns on the sequence of what the system believed and when.
3. **Late arrival retracts an earlier no-show.** A caregiver who turns up 40 minutes late is late, not absent; the sweeper's flag is waived rather than left contradicting the check-in.
4. **The caregiver can see her own event list**, including waived ones, with the weight each carried. A score nobody can audit is a score nobody will accept.
5. **Short geofence exits are ignored.** The school gate, the pharmacy, a walk with the child. Only a continuous 10-minute absence is recorded, and then not again for 30 minutes, so one long absence is one event rather than one per GPS ping.
6. **Declared leave is not absence.** A day fully covered by an `availability_blocks` row rolls up as `LEAVE`. Attendance reads the existing time-off mechanism instead of inventing a second one.
7. **Being offline is only ever evaluated inside a live session.** Off-duty is not absent.

## Data model

**`nanny_attendance_events`** — append-only facts, one row per occurrence. `dedupe_key` (`<booking_id>:<type>`) gives database-level idempotency for the once-per-session types; the repeatable ones leave it null, and Postgres does not collide NULLs in a unique index, so one column covers both without a partial index Prisma cannot express.

**`nanny_attendance_days`** — one roll-up row per caregiver per IST day. A table rather than a computed read because the partner app's calendar and the admin roster are both range scans over months, and because `override_status` needs somewhere to live that a recompute will not overwrite.

**`nanny_details`** — gains `attendance_score`, `attendance_sessions`, `attendance_updated_at`, `last_seen_at`.

## Moving parts

Writes reach attendance through the **event emitter**, not through calls inside `BookingsService`. Check-in, check-out and cancellation are moments when a caregiver is standing at a door with the app open; a failure to write a statistic must not be able to stop any of them. Every recording path swallows and logs its own errors — an attendance row describes what happened, it does not get a vote in whether it happens.

| Trigger | Handler |
|---|---|
| `booking.started` | `AttendanceListeners.handleStarted` → check-in / late check-in |
| `booking.completed` | `handleCompleted` → check-out, early departure |
| `booking.cancelled` (by the caregiver) | `handleCancelled` → late / advance cancel |
| `booking.auto_completed` *(new event)* | `handleAutoCompleted` → missed check-out |
| Outside-fence position report | `LocationGateway` → `evaluateGeofenceBreach` |
| Every 5 min | `sweepNoShows`, `sweepOfflineDuringSessions` |
| Hourly at :15 | `rollUpToday` — keeps the roster view live |
| 00:20 IST daily | `rollUpYesterdayAndScore` |

`booking.auto_completed` is a new event emitted alongside `booking.completed` from `checkExpiredBookings`. Completion means care finished, and payments and progress reports must treat an auto-closed session identically; only attendance cares that nobody closed it. Folding the distinction into the completion event would force every other subscriber to learn about it.

The no-show sweeper **records the fact and alerts both parties, but does not change booking status**. `checkExpiredBookings` already owns that transition at its own four-hour horizon, and two writers on one status field is how bookings end up in states nobody can explain.

The nightly job is pinned to `Asia/Kolkata`. The whole product runs on IST wall-clock slots (see `TimeUtils`); a job that thinks the day ends at 05:30 IST files every early-morning session under the wrong date.

## API

Caregiver (JWT):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/attendance/me/summary?days=60` | Score, band, punctuality, day tallies, streak |
| `GET` | `/attendance/me/calendar?month=YYYY-MM` | Day-by-day, for the calendar view |
| `GET` | `/attendance/me/events?limit=&before=` | Own timeline, waived events included and flagged |
| `POST` | `/nannies/me/presence` | `{ online: boolean }` |
| `POST` | `/nannies/me/heartbeat` | Liveness ping |

Admin:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/attendance/overview?date=YYYY-MM-DD` | Roster for one IST day, absences sorted first |
| `GET` | `/attendance/at-risk?threshold=60` | Caregivers to follow up with |
| `GET` | `/attendance/nanny/:id/summary\|calendar\|events` | One caregiver's record |
| `POST` | `/attendance/events/:id/waive` | Excuse an event (reason required) |
| `POST` | `/attendance/nanny/:id/day/:date/override` | Correct a day's status |
| `POST` | `/attendance/recompute?date=` | Re-run a day's roll-up and refresh scores |

`GET /nannies/me/performance` now reports **measured** punctuality. It previously derived `punctualityScore` from the average review rating, which meant a caregiver could be scored punctual for being well-liked and late for a bad review about something else; the rating-based figure survives only as a fallback for caregivers below the minimum session count.

## Deploying

1. `npx prisma generate` — the new enums and models are referenced by type across the module.
2. `npx prisma migrate deploy` — applies `20260808120000_add_nanny_attendance`.

The migration also adds an index on `location_updates(booking_id, timestamp)`. That table had none, and the breach detector scans a session's recent pings on every outside position report.

Existing history is not backfilled. `actual_start_time` vs `start_time` is available on completed bookings and could seed check-in events, but sessions that predate the geofenced check-in flow have arrival times of uneven provenance, and starting a scoring system by scoring people on data collected for another purpose is not a good first impression. Scores begin accruing from deployment.

## Partner app

Built in the `mobile-nanny` repo against the three `me/*` endpoints:

- `app/(app)/attendance.tsx` — score and band, punctuality, a month calendar with per-day detail, and the full event timeline including excused records. Grace and late thresholds in the "how this is measured" card are read from the API response rather than hardcoded, so a policy change on the server cannot silently disagree with the score shown above it.
- `components/PresenceHeartbeat.tsx` — headless, mounted at the root. Not on a screen: a nanny sitting on the Bookings tab for an hour is still working, and a heartbeat that stops when one screen unmounts reports her offline mid-session — the exact false positive the sweep exists to avoid. Foreground only, every 5 minutes against a 20-minute server tolerance.
- `hooks/useNannyPresence.ts` — now publishes to `POST /nannies/me/presence` and re-syncs the stored choice on launch. The device stays the source of truth for what the toggle *shows*: a failed publish is logged rather than flipped back, because presence is a matching hint and a control that undoes itself under someone's thumb costs more than a few minutes of drift.

## Not built

- **No automatic consequences.** The score informs matching and gives operations a list to work; it does not suspend anyone. Deactivation stays a human decision.
- **No backfill** (above).
- **No admin UI.** The admin endpoints (roster, at-risk list, waive, override) are live but have no screen in `keel-mobile-admin` yet.
- **Timeline is first-page only** in the app — 20 records, no pagination, though the API returns a cursor for it.

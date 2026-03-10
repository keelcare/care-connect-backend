# Backend SSE — Roles, Events & Extension Guide

## Overview

The backend streams real-time data change events to connected browser clients using **Server-Sent Events (SSE)** via a long-lived HTTP connection. All server→client data event delivery goes through SSE. The existing socket.io gateway (`NotificationsGateway`) is retained exclusively for **chat** (bi-directional messaging).

---

## Architecture

```
Service Layer (mutation)
        │
        ▼
  SseService.emitToUser(userId, SseEvent)
        │
        ▼
  Per-user Subject<MessageEvent>   ◄── registered in SseController.stream()
        │
        ▼
  GET /sse  ─── text/event-stream ─── Browser EventSource
```

### Key Files

| File | Role |
|------|------|
| `src/events/sse-event.types.ts` | Canonical `SseEvent<T>` interface + all event type constants |
| `src/sse/sse.service.ts` | Manages per-user `Subject<MessageEvent>` map, exposes emit helpers |
| `src/sse/sse.controller.ts` | `GET /sse` endpoint — opens the SSE stream per authenticated user |
| `src/sse/sse.module.ts` | Global module — `SseService` exported for injection everywhere |

---

## Event Catalog

Every event payload conforms to:
```typescript
interface SseEvent<T = any> {
  type: string;       // One of SSE_EVENTS.*
  data: T;            // Entity data relevant to the type
  timestamp: string;  // ISO-8601 UTC
}
```

| Constant | Type string | Emitted by | Recipients |
|----------|-------------|------------|------------|
| `NOTIFICATION` | `notification` | `NotificationsService` | target user |
| `BOOKING_CREATED` | `booking:created` | `BookingsService.createBooking` | parent + nanny |
| `BOOKING_UPDATED` | `booking:updated` | `AssignmentsService.accept` | parent |
| `BOOKING_STARTED` | `booking:started` | `BookingsService.startBooking` | parent |
| `BOOKING_COMPLETED` | `booking:completed` | `BookingsService.completeBooking` | parent + nanny |
| `BOOKING_CANCELLED` | `booking:cancelled` | `BookingsService.cancelBooking` | parent + nanny |
| `BOOKING_RESCHEDULED` | `booking:rescheduled` | `BookingsService.rescheduleBooking` | parent + nanny |
| `ASSIGNMENT_ACCEPTED` | `assignment:accepted` | `AssignmentsService.accept` | parent |
| `ASSIGNMENT_REJECTED` | `assignment:rejected` | `AssignmentsService.reject` | nanny |
| `REQUEST_CREATED` | `request:created` | `RequestsService.create` | parent |
| `REQUEST_MATCHED` | `request:matched` | `RequestsService.triggerMatching` | parent + nanny |
| `REQUEST_CANCELLED` | `request:cancelled` | `RequestsService.cancelRequest` | parent |

---

## How to Emit a New Event

1. **Define the event type** in `src/events/sse-event.types.ts`:
   ```typescript
   export const SSE_EVENTS = {
     // ... existing ...
     PAYMENT_RECEIVED: 'payment:received',
   } as const;
   ```

2. **Inject `SseService`** in your feature service constructor (it's global — no module import needed):
   ```typescript
   constructor(private sseService: SseService) {}
   ```

3. **Emit after the DB write**:
   ```typescript
   this.sseService.emitToUser(userId, {
     type: SSE_EVENTS.PAYMENT_RECEIVED,
     data: payment,
     timestamp: new Date().toISOString(),
   });
   ```

---

## Authentication

The `GET /sse` endpoint is protected by the standard `AuthGuard('jwt')`. The browser's `EventSource` sends cookies automatically when `withCredentials: true` is set. No additional auth header is required.

> **Note:** `@nestjs/event-emitter` is registered in `app.module.ts` but currently used only for the module lifecycle. The `SseService` uses RxJS `Subject` directly — it does not depend on `EventEmitter`. This means the emit path is synchronous and in-process. If you need to fan-out across multiple server instances, replace `SseService` internals with a Redis Pub/Sub adapter without changing the emit callsites.

---

## Future: Redis Pub/Sub Migration

The `SseService` is the single seam point. To migrate to Redis Pub/Sub:

1. Replace the `Map<userId, Subject>` internals with a Redis subscriber.
2. Publish via `ioredis` in `emitToUser` instead of pushing to a Subject.
3. No changes needed in `BookingsService`, `AssignmentsService`, etc.

---

## Package Dependency

Run this once in the backend root if not already installed:
```bash
npm install @nestjs/event-emitter
```

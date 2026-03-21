# Payment Audit Log — Implementation Guide

Every payment transition in the current system overwrites the `payments` row in place. If a capture is retried, a webhook fires twice, or a dispute is raised, there is no history to reconstruct what happened or when. This guide adds an **append-only `payment_audit_log` table** that records every status change with its trigger, timestamp, and metadata.

---

## What Gets Audited

| Trigger | Old Status | New Status | `triggered_by` value |
|---|---|---|---|
| Parent calls `POST /payments/create-order` | *(new row)* | `created` | `api:create_order` |
| Parent calls `POST /payments/verify` | `created` | `captured` | `api:verify_payment` |
| Razorpay webhook `payment.captured` | `created` | `captured` | `webhook:payment.captured` |
| Razorpay webhook `order.paid` | `created` | `captured` | `webhook:order.paid` |
| Razorpay webhook `payment.failed` | `created` | `failed` | `webhook:payment.failed` |
| Duplicate capture attempt (idempotency skip) | `captured` | `captured` | `api:verify_payment:duplicate` |

---

## Step 1 — Add the Model to `prisma/schema.prisma`

Add this block **after** the existing `payments` model (around line 190):

```prisma
model payment_audit_log {
  id           String   @id @default(dbgenerated("uuid_generate_v4()")) @db.Uuid
  payment_id   String   @db.Uuid                          // FK → payments.id
  order_id     String   @db.VarChar(255)                  // Denormalised for easy querying
  from_status  String?  @db.VarChar(50)                   // null on the initial 'created' entry
  to_status    String   @db.VarChar(50)
  triggered_by String   @db.VarChar(100)                  // e.g. "api:verify_payment"
  razorpay_payment_id String? @db.VarChar(255)
  metadata     Json?                                       // extra context (error codes, amounts)
  created_at   DateTime @default(now()) @db.Timestamptz(6)

  payments     payments @relation(fields: [payment_id], references: [id], onDelete: Cascade)

  @@index([order_id])
  @@index([payment_id])
}
```

Also add the reverse relation inside the `payments` model:

```prisma
model payments {
  // ... existing fields ...
  payment_audit_log payment_audit_log[]   // ← add this line
}
```

---

## Step 2 — Create the Migration

Run this command to generate the migration SQL from your updated schema. Do **not** use `--force-reset` — this is a purely additive change:

```bash
npx prisma migrate dev --name add_payment_audit_log
```

Prisma will generate a file at `prisma/migrations/<timestamp>_add_payment_audit_log/migration.sql`. It will contain roughly:

```sql
-- CreateTable
CREATE TABLE "payment_audit_log" (
    "id"                  UUID NOT NULL DEFAULT uuid_generate_v4(),
    "payment_id"          UUID NOT NULL,
    "order_id"            VARCHAR(255) NOT NULL,
    "from_status"         VARCHAR(50),
    "to_status"           VARCHAR(50) NOT NULL,
    "triggered_by"        VARCHAR(100) NOT NULL,
    "razorpay_payment_id" VARCHAR(255),
    "metadata"            JSONB,
    "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "payment_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_audit_log_order_id_idx" ON "payment_audit_log"("order_id");
CREATE INDEX "payment_audit_log_payment_id_idx" ON "payment_audit_log"("payment_id");

-- AddForeignKey
ALTER TABLE "payment_audit_log"
  ADD CONSTRAINT "payment_audit_log_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

After the migration runs, regenerate the Prisma client:

```bash
npx prisma generate
```

---

## Step 3 — Add the Audit Helper to `payments.service.ts`

Add this private helper method inside the `PaymentsService` class, just above `capturePaymentSuccess`:

```typescript
private async writeAuditLog(
  tx: Omit<PrismaService, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  paymentDbId: string,
  orderId: string,
  fromStatus: string | null,
  toStatus: string,
  triggeredBy: string,
  razorpayPaymentId?: string,
  metadata?: Record<string, unknown>,
) {
  await tx.payment_audit_log.create({
    data: {
      payment_id: paymentDbId,
      order_id: orderId,
      from_status: fromStatus,
      to_status: toStatus,
      triggered_by: triggeredBy,
      razorpay_payment_id: razorpayPaymentId,
      metadata: metadata ?? {},
    },
  });
}
```

> **Why pass `tx`?** All audit writes happen inside the same `$transaction` as the status update. If the status update fails and rolls back, the audit entry also disappears — the log stays consistent.

---

## Step 4 — Instrument Each Payment Event

### 4a. `createOrder` — log the initial `created` entry

In the `createOrder` method, after `this.prisma.payments.create(...)`, add the audit write:

```typescript
const newPayment = await this.prisma.payments.create({
  data: {
    booking_id: bookingId,
    amount: amountInRupees,
    currency: "INR",
    provider: "razorpay",
    order_id: order.id,
    status: "created",
  },
});

// Audit: record the initial order creation
await this.writeAuditLog(
  this.prisma,
  newPayment.id,
  order.id,
  null,           // no previous status — this is the first entry
  "created",
  "api:create_order",
);
```

### 4b. `capturePaymentSuccess` — log the `captured` transition

This is the core helper. Extend it to accept a `triggeredBy` parameter and add the audit write inside the transaction:

```typescript
private async capturePaymentSuccess(
  orderId: string,
  paymentId: string,
  signature: string,
  triggeredBy: string,   // ← new parameter
) {
  await this.prisma.$transaction(async (tx) => {
    const payment = await tx.payments.findUnique({
      where: { order_id: orderId },
    });

    if (!payment) throw new NotFoundException("Payment record not found");

    // Idempotency — log the duplicate attempt then exit cleanly
    if (payment.status === "captured") {
      await this.writeAuditLog(
        tx, payment.id, orderId,
        "captured", "captured",
        `${triggeredBy}:duplicate`,
        paymentId,
      );
      return;
    }

    await tx.payments.update({
      where: { order_id: orderId },
      data: { status: "captured", payment_id: paymentId, signature },
    });

    // Audit: record the captured transition
    await this.writeAuditLog(
      tx, payment.id, orderId,
      payment.status,   // "created"
      "captured",
      triggeredBy,
      paymentId,
      { amount: Number(payment.amount), currency: payment.currency },
    );

    const updatedBooking = await tx.bookings.update({
      where: { id: payment.booking_id },
      data: { status: "COMPLETED" },
    });

    await this.notificationsService.createNotification(
      updatedBooking.parent_id,
      "Payment Successful",
      `Your payment of ₹${payment.amount} has been processed successfully.`,
      "success",
    );

    if (updatedBooking.nanny_id) {
      await this.notificationsService.createNotification(
        updatedBooking.nanny_id,
        "Payment Received",
        `A payment of ₹${payment.amount} has been received for your booking.`,
        "success",
      );
    }
  });
}
```

Update the two call sites to pass `triggeredBy`:

```typescript
// In verifyPayment:
await this.capturePaymentSuccess(orderId, paymentId, signature, "api:verify_payment");

// In handleWebhook:
await this.capturePaymentSuccess(orderId, paymentId, "webhook_verified", `webhook:${event}`);
```

### 4c. `handleWebhook` — log the `failed` transition

In the `payment.failed` branch, add the audit write after updating the payment row:

```typescript
const payment = await this.prisma.payments.update({
  where: { order_id: orderId },
  data: {
    status: "failed",
    error_code: paymentEntity.error_code,
    error_description: paymentEntity.error_description,
  },
  include: { bookings: true },
});

// Audit: record the failure
await this.writeAuditLog(
  this.prisma,
  payment.id,
  orderId,
  "created",
  "failed",
  "webhook:payment.failed",
  paymentId,
  {
    error_code: paymentEntity.error_code,
    error_description: paymentEntity.error_description,
  },
);
```

---

## Step 5 — Add a Query Endpoint (Optional but Recommended)

Expose the audit trail to admins via the controller:

```typescript
// payments.controller.ts
import { Get, Param, UseGuards } from "@nestjs/common";

@Get("audit/:orderId")
@UseGuards(AdminGuard)  // protect with your existing admin guard
@ApiOperation({ summary: 'Get the full audit trail for a payment order' })
async getAuditLog(@Param("orderId") orderId: string) {
  return this.paymentsService.getAuditLog(orderId);
}
```

```typescript
// payments.service.ts
async getAuditLog(orderId: string) {
  return this.prisma.payment_audit_log.findMany({
    where: { order_id: orderId },
    orderBy: { created_at: "asc" },
  });
}
```

Sample response for a successful payment:

```json
[
  {
    "id": "...",
    "order_id": "order_ABC123",
    "from_status": null,
    "to_status": "created",
    "triggered_by": "api:create_order",
    "razorpay_payment_id": null,
    "metadata": {},
    "created_at": "2026-03-14T10:00:00Z"
  },
  {
    "id": "...",
    "order_id": "order_ABC123",
    "from_status": "created",
    "to_status": "captured",
    "triggered_by": "api:verify_payment",
    "razorpay_payment_id": "pay_XYZ789",
    "metadata": { "amount": 500, "currency": "INR" },
    "created_at": "2026-03-14T10:02:15Z"
  }
]
```

---

## Step 6 — Update the Spec

The existing test in `payments.service.spec.ts` calls `capturePaymentSuccess` directly. Since it now takes four parameters, add `mockPrisma.payment_audit_log` and update the call:

```typescript
const mockPrisma = {
  payments: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
  bookings: { findUnique: jest.fn(), update: jest.fn() },
  payment_audit_log: { create: jest.fn() },   // ← add this
  $transaction: jest.fn().mockImplementation((cb: (tx: any) => any) => cb(mockPrisma)),
};
```

```typescript
// In the test body:
await (service as any).capturePaymentSuccess(
  orderId, paymentId, "sig_123",
  "api:verify_payment"   // ← new argument
);
```

Run the suite to confirm:

```bash
npx jest payments.service.spec --verbose
```

---

## Disaster Recovery Queries

Once the table exists, use these SQL queries to investigate issues:

```sql
-- Full history for a single order
SELECT * FROM payment_audit_log
WHERE order_id = 'order_ABC123'
ORDER BY created_at;

-- All failed payments in the last 7 days
SELECT pal.*, p.booking_id
FROM payment_audit_log pal
JOIN payments p ON p.id = pal.payment_id
WHERE pal.to_status = 'failed'
  AND pal.created_at > now() - interval '7 days';

-- Detect duplicate capture attempts (possible webhook replay attacks)
SELECT order_id, COUNT(*) AS attempts
FROM payment_audit_log
WHERE triggered_by LIKE '%:duplicate'
GROUP BY order_id
HAVING COUNT(*) > 1;

-- Payments stuck in 'created' for more than 24 hours (abandoned orders)
SELECT p.order_id, p.booking_id, p.amount, min(pal.created_at) AS initiated_at
FROM payments p
JOIN payment_audit_log pal ON pal.payment_id = p.id
WHERE p.status = 'created'
GROUP BY p.order_id, p.booking_id, p.amount
HAVING min(pal.created_at) < now() - interval '24 hours';
```

---

## Summary of Changes

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `payment_audit_log` model + reverse relation on `payments` |
| `prisma/migrations/<ts>_add_payment_audit_log/migration.sql` | Auto-generated by `prisma migrate dev` |
| `src/payments/payments.service.ts` | Add `writeAuditLog` helper; instrument `createOrder`, `capturePaymentSuccess` (+ new param), `handleWebhook` |
| `src/payments/payments.controller.ts` | Add `GET /payments/audit/:orderId` admin endpoint |
| `src/payments/payments.service.spec.ts` | Add `payment_audit_log` mock; pass `triggeredBy` to `capturePaymentSuccess` |

import { Test, TestingModule } from "@nestjs/testing";
import { BookingListeners } from "./booking.listeners";
import { ChatService } from "../../chat/chat.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { MailService } from "../../mail/mail.service";
import { SseService } from "../../sse/sse.service";
import { PrismaService } from "../../prisma/prisma.service";
import { PaymentsService } from "../../payments/payments.service";
import { BookingCompletedEvent, PlanWoundDownEvent } from "../events/booking.events";
import { SSE_EVENTS } from "../../events/sse-event.types";

/**
 * Completion is where a booking's money is reconciled: captured charges become a
 * payout accrual, a booking with nothing captured gets a placeholder so the
 * caregiver is still owed, and the parent is told whether they still have to pay.
 *
 * All three used to be fooled by the matching fee. It is a real captured payment
 * on the booking, so a one-time session whose parent had paid only the ₹249
 * placement fee looked, at completion, exactly like a session that had been paid
 * in full — no prompt, and a ₹249 payout instead of the session's value.
 */
describe("BookingListeners — booking completed", () => {
  let listeners: BookingListeners;

  const booking = {
    id: "book_1",
    parent_id: "parent-1",
    nanny_id: "nanny-1",
  } as any;

  const mockPrisma = {
    payments: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
    },
    payment_installments: {
      count: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const mockPaymentsService = { updatePaymentStatus: jest.fn().mockResolvedValue({}) };
  const mockSseService = { emitToUsers: jest.fn(), emitToUser: jest.fn() };
  const mockNotificationsService = {
    createNotification: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.payment_installments.count.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingListeners,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PaymentsService, useValue: mockPaymentsService },
        { provide: SseService, useValue: mockSseService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: ChatService, useValue: {} },
        { provide: MailService, useValue: {} },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    listeners = module.get<BookingListeners>(BookingListeners);
  });

  const complete = (totalAmount = 5940) =>
    listeners.handleBookingCompleted(new BookingCompletedEvent(booking, totalAmount));

  const sseEvent = () =>
    mockSseService.emitToUsers.mock.calls.find(
      ([, payload]) => payload?.type === SSE_EVENTS.BOOKING_COMPLETED,
    )?.[1];

  it("excludes matching-fee payments when looking for what the parent has paid", async () => {
    mockPrisma.payments.findMany.mockResolvedValue([]);
    mockPrisma.payments.findFirst.mockResolvedValue(null);

    await complete();

    for (const call of [
      mockPrisma.payments.findMany.mock.calls[0][0],
      mockPrisma.payments.findFirst.mock.calls[0][0],
    ]) {
      expect(call.where.payment_installments).toEqual({
        none: { kind: "matching_fee" },
      });
    }
  });

  it("still asks the parent to pay when only the matching fee has been collected", async () => {
    // The fee is filtered out, so both reads come back empty — the session itself
    // has not been paid for and the drawer has to say so.
    mockPrisma.payments.findMany.mockResolvedValue([]);
    mockPrisma.payments.findFirst.mockResolvedValue(null);

    await complete();

    expect(sseEvent()?.data.paymentDue).toBe(true);
  });

  it("accrues the session's value, not the fee, when only the fee was collected", async () => {
    mockPrisma.payments.findMany.mockResolvedValue([]);
    mockPrisma.payments.findFirst.mockResolvedValue(null);

    await complete(5940);

    expect(mockPrisma.payments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: 5940, nanny_id: "nanny-1" }),
      }),
    );
    // The fee is never moved to pending_release: it is not care the caregiver is owed for.
    expect(mockPaymentsService.updatePaymentStatus).not.toHaveBeenCalled();
  });

  it("releases a real captured charge and writes no placeholder beside it", async () => {
    mockPrisma.payments.findMany.mockResolvedValue([{ id: "pay_1" }]);
    mockPrisma.payments.findFirst.mockResolvedValue({ id: "pay_1", status: "captured" });

    await complete();

    expect(mockPaymentsService.updatePaymentStatus).toHaveBeenCalledWith(
      "pay_1",
      "pending_release",
      "bookings:booking_completed",
      { booking_id: booking.id },
    );
    expect(mockPrisma.payments.create).not.toHaveBeenCalled();
    expect(sseEvent()?.data.paymentDue).toBe(false);
  });

  it("keeps prompting while a cycle balance is outstanding", async () => {
    mockPrisma.payments.findMany.mockResolvedValue([{ id: "pay_adv" }]);
    mockPrisma.payments.findFirst.mockResolvedValue({ id: "pay_adv", status: "captured" });
    mockPrisma.payment_installments.count.mockResolvedValue(1);

    await complete();

    expect(sseEvent()?.data.paymentDue).toBe(true);
  });
});

/**
 * A plan dropping forty sessions must not mean forty emails to the same two
 * people. The per-booking cancellation handler is deliberately not reused for a
 * plan wind-down; this pins that down.
 */
describe("BookingListeners — plan wound down", () => {
  let listeners: BookingListeners;

  const mockPrisma = {
    users: { findUnique: jest.fn() },
  };
  const mockChatService = { deleteChatByBookingId: jest.fn().mockResolvedValue(undefined) };
  const mockMailService = { sendCancellationEmail: jest.fn().mockResolvedValue(undefined) };
  const mockNotificationsService = {
    createNotification: jest.fn().mockResolvedValue(undefined),
  };

  const cancelledIds = Array.from({ length: 40 }, (_, i) => `b${i + 1}`);

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.users.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      email: `${where.id}@example.com`,
      profiles: { first_name: "A", last_name: "B" },
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingListeners,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PaymentsService, useValue: {} },
        { provide: SseService, useValue: { emitToUsers: jest.fn(), emitToUser: jest.fn() } },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: ChatService, useValue: mockChatService },
        { provide: MailService, useValue: mockMailService },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    listeners = module.get<BookingListeners>(BookingListeners);
  });

  const woundDown = (retainedCount = 7) =>
    listeners.handlePlanWoundDown(
      new PlanWoundDownEvent("plan-1", "parent-1", "nanny-1", cancelledIds, retainedCount, "Changed plans"),
    );

  it("emails each party once, however many sessions were dropped", async () => {
    await woundDown();

    expect(mockMailService.sendCancellationEmail).toHaveBeenCalledTimes(2);
  });

  it("notifies the parent, who was previously never told at all", async () => {
    await woundDown();

    const recipients = mockNotificationsService.createNotification.mock.calls.map((c) => c[0]);
    expect(recipients).toContain("parent-1");
    expect(recipients).toContain("nanny-1");
    expect(mockNotificationsService.createNotification).toHaveBeenCalledTimes(2);
  });

  it("tells the parent their paid-for sessions survive", async () => {
    await woundDown(7);

    const parentCall = mockNotificationsService.createNotification.mock.calls.find(
      (c) => c[0] === "parent-1",
    );
    expect(parentCall?.[2]).toContain("7 sessions you have already paid for");
  });

  it("cleans up only the dropped sessions' chats, not the retained ones", async () => {
    await woundDown();

    expect(mockChatService.deleteChatByBookingId).toHaveBeenCalledTimes(cancelledIds.length);
    expect(mockChatService.deleteChatByBookingId).not.toHaveBeenCalledWith("retained-1");
  });

  it("still notifies when the plan had no caregiver", async () => {
    await listeners.handlePlanWoundDown(
      new PlanWoundDownEvent("plan-1", "parent-1", null, cancelledIds, 0, undefined),
    );

    expect(mockNotificationsService.createNotification).toHaveBeenCalledTimes(1);
    expect(mockMailService.sendCancellationEmail).toHaveBeenCalledTimes(1);
  });
});

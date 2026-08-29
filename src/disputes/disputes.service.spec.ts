import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DisputesService } from "./disputes.service";
import { PrismaService } from "../prisma/prisma.service";
import { PaymentsService } from "../payments/payments.service";
import { NotificationsService } from "../notifications/notifications.service";
import { DisputeOutcome } from "./dto/resolve-dispute.dto";
import { PaymentStatus } from "../constants";

describe("DisputesService", () => {
  let service: DisputesService;
  let prisma: any;
  let payments: any;
  let notifications: any;

  beforeEach(async () => {
    prisma = {
      bookings: { findUnique: jest.fn() },
      disputes: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payments: {
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    payments = { refundPayment: jest.fn() };
    notifications = { createNotification: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentsService, useValue: payments },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(DisputesService);
  });

  describe("create", () => {
    it("rejects disputes on bookings the user is not part of", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b1",
        parent_id: "p1",
        nanny_id: "n1",
      });
      await expect(
        service.create("stranger", { bookingId: "b1", reason: "x" } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a second open dispute on the same booking by the same user", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b1",
        parent_id: "p1",
        nanny_id: "n1",
      });
      prisma.disputes.findFirst.mockResolvedValue({ id: "d0" });
      await expect(
        service.create("p1", { bookingId: "b1", reason: "x" } as any),
      ).rejects.toThrow("already have an open dispute");
      expect(prisma.disputes.create).not.toHaveBeenCalled();
    });

    it("creates when no open dispute exists", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b1",
        parent_id: "p1",
        nanny_id: "n1",
      });
      prisma.disputes.findFirst.mockResolvedValue(null);
      prisma.disputes.create.mockResolvedValue({ id: "d1" });
      await expect(
        service.create("p1", { bookingId: "b1", reason: "x" } as any),
      ).resolves.toEqual({ id: "d1" });
    });
  });

  describe("resolve", () => {
    const openDispute = (payments: any[]) => ({
      id: "d1",
      status: "open",
      raised_by: "p1",
      bookings: { payments },
    });

    it("throws NotFound for a missing dispute", async () => {
      prisma.disputes.findUnique.mockResolvedValue(null);
      await expect(
        service.resolve("d1", "admin", {
          resolution: "r",
          outcome: DisputeOutcome.NO_ACTION,
        } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it("loses the race when another admin claims first (updateMany count 0)", async () => {
      prisma.disputes.findUnique.mockResolvedValue(openDispute([]));
      prisma.disputes.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.resolve("d1", "admin", {
          resolution: "r",
          outcome: DisputeOutcome.NO_ACTION,
        } as any),
      ).rejects.toThrow("already resolved");
      expect(payments.refundPayment).not.toHaveBeenCalled();
    });

    it("refunds the CAPTURED payment, not payments[0]", async () => {
      prisma.disputes.findUnique.mockResolvedValue(
        openDispute([
          { id: "pay-abandoned", status: PaymentStatus.CREATED },
          { id: "pay-real", status: PaymentStatus.CAPTURED },
        ]),
      );
      prisma.disputes.findUnique.mockResolvedValueOnce(
        openDispute([
          { id: "pay-abandoned", status: PaymentStatus.CREATED },
          { id: "pay-real", status: PaymentStatus.CAPTURED },
        ]),
      );
      await service.resolve("d1", "admin", {
        resolution: "refund it",
        outcome: DisputeOutcome.REFUND,
      } as any);
      expect(payments.refundPayment).toHaveBeenCalledWith("pay-real", undefined);
    });

    it("refuses a refund/release outcome when nothing is captured", async () => {
      prisma.disputes.findUnique.mockResolvedValue(
        openDispute([{ id: "pay-1", status: PaymentStatus.CREATED }]),
      );
      await expect(
        service.resolve("d1", "admin", {
          resolution: "refund",
          outcome: DisputeOutcome.REFUND,
        } as any),
      ).rejects.toThrow("no captured payment");
      expect(prisma.disputes.updateMany).not.toHaveBeenCalled();
    });

    it("reopens the dispute when the refund fails", async () => {
      prisma.disputes.findUnique.mockResolvedValue(
        openDispute([{ id: "pay-1", status: PaymentStatus.CAPTURED }]),
      );
      payments.refundPayment.mockRejectedValue(new Error("gateway down"));
      await expect(
        service.resolve("d1", "admin", {
          resolution: "refund",
          outcome: DisputeOutcome.REFUND,
        } as any),
      ).rejects.toThrow("could not be processed");
      expect(prisma.disputes.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "d1", status: "resolved" },
          data: expect.objectContaining({ status: "open" }),
        }),
      );
    });

    it("releases via a guarded updateMany from CAPTURED", async () => {
      prisma.disputes.findUnique.mockResolvedValue(
        openDispute([{ id: "pay-1", status: PaymentStatus.CAPTURED }]),
      );
      await service.resolve("d1", "admin", {
        resolution: "release",
        outcome: DisputeOutcome.RELEASE,
      } as any);
      expect(prisma.payments.updateMany).toHaveBeenCalledWith({
        where: { id: "pay-1", status: PaymentStatus.CAPTURED },
        data: { status: PaymentStatus.PENDING_RELEASE },
      });
      expect(prisma.payments.update).not.toHaveBeenCalled();
    });

    it("reopens and throws when release finds the payment no longer captured", async () => {
      prisma.disputes.findUnique.mockResolvedValue(
        openDispute([{ id: "pay-1", status: PaymentStatus.CAPTURED }]),
      );
      prisma.payments.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.resolve("d1", "admin", {
          resolution: "release",
          outcome: DisputeOutcome.RELEASE,
        } as any),
      ).rejects.toThrow("no longer in a releasable state");
    });

    it("notifies the raiser after resolution", async () => {
      prisma.disputes.findUnique.mockResolvedValue(openDispute([]));
      await service.resolve("d1", "admin", {
        resolution: "closing",
        outcome: DisputeOutcome.NO_ACTION,
      } as any);
      expect(notifications.createNotification).toHaveBeenCalledWith(
        "p1",
        expect.any(String),
        expect.stringContaining("closing"),
        "info",
        "dispute",
        "d1",
      );
    });
  });
});

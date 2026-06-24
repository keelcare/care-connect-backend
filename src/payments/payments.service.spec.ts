import { Test, TestingModule } from "@nestjs/testing";
import { PaymentsService } from "./payments.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ConfigService } from "@nestjs/config";
import { PaymentGatewayService } from "./payment-gateway.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PricingEngineService } from "../common/pricing.service";

describe("PaymentsService", () => {
  let service: PaymentsService;
  let notificationsService: NotificationsService;

  const mockPrisma = {
    payments: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    bookings: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    payment_audit_log: {
      create: jest.fn(),
    },
    price_snapshots: {
      updateMany: jest.fn(),
    },
    payment_plans: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest
      .fn()
      .mockImplementation((cb: (tx: any) => any) => cb(mockPrisma)),
  };

  const mockNotificationsService = {
    createNotification: jest.fn(),
  };

  const mockPaymentGatewayService = {
    createOrder: jest.fn(),
    verifySignature: jest.fn(),
    verifyWebhookSignature: jest.fn(),
  };

  const mockPaymentAuditService = {
    writeLog: jest.fn(),
  };

  const mockPricingService = {
    calculateCost: jest.fn(),
    calculateAndSnapshot: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: PaymentGatewayService, useValue: mockPaymentGatewayService },
        { provide: PaymentAuditService, useValue: mockPaymentAuditService },
        { provide: PricingEngineService, useValue: mockPricingService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === "RAZORPAY_KEY_ID") return "rzp_test_key";
              if (key === "RAZORPAY_KEY_SECRET") return "rzp_test_secret";
              if (key === "RAZORPAY_WEBHOOK_SECRET")
                return "rzp_test_webhook_secret";
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    notificationsService =
      module.get<NotificationsService>(NotificationsService);
  });

  it("should notify parent and nanny on successful payment capture", async () => {
    const orderId = "order_123";
    const paymentId = "pay_123";
    const bookingId = "book_123";

    mockPrisma.payments.findUnique.mockResolvedValue({
      order_id: orderId,
      booking_id: bookingId,
      amount: 1000,
      status: "created",
    });

    mockPrisma.bookings.update.mockResolvedValue({
      id: bookingId,
      parent_id: "parent-1",
      nanny_id: "nanny-1",
    });

    await (service as any).capturePaymentSuccess(
      orderId,
      paymentId,
      "sig_123",
      "api:verify_payment",
    );

    // Parent notification
    expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
      "parent-1",
      "Payment Successful",
      expect.stringContaining("1000"),
      "success",
    );

    // Nanny notification
    expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
      "nanny-1",
      "Payment Received",
      expect.stringContaining("₹1000"),
      "success",
    );
  });
});

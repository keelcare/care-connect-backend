import { Test, TestingModule } from "@nestjs/testing";
import { PaymentsService } from "./payments.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ConfigService } from "@nestjs/config";

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
        $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
    };

    const mockNotificationsService = {
        createNotification: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PaymentsService,
                { provide: PrismaService, useValue: mockPrisma },
                { provide: NotificationsService, useValue: mockNotificationsService },
                { provide: ConfigService, useValue: { get: jest.fn() } },
            ],
        }).compile();

        service = module.get<PaymentsService>(PaymentsService);
        notificationsService = module.get<NotificationsService>(NotificationsService);
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

        await (service as any).capturePaymentSuccess(orderId, paymentId, "sig_123");

        // Parent notification
        expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
            "parent-1",
            "Payment Successful",
            expect.stringContaining("1000"),
            "success"
        );

        // Nanny notification
        expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
            "nanny-1",
            "Payment Received",
            expect.stringContaining("₹1000"),
            "success"
        );
    });
});

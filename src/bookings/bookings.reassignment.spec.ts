
import { Test, TestingModule } from "@nestjs/testing";
import { BookingsService } from "./bookings.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ChatService } from "../chat/chat.service";
import { RequestsService } from "../requests/requests.service";
import { BadRequestException } from "@nestjs/common";

describe("BookingsService - Reassignment Logic", () => {
    let service: BookingsService;
    let prisma: PrismaService;
    let requestsService: RequestsService;

    const mockPrisma = {
        bookings: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        assignments: {
            findFirst: jest.fn(),
            update: jest.fn(),
        },
        service_requests: {
            update: jest.fn(),
        },
    };

    const mockRequestsService = {
        triggerMatching: jest.fn().mockResolvedValue(true),
    };

    const mockNotificationsService = {
        createNotification: jest.fn(),
    };

    const mockChatService = {
        createChat: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BookingsService,
                { provide: PrismaService, useValue: mockPrisma },
                { provide: NotificationsService, useValue: mockNotificationsService },
                { provide: ChatService, useValue: mockChatService },
                { provide: RequestsService, useValue: mockRequestsService },
            ],
        }).compile();

        service = module.get<BookingsService>(BookingsService);
        prisma = module.get<PrismaService>(PrismaService);
        requestsService = module.get<RequestsService>(RequestsService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("should handle nanny cancellation correctly for random assignment", async () => {
        const bookingId = "booking-1";
        const nannyId = "nanny-1";
        const requestId = "request-1";
        const parentId = "parent-1";
        const assignmentId = "assignment-1";

        // Mock Booking Found
        mockPrisma.bookings.findUnique.mockResolvedValue({
            id: bookingId,
            nanny_id: nannyId,
            request_id: requestId,
            parent_id: parentId,
            status: "CONFIRMED",
            start_time: new Date(),
        });

        // Mock Assignment Found
        mockPrisma.assignments.findFirst.mockResolvedValue({
            id: assignmentId,
            status: "accepted",
        });

        // Mock Updates
        mockPrisma.bookings.update.mockResolvedValue({ id: bookingId, status: "requested" });
        mockPrisma.assignments.update.mockResolvedValue({ id: assignmentId, status: "rejected" });
        mockPrisma.service_requests.update.mockResolvedValue({ id: requestId, status: "pending" });

        // Execute
        await service.cancelBooking(bookingId, "Emergency", nannyId);

        // Verify Assignment Rejected
        expect(mockPrisma.assignments.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: assignmentId },
            data: expect.objectContaining({ status: "rejected" }),
        }));

        // Verify Booking Reverted
        expect(mockPrisma.bookings.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: bookingId },
            data: expect.objectContaining({
                status: "requested",
                nanny_id: null,
            }),
        }));

        // Verify Request Reset
        expect(mockPrisma.service_requests.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: requestId },
            data: expect.objectContaining({ status: "pending" }),
        }));

        // Verify Matching Triggered
        expect(mockRequestsService.triggerMatching).toHaveBeenCalledWith(requestId);
    });

    it("should NOT trigger re-matching if cancelled by parent", async () => {
        const bookingId = "booking-1";
        const nannyId = "nanny-1";
        const requestId = "request-1";
        const parentId = "parent-1";

        // Mock Booking Found
        mockPrisma.bookings.findUnique.mockResolvedValue({
            id: bookingId,
            nanny_id: nannyId,
            request_id: requestId,
            parent_id: parentId,
            status: "CONFIRMED",
            start_time: new Date(),
        });

        mockPrisma.bookings.update.mockResolvedValue({ id: bookingId, status: "CANCELLED" });

        // Execute with PARENT ID
        await service.cancelBooking(bookingId, "Changed my mind", parentId);

        // Verify Normal Cancellation
        expect(mockPrisma.bookings.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: bookingId },
            data: expect.objectContaining({ status: "CANCELLED" }),
        }));

        // Verify NO Matching
        expect(mockRequestsService.triggerMatching).not.toHaveBeenCalled();
    });
});

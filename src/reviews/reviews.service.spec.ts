import { Test, TestingModule } from "@nestjs/testing";
import { ReviewsService } from "./reviews.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";

describe("ReviewsService", () => {
  let service: ReviewsService;
  let prisma: any;
  let notificationsService: NotificationsService;

  beforeEach(async () => {
    prisma = {
      reviews: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      bookings: {
        findUnique: jest.fn(),
      },
      users: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: NotificationsService,
          useValue: {
            createNotification: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
    notificationsService =
      module.get<NotificationsService>(NotificationsService);
  });

  describe("createReview", () => {
    it("throws NotFoundException when booking does not exist", async () => {
      prisma.bookings.findUnique.mockResolvedValue(null);
      await expect(
        service.createReview(
          { bookingId: "b-1", rating: 5, comment: "Great" },
          "user-1",
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when booking is not COMPLETED", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "CONFIRMED",
        parent_id: "parent-1",
        nanny_id: "nanny-1",
      });
      await expect(
        service.createReview(
          { bookingId: "b-1", rating: 5, comment: "Great" },
          "parent-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when booking participants are incomplete", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "COMPLETED",
        parent_id: "parent-1",
        nanny_id: null,
      });
      await expect(
        service.createReview(
          { bookingId: "b-1", rating: 5, comment: "Great" },
          "parent-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when reviewer is not part of the booking", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "COMPLETED",
        parent_id: "parent-1",
        nanny_id: "nanny-1",
      });
      await expect(
        service.createReview(
          { bookingId: "b-1", rating: 5, comment: "Great" },
          "stranger-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when reviewer tries to review themselves", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "COMPLETED",
        parent_id: "user-1",
        nanny_id: "user-1",
      });
      await expect(
        service.createReview(
          { bookingId: "b-1", rating: 5, comment: "Great" },
          "user-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when user has already reviewed the booking", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "COMPLETED",
        parent_id: "parent-1",
        nanny_id: "nanny-1",
      });
      prisma.reviews.findFirst.mockResolvedValue({ id: "rev-1" });

      await expect(
        service.createReview(
          { bookingId: "b-1", rating: 5, comment: "Great" },
          "parent-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("auto-approves parent-to-nanny reviews and notifies the nanny", async () => {
      const mockReview = {
        id: "rev-1",
        booking_id: "b-1",
        reviewer_id: "parent-1",
        reviewee_id: "nanny-1",
        rating: 5,
        users_reviews_reviewer_idTousers: {
          profiles: { first_name: "Alice", last_name: "Smith" },
        },
      };
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "COMPLETED",
        parent_id: "parent-1",
        nanny_id: "nanny-1",
      });
      prisma.reviews.findFirst.mockResolvedValue(null);
      prisma.reviews.create.mockResolvedValue(mockReview);

      const result = await service.createReview(
        { bookingId: "b-1", rating: 5, comment: "Fantastic care" },
        "parent-1",
      );

      expect(prisma.reviews.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            is_approved: true,
            moderation_status: "approved",
            reviewer_role: "parent",
            rating: 5,
            comment: "Fantastic care",
          }),
        }),
      );
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        "nanny-1",
        "New Review Received",
        expect.stringContaining("Alice Smith"),
        "success",
      );
      expect(result).toEqual(mockReview);
    });

    it("holds nanny-to-parent reviews for moderation", async () => {
      const mockReview = {
        id: "rev-2",
        booking_id: "b-1",
        reviewer_id: "nanny-1",
        reviewee_id: "parent-1",
        rating: 4,
        users_reviews_reviewer_idTousers: {
          profiles: { first_name: "Bob", last_name: "Jones" },
        },
      };
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "COMPLETED",
        parent_id: "parent-1",
        nanny_id: "nanny-1",
      });
      prisma.reviews.findFirst.mockResolvedValue(null);
      prisma.reviews.create.mockResolvedValue(mockReview);

      await service.createReview(
        { bookingId: "b-1", rating: 4, comment: "Good family" },
        "nanny-1",
      );

      expect(prisma.reviews.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            is_approved: false,
            moderation_status: "pending",
            reviewer_role: "nanny",
          }),
        }),
      );
    });
  });

  describe("updateReview", () => {
    it("throws NotFoundException when review does not exist", async () => {
      prisma.reviews.findUnique.mockResolvedValue(null);
      await expect(
        service.updateReview("rev-1", { rating: 4 }, "user-1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when updating someone else's review", async () => {
      prisma.reviews.findUnique.mockResolvedValue({
        id: "rev-1",
        reviewer_id: "owner-1",
      });
      await expect(
        service.updateReview("rev-1", { rating: 4 }, "other-user"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("re-queues nanny review for moderation on content edit", async () => {
      prisma.reviews.findUnique.mockResolvedValue({
        id: "rev-1",
        reviewer_id: "nanny-1",
        reviewer_role: "nanny",
        is_approved: true,
        moderation_status: "approved",
      });
      prisma.reviews.update.mockResolvedValue({ id: "rev-1" });

      await service.updateReview("rev-1", { comment: "Updated text" }, "nanny-1");

      expect(prisma.reviews.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rev-1" },
          data: expect.objectContaining({
            comment: "Updated text",
            is_approved: false,
            moderation_status: "pending",
          }),
        }),
      );
    });

    it("does not re-queue parent review on content edit", async () => {
      prisma.reviews.findUnique.mockResolvedValue({
        id: "rev-1",
        reviewer_id: "parent-1",
        reviewer_role: "parent",
        is_approved: true,
        moderation_status: "approved",
      });
      prisma.reviews.update.mockResolvedValue({ id: "rev-1" });

      await service.updateReview("rev-1", { rating: 5 }, "parent-1");

      expect(prisma.reviews.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rev-1" },
          data: expect.objectContaining({
            rating: 5,
          }),
        }),
      );
      expect(prisma.reviews.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            is_approved: false,
          }),
        }),
      );
    });
  });

  describe("deleteReview", () => {
    it("throws NotFoundException when review does not exist", async () => {
      prisma.reviews.findUnique.mockResolvedValue(null);
      await expect(service.deleteReview("rev-1", "user-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ForbiddenException when deleting someone else's review", async () => {
      prisma.reviews.findUnique.mockResolvedValue({
        id: "rev-1",
        reviewer_id: "owner-1",
      });
      await expect(service.deleteReview("rev-1", "other-1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("deletes review when owned by user", async () => {
      prisma.reviews.findUnique.mockResolvedValue({
        id: "rev-1",
        reviewer_id: "owner-1",
      });
      prisma.reviews.delete.mockResolvedValue({ id: "rev-1" });

      const result = await service.deleteReview("rev-1", "owner-1");
      expect(prisma.reviews.delete).toHaveBeenCalledWith({
        where: { id: "rev-1" },
      });
      expect(result).toEqual({ message: "Review deleted successfully" });
    });
  });

  describe("public filtering", () => {
    it("filters is_approved: true on getReviewsForUser", async () => {
      prisma.reviews.findMany.mockResolvedValue([]);
      await service.getReviewsForUser("user-1");

      expect(prisma.reviews.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            reviewee_id: "user-1",
            is_approved: true,
          },
        }),
      );
    });

    it("filters is_approved: true on getReviewForBooking", async () => {
      prisma.reviews.findMany.mockResolvedValue([]);
      await service.getReviewForBooking("b-1");

      expect(prisma.reviews.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            booking_id: "b-1",
            is_approved: true,
          },
        }),
      );
    });

    it("filters is_approved: true on getReviewsWrittenByUser", async () => {
      prisma.reviews.findMany.mockResolvedValue([]);
      await service.getReviewsWrittenByUser("author-1");

      expect(prisma.reviews.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            reviewer_id: "author-1",
            is_approved: true,
          },
        }),
      );
    });
  });

  describe("canUserReviewBooking", () => {
    it("returns canReview: false when booking not completed", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "CONFIRMED",
        parent_id: "p-1",
        nanny_id: "n-1",
      });

      const result = await service.canUserReviewBooking("b-1", "p-1");
      expect(result.canReview).toBe(false);
      expect(result.reason).toBe("Booking must be completed before reviewing");
    });

    it("returns canReview: false when booking has missing participants", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "COMPLETED",
        parent_id: "p-1",
        nanny_id: null,
      });

      const result = await service.canUserReviewBooking("b-1", "p-1");
      expect(result.canReview).toBe(false);
      expect(result.reason).toBe("Booking participants are incomplete");
    });

    it("returns canReview: false when user is not part of booking", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "COMPLETED",
        parent_id: "p-1",
        nanny_id: "n-1",
      });

      const result = await service.canUserReviewBooking("b-1", "stranger-1");
      expect(result.canReview).toBe(false);
      expect(result.reason).toBe("You are not part of this booking");
    });

    it("returns canReview: true when all conditions are satisfied", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        status: "COMPLETED",
        parent_id: "p-1",
        nanny_id: "n-1",
      });
      prisma.reviews.findFirst.mockResolvedValue(null);

      const result = await service.canUserReviewBooking("b-1", "p-1");
      expect(result.canReview).toBe(true);
      expect(result.reason).toBeNull();
    });
  });
});

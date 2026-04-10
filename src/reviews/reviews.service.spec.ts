import { Test, TestingModule } from "@nestjs/testing";
import { ReviewsService } from "./reviews.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

describe("ReviewsService", () => {
  let service: ReviewsService;
  let notificationsService: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        {
          provide: PrismaService,
          useValue: {
            reviews: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
            },
            bookings: {
              findUnique: jest.fn(),
            },
          },
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

  it("should notify reviewee when a review is created", async () => {
    const mockReview = {
      booking_id: "book-1",
      reviewer_id: "rev-1",
      reviewee_id: "ree-1",
      rating: 5,
      users_reviews_reviewer_idTousers: {
        profiles: { first_name: "Jane", last_name: "Doe" },
      },
    };
    (service["prisma"].bookings.findUnique as jest.Mock).mockResolvedValue({
      id: "book-1",
      status: "COMPLETED",
      parent_id: "rev-1",
      nanny_id: "ree-1",
    });
    (service["prisma"].reviews.findFirst as jest.Mock).mockResolvedValue(null);
    (service["prisma"].reviews.create as jest.Mock).mockResolvedValue(
      mockReview,
    );

    await service.createReview(
      { bookingId: "book-1", rating: 5, comment: "Great!" },
      "rev-1",
    );

    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      "ree-1",
      "New Review Received",
      expect.stringContaining("Jane Doe"),
      "success",
    );
  });
});

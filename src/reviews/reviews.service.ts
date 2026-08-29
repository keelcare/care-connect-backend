import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateReviewDto } from "./dto/create-review.dto";
import { UpdateReviewDto } from "./dto/update-review.dto";
import { NotificationsService } from "../notifications/notifications.service";
import { BookingStatus } from "../common/constants/booking-status.enum";

@Injectable()
export class ReviewsService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  async createReview(createReviewDto: CreateReviewDto, reviewerId: string) {
    const { bookingId, rating, comment } = createReviewDto;

    // 1. Validate booking exists
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    // 2. Validate booking status (must be COMPLETED)
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new BadRequestException("Can only review completed bookings");
    }

    // 3. Determine reviewee (the other party) and reviewer's role
    if (!booking.parent_id || !booking.nanny_id) {
      throw new BadRequestException("Booking participants are incomplete");
    }

    let revieweeId: string;
    let reviewerRole: string;
    if (reviewerId === booking.parent_id) {
      revieweeId = booking.nanny_id;
      reviewerRole = "parent";
    } else if (reviewerId === booking.nanny_id) {
      revieweeId = booking.parent_id;
      reviewerRole = "nanny";
    } else {
      throw new BadRequestException("User is not part of this booking");
    }

    if (revieweeId === reviewerId) {
      throw new BadRequestException("You cannot review yourself");
    }

    // 4. Check if review already exists
    const existingReview = await this.prisma.reviews.findFirst({
      where: {
        booking_id: bookingId,
        reviewer_id: reviewerId,
      },
    });

    if (existingReview) {
      throw new BadRequestException("You have already reviewed this booking");
    }

    // 5. Create review (nanny reviews of parents are held for moderation)
    const isParentReview = reviewerRole === "parent";
    const review = await this.prisma.reviews.create({
      data: {
        booking_id: bookingId,
        reviewer_id: reviewerId,
        reviewee_id: revieweeId,
        reviewer_role: reviewerRole,
        rating,
        comment: comment?.trim() || null,
        // Nanny → Parent reviews require admin moderation before appearing on parent profile
        is_approved: isParentReview ? true : false,
        moderation_status: isParentReview ? "approved" : "pending",
      },
      include: {
        users_reviews_reviewee_idTousers: {
          select: {
            id: true,
            role: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
                profile_image_url: true,
              },
            },
          },
        },
        users_reviews_reviewer_idTousers: {
          select: {
            profiles: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
        },
      },
    });

    // 6. Notify Reviewee
    const reviewerName = review.users_reviews_reviewer_idTousers?.profiles
      ? `${review.users_reviews_reviewer_idTousers.profiles.first_name} ${review.users_reviews_reviewer_idTousers.profiles.last_name}`
      : "Someone";

    await this.notificationsService.createNotification(
      revieweeId,
      "New Review Received",
      `${reviewerName} left you a ${rating}-star review for booking #${bookingId}.`,
      "success",
    );

    return review;
  }

  async updateReview(
    reviewId: string,
    updateReviewDto: UpdateReviewDto,
    userId: string,
  ) {
    // 1. Find the review
    const review = await this.prisma.reviews.findUnique({
      where: { id: reviewId },
    });

    if (!review) {
      throw new NotFoundException("Review not found");
    }

    // 2. Check if user is the reviewer
    if (review.reviewer_id !== userId) {
      throw new ForbiddenException("You can only update your own reviews");
    }

    // 3. Update the review.
    //
    // Editing content that needed moderation sends it back through moderation.
    // Without this, an author could get a mild review approved and then rewrite
    // it to anything — the approval would still stand, which is exactly the
    // bypass the pending state exists to prevent. Only reviews that were
    // moderated in the first place are re-queued, so a parent→nanny review
    // (auto-approved on create) is unaffected.
    const editsContent =
      updateReviewDto.rating !== undefined || updateReviewDto.comment !== undefined;
    // Same rule as createReview: caregiver→parent reviews are the moderated ones.
    const requiresRemoderation = editsContent && review.reviewer_role === "nanny";

    return this.prisma.reviews.update({
      where: { id: reviewId },
      data: {
        ...updateReviewDto,
        ...(updateReviewDto.comment !== undefined
          ? { comment: updateReviewDto.comment?.trim() || null }
          : {}),
        ...(requiresRemoderation
          ? { is_approved: false, moderation_status: "pending" }
          : {}),
      },
      include: {
        users_reviews_reviewee_idTousers: {
          select: {
            id: true,
            role: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
                profile_image_url: true,
              },
            },
          },
        },
      },
    });
  }

  async deleteReview(reviewId: string, userId: string) {
    // 1. Find the review
    const review = await this.prisma.reviews.findUnique({
      where: { id: reviewId },
    });

    if (!review) {
      throw new NotFoundException("Review not found");
    }

    // 2. Check if user is the reviewer
    if (review.reviewer_id !== userId) {
      throw new ForbiddenException("You can only delete your own reviews");
    }

    // 3. Delete the review
    await this.prisma.reviews.delete({
      where: { id: reviewId },
    });

    return { message: "Review deleted successfully" };
  }

  /**
   * Reviews displayed on someone's public profile.
   *
   * Only approved reviews are returned. Caregiver→parent reviews are created
   * `is_approved: false, moderation_status: "pending"` precisely so an admin
   * sees them first, but every read path here was unfiltered *and* the routes
   * are unauthenticated — so a pending or admin-rejected review (exactly the
   * content moderation exists to catch) was publicly readable the moment it was
   * written. `getReviewsForNanny`/`getReviewsForParent` both delegate here, so
   * this one filter covers all three public paths.
   */
  async getReviewsForUser(userId: string) {
    return this.prisma.reviews.findMany({
      where: {
        reviewee_id: userId,
        is_approved: true,
      },
      include: {
        users_reviews_reviewer_idTousers: {
          select: {
            id: true,
            role: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
                profile_image_url: true,
              },
            },
          },
        },
        bookings: {
          select: {
            id: true,
            start_time: true,
            end_time: true,
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });
  }

  async getReviewsForNanny(nannyId: string) {
    // Verify the user is a nanny
    const user = await this.prisma.users.findUnique({
      where: { id: nannyId },
      select: { role: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (user.role !== "nanny") {
      throw new BadRequestException("User is not a nanny");
    }

    return this.getReviewsForUser(nannyId);
  }

  async getReviewsForParent(parentId: string) {
    // Verify the user is a parent
    const user = await this.prisma.users.findUnique({
      where: { id: parentId },
      select: { role: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (user.role !== "parent") {
      throw new BadRequestException("User is not a parent");
    }

    return this.getReviewsForUser(parentId);
  }

  async getReviewForBooking(bookingId: string) {
    return this.prisma.reviews.findMany({
      where: {
        booking_id: bookingId,
        is_approved: true,
      },
      include: {
        users_reviews_reviewer_idTousers: {
          select: {
            id: true,
            role: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
                profile_image_url: true,
              },
            },
          },
        },
        users_reviews_reviewee_idTousers: {
          select: {
            id: true,
            role: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
        },
      },
    });
  }

  async canUserReviewBooking(bookingId: string, userId: string) {
    // 1. Check if booking exists
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    // 2. Check if user is part of the booking
    const isPartOfBooking =
      booking.parent_id === userId || booking.nanny_id === userId;

    if (!isPartOfBooking) {
      return {
        canReview: false,
        reason: "You are not part of this booking",
      };
    }

    if (!booking.parent_id || !booking.nanny_id || booking.parent_id === booking.nanny_id) {
      return {
        canReview: false,
        reason: "Booking participants are incomplete",
      };
    }

    // 3. Check if booking is completed
    if (booking.status !== BookingStatus.COMPLETED) {
      return {
        canReview: false,
        reason: "Booking must be completed before reviewing",
      };
    }

    // 4. Check if user has already reviewed
    const existingReview = await this.prisma.reviews.findFirst({
      where: {
        booking_id: bookingId,
        reviewer_id: userId,
      },
    });

    if (existingReview) {
      return {
        canReview: false,
        reason: "You have already reviewed this booking",
        existingReview,
      };
    }

    return {
      canReview: true,
      reason: null,
    };
  }

  async getReviewsWrittenByUser(userId: string) {
    return this.prisma.reviews.findMany({
      where: {
        reviewer_id: userId,
        is_approved: true,
      },
      include: {
        users_reviews_reviewee_idTousers: {
          select: {
            id: true,
            role: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
                profile_image_url: true,
              },
            },
          },
        },
        bookings: {
          select: {
            id: true,
            start_time: true,
            end_time: true,
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });
  }
}

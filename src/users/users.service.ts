import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { Prisma } from "@prisma/client";
import { users, profiles } from "@prisma/client";
import { UpdateUserDto } from "./dto/update-user.dto";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) { }

  // Auth-related methods
  async create(
    data: Prisma.usersCreateInput,
  ): Promise<users & { profiles: profiles | null }> {
    return this.prisma.users.create({
      data,
      include: {
        profiles: true,
      },
    });
  }

  async findOneByEmail(email: string): Promise<users | null> {
    return this.prisma.users.findUnique({
      where: { email },
    });
  }

  async findUserForAuth(email: string) {
    return this.prisma.users.findUnique({
      where: { email },
      include: {
        profiles: {
          select: {
            first_name: true,
            last_name: true,
            profile_image_url: true,
          },
        },
      },
    });
  }

  async findByOAuth(provider: string, providerId: string) {
    return this.prisma.users.findUnique({
      where: {
        oauth_provider_oauth_provider_id: {
          oauth_provider: provider,
          oauth_provider_id: providerId,
        },
      },
      include: {
        profiles: {
          select: {
            first_name: true,
            last_name: true,
            profile_image_url: true,
          },
        },
      },
    });
  }

  async findByVerificationToken(token: string): Promise<users | null> {
    return this.prisma.users.findFirst({
      where: { verification_token: token },
    });
  }

  async findByResetToken(token: string): Promise<users | null> {
    return this.prisma.users.findFirst({
      where: { reset_password_token: token },
    });
  }

  // Profile management methods
  async findAllNannies() {
    const nannies = await this.prisma.users.findMany({
      where: {
        role: "nanny",
        // identity_verification_status: "verified", // Relaxed for testing
      },
      include: {
        profiles: true,
        nanny_details: true,
      },
      orderBy: {
        created_at: "desc",
      },
    });

    // Calculate average rating for each nanny
    const nanniesWithRatings = await Promise.all(
      nannies.map(async (nanny) => {
        const reviews = await this.prisma.reviews.findMany({
          where: { reviewee_id: nanny.id },
          select: { rating: true },
        });

        const totalReviews = reviews.length;
        const averageRating =
          totalReviews > 0
            ? Math.round(
              (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) /
                totalReviews) *
              10,
            ) / 10
            : null;

        // Exclude sensitive fields
        const {
          password_hash,
          oauth_access_token,
          oauth_refresh_token,
          verification_token,
          reset_password_token,
          verification_token_expires,
          reset_password_token_expires,
          ...nannyData
        } = nanny;

        return {
          ...nannyData,
          averageRating,
          totalReviews,
        };
      }),
    );

    return nanniesWithRatings;
  }

  async findMe(id: string) {
    const user = await this.prisma.users.findUnique({
      where: { id },
      include: {
        profiles: true,
        nanny_details: true,
        children: {
          orderBy: { created_at: "desc" },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    // Exclude sensitive fields
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {
      password_hash,
      oauth_access_token,
      oauth_refresh_token,
      verification_token,
      reset_password_token,
      verification_token_expires,
      reset_password_token_expires,
      ...result
    } = user;

    return result;
  }

  async findOne(id: string) {
    const user = await this.prisma.users.findUnique({
      where: { id },
      include: {
        profiles: true,
        nanny_details: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    // If user is a nanny, include average rating
    if (user.role === "nanny") {
      const reviews = await this.prisma.reviews.findMany({
        where: { reviewee_id: id },
        select: { rating: true },
      });

      const totalReviews = reviews.length;
      const averageRating =
        totalReviews > 0
          ? Math.round(
            (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) /
              totalReviews) *
            10,
          ) / 10
          : null;

      return {
        ...user,
        averageRating,
        totalReviews,
      };
    }

    return user;
  }

  async findFullUserById(id: string) {
    const user = await this.prisma.users.findUnique({
      where: { id },
    });
    this.logger.debug(
      `findFullUserById(${id}) - refresh_token_hash exists: ${!!user?.refresh_token_hash}`,
    );
    return user;
  }

  async findFullUserByEmail(email: string) {
    const user = await this.prisma.users.findUnique({
      where: { email },
    });
    this.logger.debug(
      `findFullUserByEmail(${email}) - refresh_token_hash exists: ${!!user?.refresh_token_hash}`,
    );
    return user;
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto | Prisma.usersUpdateInput,
  ) {
    // Handle both UpdateUserDto and Prisma.usersUpdateInput
    // Check if any UpdateUserDto fields are present
    const isUpdateUserDto =
      updateUserDto &&
      typeof updateUserDto === "object" &&
      ("firstName" in updateUserDto ||
        "lastName" in updateUserDto ||
        "phone" in updateUserDto ||
        "address" in updateUserDto ||
        "lat" in updateUserDto ||
        "lng" in updateUserDto ||
        "profileImageUrl" in updateUserDto ||
        "skills" in updateUserDto ||
        "experienceYears" in updateUserDto ||
        "hourlyRate" in updateUserDto ||
        "bio" in updateUserDto ||
        "availabilitySchedule" in updateUserDto);

    if (isUpdateUserDto) {
      // Handle UpdateUserDto
      const dto = updateUserDto as UpdateUserDto;
      const {
        firstName,
        lastName,
        phone,
        address,
        lat,
        lng,
        profileImageUrl,
        skills,
        experienceYears,
        bio,
        availabilitySchedule,
      } = dto;

      // Update basic profile info
      if (
        firstName ||
        lastName ||
        phone ||
        address ||
        lat ||
        lng ||
        profileImageUrl
      ) {
        await this.prisma.profiles.upsert({
          where: { user_id: id },
          update: {
            first_name: firstName,
            last_name: lastName,
            phone,
            address: address,
            lat,
            lng,
            profile_image_url: profileImageUrl,
            updated_at: new Date(),
          },
          create: {
            user_id: id,
            first_name: firstName,
            last_name: lastName,
            phone,
            address: address,
            lat,
            lng,
            profile_image_url: profileImageUrl,
          },
        });
      }

      // Update nanny details if provided
      if (skills || experienceYears || bio || availabilitySchedule) {
        await this.prisma.nanny_details.upsert({
          where: { user_id: id },
          update: {
            skills: skills,
            experience_years: experienceYears,
            bio,
            availability_schedule: availabilitySchedule,
            updated_at: new Date(),
          },
          create: {
            user_id: id,
            skills: skills || [],
            experience_years: experienceYears,
            bio,
            availability_schedule: availabilitySchedule,
          },
        });
      }

      return this.findOne(id);
    } else {
      // Handle Prisma.usersUpdateInput (for auth updates)
      return this.prisma.users.update({
        where: { id },
        data: updateUserDto as Prisma.usersUpdateInput,
        include: {
          profiles: true,
        },
      });
    }
  }

  async uploadImage(id: string, fileUrl: string) {
    return this.prisma.profiles.upsert({
      where: { user_id: id },
      update: {
        profile_image_url: fileUrl,
        updated_at: new Date(),
      },
      create: {
        user_id: id,
        profile_image_url: fileUrl,
      },
    });
  }

  async updatePushToken(id: string, token: string) {
    return this.prisma.users.update({
      where: { id },
      data: { fcm_token: token },
    });
  }

  async completeOnboarding(userId: string) {
    return this.prisma.profiles.upsert({
      where: { user_id: userId },
      update: { onboarding_completed: true },
      create: { user_id: userId, onboarding_completed: true },
    });
  }

  async deleteMe(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: { profiles: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    // 1. Cancel active bookings
    const activeStatuses = ["requested", "accepted", "confirmed", "in_progress"];
    let activeBookings = [];
    if (user.role === "parent") {
      activeBookings = await this.prisma.bookings.findMany({
        where: {
          parent_id: userId,
          status: { in: activeStatuses },
        },
      });

      await this.prisma.bookings.updateMany({
        where: {
          parent_id: userId,
          status: { in: activeStatuses },
        },
        data: {
          status: "cancelled",
          cancellation_reason: "Parent account deleted",
        },
      });

      // Notify nannies
      for (const booking of activeBookings) {
        if (booking.nanny_id) {
          await this.notificationsService.createNotification(
            booking.nanny_id,
            "Booking Cancelled",
            "A booking was cancelled because the parent deleted their account.",
            "warning"
          );
        }
      }
    }

    // 2. Anonymise PII
    const deletedEmail = `deleted-${user.id}@keel.dev`;

    await this.prisma.$transaction([
      this.prisma.users.update({
        where: { id: userId },
        data: {
          email: deletedEmail,
          is_active: false,
          oauth_provider: null,
          oauth_provider_id: null,
          oauth_access_token: null,
          oauth_refresh_token: null,
          password_hash: null,
          fcm_token: null,
          refresh_token_hash: null,
        },
      }),
      this.prisma.profiles.update({
        where: { user_id: userId },
        data: {
          first_name: "Deleted",
          last_name: "User",
          phone: null,
          address: null,
          profile_image_url: null,
          lat: null,
          lng: null,
        },
      }),
    ]);

    return { message: "Account deleted and data anonymised successfully" };
  }

  /**
   * DPDPA 2023 — Right of Access (Article 11).
   * Returns a complete snapshot of all personal data held for the user.
   * Intentionally omits security-sensitive fields (password_hash, token hashes).
   */
  async exportMyData(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: {
        profiles: true,
        children: true,
        bookings_bookings_parent_idTousers: {
          select: {
            id: true, status: true, start_time: true, end_time: true,
            created_at: true, cancellation_reason: true,
          },
          orderBy: { created_at: 'desc' },
        },
        bookings_bookings_nanny_idTousers: {
          select: {
            id: true, status: true, start_time: true, end_time: true,
            created_at: true,
          },
          orderBy: { created_at: 'desc' },
        },
        reviews_reviews_reviewer_idTousers: {
          select: { id: true, rating: true, comment: true, created_at: true },
        },
        reviews_reviews_reviewee_idTousers: {
          select: { id: true, rating: true, comment: true, created_at: true },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    const payments = await this.prisma.payments.findMany({
      where: {
        OR: [
          { bookings: { parent_id: userId } },
          { bookings: { nanny_id: userId } },
        ],
      },
      select: {
        id: true, order_id: true, amount: true, currency: true,
        status: true, provider: true, created_at: true,
      },
      orderBy: { created_at: 'desc' },
    });

    return {
      exported_at: new Date().toISOString(),
      account: {
        id: user.id,
        email: user.email,
        role: user.role,
        is_active: user.is_active,
        created_at: user.created_at,
      },
      profile: user.profiles,
      children: user.children,
      bookings_as_parent: user.bookings_bookings_parent_idTousers,
      bookings_as_nanny: user.bookings_bookings_nanny_idTousers,
      payments,
      reviews_given: user.reviews_reviews_reviewer_idTousers,
      reviews_received: user.reviews_reviews_reviewee_idTousers,
    };
  }
}

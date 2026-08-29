import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EncryptionService } from "../common/services/encryption.service";
import { SupabaseStorageService } from "../supabase-storage/supabase-storage.service";
import { Prisma } from "@prisma/client";
import { users, profiles } from "@prisma/client";
import { UpdateUserDto } from "./dto/update-user.dto";
import { AddressesService } from "../addresses/addresses.service";
import {
  BookingStatus,
  INSTALMENT_PENDING,
  INSTALMENT_VOID,
} from "../constants";
import {
  BOOKING_EVENTS,
  BookingCancelledEvent,
} from "../bookings/events/booking.events";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private encryptionService: EncryptionService,
    private storageService: SupabaseStorageService,
    private addressesService: AddressesService,
    private eventEmitter: EventEmitter2,
  ) { }

  private decryptOnboardingDetails<T extends { nanny_onboarding_details?: any }>(
    user: T,
  ): T {
    if (user?.nanny_onboarding_details?.previous_salary) {
      user.nanny_onboarding_details = {
        ...user.nanny_onboarding_details,
        previous_salary: this.encryptionService.decrypt(
          user.nanny_onboarding_details.previous_salary,
        ),
      };
    }
    return user;
  }

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

  /**
   * Resolve an account by email, case-insensitively.
   *
   * `users.email` is a case-sensitive unique column and nothing ever normalised the
   * address on the way in, so `victim@gmail.com` and `Victim@Gmail.com` were two
   * distinct accounts for one real mailbox — and every lookup was an exact match,
   * so which one you reached depended on exactly how you typed it. New signups are
   * now lowercased by the DTOs, but historical rows keep whatever case they were
   * created with, so lookups have to tolerate both.
   *
   * Exact match is tried first: it uses the unique index and is the common case.
   * The insensitive scan is the fallback for those historical rows.
   */
  private async resolveEmailWhere(
    email: string,
  ): Promise<Prisma.usersWhereInput | null> {
    const trimmed = email?.trim();
    if (!trimmed) return null;

    const exact = await this.prisma.users.findUnique({
      where: { email: trimmed },
      select: { id: true },
    });
    if (exact) return { id: exact.id };

    const matches = await this.prisma.users.findMany({
      where: { email: { equals: trimmed, mode: "insensitive" } },
      select: { id: true, email: true },
      take: 2,
    });
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      // Pre-existing duplicates for one mailbox. Picking arbitrarily would make
      // login non-deterministic, so refuse and make it visible instead.
      this.logger.error(
        `Multiple accounts differ only by email case for "${trimmed}": ` +
          matches.map((m) => m.id).join(", "),
      );
      return null;
    }
    return { id: matches[0].id };
  }

  async findOneByEmail(email: string): Promise<users | null> {
    const where = await this.resolveEmailWhere(email);
    if (!where) return null;
    return this.prisma.users.findFirst({ where });
  }

  async findUserForAuth(email: string) {
    const where = await this.resolveEmailWhere(email);
    if (!where) return null;
    return this.prisma.users.findFirst({
      where,
      include: {
        profiles: {
          select: {
            first_name: true,
            last_name: true,
            profile_image_url: true,
            onboarding_completed: true,
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
            onboarding_completed: true,
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
  async isPhoneAvailable(phone: string, currentUserId?: string) {
    const decodedPhone = decodeURIComponent(phone);
    const existing = await this.prisma.profiles.findFirst({
      where: { phone: decodedPhone }
    });
    
    if (existing && existing.user_id !== currentUserId) {
      return false;
    }
    return true;
  }

  async findAllNannies() {
    const nannies = await this.prisma.users.findMany({
      where: {
        role: "nanny",
        // Exclude deactivated and pending-deletion accounts from discovery.
        is_active: true,
        deleted_at: null,
        // Restored: browsing must not surface caregivers who have not cleared
        // identity verification. Was commented out "for testing" per
        // docs/nanny-verification-removal.md and never put back.
        identity_verification_status: "verified",
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
        nanny_onboarding_details: true,
        children: {
          where: { deleted_at: null },
          orderBy: { created_at: "desc" },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    let identity_documents = [];
    if (user.role === "nanny" && user.identity_verification_status !== "verified") {
      identity_documents = await this.prisma.identity_documents.findMany({
        where: { user_id: id },
      });
    }

    this.decryptOnboardingDetails(user);

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

    return { ...result, identity_documents };
  }

  async findOne(id: string) {
    const user = await this.prisma.users.findUnique({
      where: { id },
      include: {
        profiles: true,
        nanny_details: true,
        nanny_onboarding_details: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    this.decryptOnboardingDetails(user);

    // Exclude sensitive fields (mirror findMe / findAllNannies)
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
        ...result,
        averageRating,
        totalReviews,
      };
    }

    return result;
  }

  /**
   * The public view of a user — what someone who is *not* that user is allowed to
   * see. This is what `GET /users/:id` returns to everyone except the user
   * themselves and admins.
   *
   * `findOne` was previously served to any authenticated caller, which meant any
   * logged-in account could read any other account's phone number, home address and
   * exact lat/lng, plus a caregiver's decrypted `previous_salary` — from nothing but
   * a user id, and ids are handed out freely on bookings, reviews and requests.
   *
   * Excluded deliberately, and none of it should be added back without a specific
   * need: `email`, `profiles.phone`, `profiles.address`, `profiles.location_address`,
   * `profiles.lat/lng`, and the whole of `nanny_onboarding_details` (salary history,
   * documents). A booking's own `service_address` is the correct source for where a
   * session happens — it is scoped to that booking rather than to the person.
   */
  async findPublicProfile(id: string) {
    const user = await this.prisma.users.findUnique({
      where: { id },
      select: {
        id: true,
        role: true,
        is_active: true,
        is_verified: true,
        identity_verification_status: true,
        created_at: true,
        profiles: {
          select: {
            user_id: true,
            first_name: true,
            last_name: true,
            profile_image_url: true,
          },
        },
        nanny_details: {
          select: {
            user_id: true,
            skills: true,
            experience_years: true,
            bio: true,
            categories: true,
            tags: true,
            acceptance_rate: true,
            is_available_now: true,
            attendance_score: true,
            attendance_sessions: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    if (user.role !== "nanny") return user;

    const reviews = await this.prisma.reviews.findMany({
      where: { reviewee_id: id },
      select: { rating: true },
    });
    const totalReviews = reviews.length;
    const averageRating =
      totalReviews > 0
        ? Math.round(
            (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / totalReviews) * 10,
          ) / 10
        : null;

    return { ...user, averageRating, totalReviews };
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
        "locationAddress" in updateUserDto ||
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
        locationAddress,
        lat,
        lng,
        profileImageUrl,
        skills,
        experienceYears,
        bio,
        availabilitySchedule,
      } = dto;

      // Update basic profile info.
      //
      // Presence checks must be `!== undefined`, not truthiness: `lat: 0`,
      // `lng: 0` or an empty string are legitimate submitted values, and the
      // old `firstName || lat || …` guard silently dropped the whole profile
      // write when only such a value was sent.
      if (
        firstName !== undefined ||
        lastName !== undefined ||
        phone !== undefined ||
        address !== undefined ||
        locationAddress !== undefined ||
        lat !== undefined ||
        lng !== undefined ||
        profileImageUrl !== undefined
      ) {
        await this.prisma.profiles.upsert({
          where: { user_id: id },
          update: {
            first_name: firstName,
            last_name: lastName,
            phone,
            address: address,
            location_address: locationAddress,
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
            location_address: locationAddress,
            lat,
            lng,
            profile_image_url: profileImageUrl,
          },
        });

        // Keep the new multi-address table in sync with legacy single-address
        // writes (e.g. from CareConnect web, which only knows about `profiles`).
        // `label` is a short tag (Home/Work/…), never the free-text
        // `locationAddress`, which would overflow the column.
        if (address && lat != null && lng != null) {
          const defaultAddress = await this.addressesService.getDefault(id);
          if (defaultAddress) {
            await this.addressesService.update(id, defaultAddress.id, {
              address,
              lat,
              lng,
            });
          } else {
            await this.addressesService.create(id, {
              label: "Home",
              address,
              lat,
              lng,
              isDefault: true,
            });
          }
        }
      }

      // Update nanny details if provided. `!== undefined` rather than truthy:
      // `experienceYears: 0` is a real answer (a new caregiver), and the old
      // truthy guard made it unsaveable when sent on its own — the request
      // returned success while writing nothing.
      if (
        skills !== undefined ||
        experienceYears !== undefined ||
        bio !== undefined ||
        availabilitySchedule !== undefined
      ) {
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

  async uploadAvatarFile(id: string, file: Express.Multer.File) {
    const url = await this.storageService.uploadPublicImage(id, file);
    await this.prisma.profiles.upsert({
      where: { user_id: id },
      update: { profile_image_url: url, updated_at: new Date() },
      create: { user_id: id, profile_image_url: url },
    });
    return { profileImageUrl: url };
  }

  async updatePushToken(id: string, token: string, platform?: string) {
    // A push token identifies a *device*, not an account. On a shared device
    // (log out → someone else logs in), the token re-registers under the new
    // account but used to stay on the old account's row too — so the old
    // account's notifications (booking updates, chat) kept landing on a device
    // now owned by a different person. Evict the token from every other row in
    // the same transaction that claims it, so exactly one account holds a given
    // device token at any time.
    const [, updated] = await this.prisma.$transaction([
      this.prisma.users.updateMany({
        where: { fcm_token: token, id: { not: id } },
        data: { fcm_token: null },
      }),
      this.prisma.users.update({
        where: { id },
        data: { fcm_token: token, ...(platform ? { push_platform: platform } : {}) },
      }),
    ]);
    return updated;
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
      select: { id: true, role: true, deleted_at: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    const scheduledMessage =
      "Account scheduled for deletion. It will be permanently deleted after 30 days. Contact support within 30 days to cancel.";

    // Already scheduled: return idempotently instead of re-running the write.
    // Re-setting deleted_at would silently restart the 30-day retention window
    // and re-clear deletion_notice_sent_at, deferring the DPDP purge forever
    // for anyone who could reach this twice.
    if (user.deleted_at) {
      return { message: scheduledMessage };
    }

    // Statuses that make a booking "live". These must be the BookingStatus
    // enum values: the previous hand-written list ("accepted", "confirmed",
    // "in_progress") matched neither CONFIRMED nor IN_PROGRESS (status values
    // are case-sensitive) and included a status bookings never have — so
    // account deletion left confirmed and in-progress bookings running, still
    // assigned, and still billing.
    const activeStatuses = [
      BookingStatus.REQUESTED,
      BookingStatus.CONFIRMED,
      BookingStatus.IN_PROGRESS,
    ];
    // Both roles wind their side of the marketplace down — the old code only
    // handled parents, leaving a deleted caregiver assigned to upcoming
    // sessions the parent was never told would not happen.
    const roleWhere =
      user.role === "nanny" ? { nanny_id: userId } : { parent_id: userId };
    const reason =
      user.role === "nanny"
        ? "Nanny account deleted"
        : "Parent account deleted";

    // Everything that makes this account deleted, in one transaction — the
    // soft-delete claim, the booking cancellations, the instalment voiding and
    // the request/assignment wind-down commit or roll back together, so a
    // failure can't leave a deactivated account with live bookings (or vice
    // versa). Events and notifications are emitted after commit, matching
    // cancelRequest/cancelBooking.
    const cancelledBookings = await this.prisma.$transaction(async (tx) => {
      // Guarded claim on the account itself: two concurrent DELETE /users/me
      // requests must not both run the cascade (double events, double
      // notifications) — only the one that flips deleted_at proceeds.
      const claim = await tx.users.updateMany({
        where: { id: userId, deleted_at: null },
        data: {
          // Soft delete: deactivate and start the 30-day retention window.
          // PII is retained (but locked, since is_active=false) so support can
          // restore within 30 days; the daily cleanup cron anonymises/purges
          // once the window elapses. Only session/push credentials are
          // cleared, to force the user out.
          is_active: false,
          deleted_at: new Date(),
          deletion_notice_sent_at: null,
          oauth_access_token: null,
          oauth_refresh_token: null,
          fcm_token: null,
          refresh_token_hash: null,
        },
      });
      if (claim.count === 0) return [];

      // Cancel live bookings with a per-booking guarded claim, so a booking
      // that completed or cancelled between the read and the write keeps its
      // real state instead of being stamped CANCELLED over it — and we only
      // notify for bookings this call actually cancelled.
      const active = await tx.bookings.findMany({
        where: { ...roleWhere, status: { in: activeStatuses } },
      });

      const cancelled: typeof active = [];
      for (const booking of active) {
        const bookingClaim = await tx.bookings.updateMany({
          where: { id: booking.id, status: { in: activeStatuses } },
          data: { status: BookingStatus.CANCELLED, cancellation_reason: reason },
        });
        if (bookingClaim.count === 0) continue;

        // Money that stopped being owed is voided, not left pending — same
        // rule as cancelBooking. Without this, the cancelled bookings' pending
        // instalments stayed collectible: a stale checkout could still settle
        // one, and any query missing the booking-status filter would resurrect
        // the balance. Paid instalments are untouched; refunds stay an admin
        // decision.
        await tx.payment_installments.updateMany({
          where: { booking_id: booking.id, status: INSTALMENT_PENDING },
          data: { status: INSTALMENT_VOID, updated_at: new Date() },
        });

        cancelled.push(
          await tx.bookings.findUniqueOrThrow({ where: { id: booking.id } }),
        );
      }

      // A deleting parent's open service requests must close too, or the
      // matching cron keeps assigning caregivers to — and caregivers keep
      // accepting work from — an account that no longer exists.
      if (user.role !== "nanny") {
        const openRequests = await tx.service_requests.findMany({
          where: {
            parent_id: userId,
            status: { in: ["pending", "accepted", "assigned"] },
          },
          select: { id: true },
        });
        if (openRequests.length > 0) {
          const requestIds = openRequests.map((r) => r.id);
          await tx.assignments.updateMany({
            where: {
              request_id: { in: requestIds },
              status: { in: ["pending", "accepted"] },
            },
            data: { status: "cancelled", responded_at: new Date() },
          });
          await tx.service_requests.updateMany({
            where: {
              id: { in: requestIds },
              status: { in: ["pending", "accepted", "assigned"] },
            },
            data: { status: "CANCELLED" },
          });
        }
      }

      return cancelled;
    });

    // Post-commit side effects: BOOKING_EVENTS.CANCELLED feeds the listeners
    // that notify/email the other party, emit SSE, void instalments (again,
    // idempotently) and record attendance — the old inline notification loop
    // covered only the push notification and only for parents.
    for (const booking of cancelledBookings) {
      this.eventEmitter.emit(
        BOOKING_EVENTS.CANCELLED,
        new BookingCancelledEvent(booking, reason, userId),
      );
    }

    return { message: scheduledMessage };
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

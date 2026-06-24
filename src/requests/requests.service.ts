import { Prisma } from "@prisma/client";
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateRequestDto } from "./dto/create-request.dto";
import { UsersService } from "../users/users.service";
import { NotificationsService } from "../notifications/notifications.service";
import { FavoritesService } from "../favorites/favorites.service";
import { SseService } from "../sse/sse.service";
import { SSE_EVENTS } from "../events/sse-event.types";
import { MailService } from "../mail/mail.service";
import { TimeUtils } from "../common/utils/time.utils";
import { AvailabilityService } from "../availability/availability.service";
import { BookingStatus } from "../common/constants/booking-status.enum";
import { PricingEngineService } from "../common/pricing.service";
import { MATCHING_RADIUS_KM, ASSIGNMENT_RESPONSE_DEADLINE_MS } from "../common/constants/constants";

import { CATEGORY_SKILL_MAP } from "../constants";

@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);
  constructor(
    private prisma: PrismaService,
    private usersService: UsersService,
    private notificationsService: NotificationsService,
    private favoritesService: FavoritesService,
    private sseService: SseService,
    private mailService: MailService,
    private availabilityService: AvailabilityService,
    private pricingService: PricingEngineService,
  ) {}

  async create(parentId: string, createRequestDto: CreateRequestDto) {
    this.logger.debug(`Creating Request for parent ${parentId}: category=${createRequestDto.category}, date=${createRequestDto.date}`);

    // 1. Get parent profile for location
    const parent = await this.usersService.findOne(parentId);
    if (
      !parent ||
      !parent.profiles ||
      !parent.profiles.lat ||
      !parent.profiles.lng
    ) {
      this.logger.warn(`Parent profile incomplete for ${parentId}`);
      throw new BadRequestException(
        "Parent profile incomplete. Address and location required.",
      );
    }

    try {
      // 2. Wrap creation in a transaction to ensure atomicity
      const { request, booking, totalAmount, hourlyRate } =
        await this.prisma.$transaction(async (tx) => {
          // Create the service request
          const startTimeStr = createRequestDto.start_time;

          // Fetch service details for pricing
          const serviceSettings = await this.prisma.services.findUnique({
            where: { name: createRequestDto.category },
          });

          if (!serviceSettings) {
            throw new BadRequestException(
              `Service category '${createRequestDto.category}' not found.`,
            );
          }

          const bookingStartTime = TimeUtils.combineDateAndTime(
            createRequestDto.date,
            startTimeStr,
          );
          const bookingEndTime = TimeUtils.getEndTime(
            bookingStartTime,
            Number(createRequestDto.duration_hours),
          );

          const request = await tx.service_requests.create({
            data: {
              parent_id: parentId,
              date: new Date(createRequestDto.date),
              start_time: bookingStartTime,
              duration_hours: createRequestDto.duration_hours,
              num_children: createRequestDto.num_children,
              children_ages: createRequestDto.children_ages || [],
              special_requirements: createRequestDto.special_requirements,
              required_skills: createRequestDto.required_skills || [],
              location_lat: parent.profiles.lat,
              location_lng: parent.profiles.lng,
              category: createRequestDto.category,
              status: "pending",
              plan_type: createRequestDto.plan_type || "ONE_TIME",
              plan_duration_months: createRequestDto.plan_duration_months || 1,
              discount_percentage: createRequestDto.discount_percentage || 0,
              sessions_per_month: createRequestDto.sessions_per_month || null,
            } as any,
          });

          const { totalAmount, appliedRate: hourlyRate } = await this.pricingService.calculateCost(
            createRequestDto.category,
            Number(createRequestDto.duration_hours),
            Number(createRequestDto.discount_percentage || 0),
            Number(createRequestDto.plan_duration_months || 1),
            createRequestDto.plan_type || "ONE_TIME",
            createRequestDto.sessions_per_month,
          );

          // Create initial booking (Pending Assignment)
          const booking = await tx.bookings.create({
            data: {
              job_id: null,
              request_id: request.id,
              parent_id: parentId,
              nanny_id: null,
              status: BookingStatus.REQUESTED,
              start_time: bookingStartTime,
              end_time: bookingEndTime,
              tags: createRequestDto.use_installments ? ["use_installments"] : [],
            },
          });

          if (
            createRequestDto.child_ids &&
            createRequestDto.child_ids.length > 0
          ) {
            await tx.booking_children.createMany({
              data: createRequestDto.child_ids.map((childId) => ({
                booking_id: booking.id,
                child_id: childId,
              })),
            });
          }

          // Payment Installments and Plan are now initialized when a nanny is successfully assigned

          return { request, booking, totalAmount, hourlyRate };
        });

      // 4. Notify Parent about matching in progress
      await this.notificationsService.createNotification(
        parentId,
        "Request Created",
        "Your care request has been created. We are matching you with the best available nannies.",
        "info",
      );

      // Emit SSE — parent dashboard reacts immediately
      this.sseService.emitToUser(parentId, {
        type: SSE_EVENTS.REQUEST_CREATED,
        data: request,
        timestamp: new Date().toISOString(),
      });

      // 3. Trigger auto-matching AFTER the transaction has committed.
      // Running it inside the transaction caused it to exceed Prisma's 5 s interactive
      // transaction timeout (matching does multiple queries + its own Serializable tx).
      // Fire-and-forget — same pattern used in assignments.service.ts on rejection.
      this.triggerMatching(request.id).catch((err) =>
        this.logger.error(`Error triggering matching for request ${request.id}`, err),
      );

      return {
        ...request,
        hourly_rate: hourlyRate,
        total_amount: totalAmount,
      };
    } catch (error) {
      if (error.code === "P2002") {
        throw new BadRequestException(
          "An active booking already exists for this request or a duplicate request was detected.",
        );
      }
      this.logger.error("Error creating service request flow:", error);
      throw error;
    }
  }

  async cancelRequest(id: string, parentId?: string) {
    let request = await this.prisma.service_requests.findUnique({
      where: { id },
      include: {
        assignments: { where: { status: { in: ["pending", "accepted"] } } },
        bookings: true,
      },
    });

    // Strategy 2: If not found by Request ID, check if the ID provided is a Booking ID
    if (!request) {
      this.logger.debug(`Request ID ${id} not found. Checking if it is a Booking ID...`);
      const booking = await this.prisma.bookings.findUnique({
        where: { id },
        select: { request_id: true },
      });

      if (booking && booking.request_id) {
        this.logger.debug(`Found associated Request ID ${booking.request_id} for Booking ${id}`);
        request = await this.prisma.service_requests.findUnique({
          where: { id: booking.request_id },
          include: {
            assignments: { where: { status: { in: ["pending", "accepted"] } } },
            bookings: true,
          },
        });
      }
    }

    if (!request) throw new NotFoundException("Request not found");
    if (parentId && request.parent_id !== parentId) {
      throw new ForbiddenException("You are not authorized to cancel this request");
    }

    const requestId = request.id;
    this.logger.log(`Cancelling request ${requestId}, current status: ${request.status}`);

    // Status validation
    const allowedStatuses = ["pending", "accepted", "assigned"];
    if (!allowedStatuses.includes(request.status)) {
      // If already cancelled/completed, throw specific error
      if (request.status === "CANCELLED" || request.status === "COMPLETED") {
        throw new BadRequestException(
          `Cannot cancel a ${request.status} request`,
        );
      }
      // Fallback for other statuses
      throw new BadRequestException(
        `Cannot cancel a request that is not pending (Current: ${request.status})`,
      );
    }

    // 1. Cancel any pending or accepted assignments
    if (request.assignments.length > 0) {
      await this.prisma.assignments.updateMany({
        where: {
          request_id: requestId,
          status: { in: ["pending", "accepted"] },
        },
        data: {
          status: "cancelled",
          responded_at: new Date(),
        },
      });
    }

    // 2. Cancel associated booking if exists
    if (request.bookings && request.bookings.status !== BookingStatus.CANCELLED) {
      await this.prisma.bookings.update({
        where: { id: request.bookings.id },
        data: {
          status: BookingStatus.CANCELLED,
          cancellation_reason: "Request cancelled by parent",
        },
      });
    }

    // 3. Update request status
    const result = await this.prisma.service_requests.update({
      where: { id: requestId },
      data: { status: "CANCELLED" },
    });

    // 4. Notify Parent of successful cancellation
    await this.notificationsService.createNotification(
      request.parent_id,
      "Request Cancelled",
      "Your service request has been successfully cancelled.",
      "warning",
    );

    // Emit SSE
    this.sseService.emitToUser(request.parent_id, {
      type: SSE_EVENTS.REQUEST_CANCELLED,
      data: result,
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  async triggerMatching(requestId: string, tx?: Prisma.TransactionClient) {
    const prisma = tx || this.prisma;
    const request = await prisma.service_requests.findUnique({
      where: { id: requestId },
      include: {
        assignments: true,
        users: { include: { profiles: true } },
      }, // Include previous assignments and parent info
    });

    if (!request) throw new NotFoundException("Request not found");

    // Skip auto-matching for Shadow Teacher and Special Needs categories
    // These will be manually assigned by admins
    if (request.category === "ST" || request.category === "SN") {
      this.logger.log(`[Matching] Skipping auto-matching for ${request.category} request ${requestId}. Awaiting manual assignment.`);
      
      try {
        const admins = await prisma.users.findMany({
          where: { role: "admin" },
          select: { id: true },
        });
        for (const admin of admins) {
          await this.notificationsService.createNotification(
            admin.id,
            "Manual Assignment Required",
            `A new ${request.category} request (${requestId.substring(0, 8)}) requires manual nanny assignment.`,
            "info"
          );
        }
      } catch (err) {
        this.logger.error("Failed to notify admins for manual matching request", err);
      }

      return null;
    }

    // Get IDs of nannies already assigned (rejected or timeout)
    const previouslyAssignedIds = request.assignments.map((a) => a.nanny_id);

    // Calculate Request End Time directly from the date object
    const requestStartTime = TimeUtils.combineDateAndTime(
      request.date,
      request.start_time,
    );
    const requestEndTime = TimeUtils.getEndTime(
      requestStartTime,
      Number(request.duration_hours),
    );

    this.logger.debug(`[Matching] Checking overlap for request ${requestId}: ${requestStartTime.toISOString()} - ${requestEndTime.toISOString()}`);

    // Find Nannies with overlapping CONFIRMED bookings of any status that blocks availability
    const busyNannies = await prisma.bookings.findMany({
      where: {
        nanny_id: { not: null },
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS, BookingStatus.REQUESTED] },
        OR: [
          // Overlap Condition: (StartA < EndB) and (EndA > StartB)
          {
            AND: [
              { start_time: { lt: requestEndTime } },
              { end_time: { gt: requestStartTime } },
            ],
          },
        ],
      },
      select: { nanny_id: true, start_time: true, end_time: true },
    });

    const busyNannyIds = busyNannies.map((b) => b.nanny_id);
    this.logger.debug(`[Matching] Busy nannies (${busyNannyIds.length}): ${busyNannyIds.join(", ") || "none"}`);

    // 2b. Batch-load all availability blocks for non-busy nannies in a SINGLE query,
    // then evaluate overlaps in-memory. Previously this issued isNannyAvailable() per
    // block inside a loop — 2 DB queries * N blocks = N+1 total. Now it's 1 query total.
    // NOTE: When busyNannyIds is empty, omit the notIn filter entirely — passing ["none"]
    // as a fallback caused Postgres to reject it as an invalid UUID.
    const nanniesWithBlocks = await prisma.availability_blocks.findMany({
      where: busyNannyIds.length > 0
        ? { nanny_id: { notIn: busyNannyIds } }
        : undefined,
    });

    // Group blocks by nanny_id for efficient per-nanny evaluation
    const blocksByNanny = new Map<string, typeof nanniesWithBlocks>();
    for (const block of nanniesWithBlocks) {
      const existing = blocksByNanny.get(block.nanny_id) ?? [];
      existing.push(block);
      blocksByNanny.set(block.nanny_id, existing);
    }

    // Check overlaps in-memory — no additional DB queries
    const blockedNannyIds: string[] = [];
    for (const [nannyId, blocks] of blocksByNanny) {
      const hasOverlappingBlock = blocks.some((block) =>
        this.availabilityService.doesBlockOverlap(block, requestStartTime, requestEndTime),
      );
      if (hasOverlappingBlock) {
        blockedNannyIds.push(nannyId);
      }
    }

    this.logger.debug(`[Matching] Blocked nannies from availability blocks (${blockedNannyIds.length}): ${blockedNannyIds.join(", ") || "none"}`);

    // Combine previous rejects, busy nannies, and blocked nannies
    const excludedNannyIds = [
      ...new Set([
        ...previouslyAssignedIds,
        ...busyNannyIds,
        ...blockedNannyIds,
      ]),
    ];

    const radiusKm = MATCHING_RADIUS_KM;
    const category = (request as any).category;
    const mappedSkills = CATEGORY_SKILL_MAP[category] || [];
    const skillSearchTerms = [category, ...mappedSkills].filter(Boolean);

    const nannies = (await prisma.$queryRaw(Prisma.sql`
      SELECT 
        u.id, 
        u.email,
        p.first_name,
        p.last_name,
        p.address,
        nd.skills,
        nd.experience_years,
        nd.acceptance_rate,
        (6371 * acos(cos(radians(${request.location_lat})) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(${request.location_lng})) + sin(radians(${request.location_lat})) * sin(radians(p.lat)))) AS distance
      FROM users u
      JOIN profiles p ON u.id = p.user_id
      JOIN nanny_details nd ON u.id = nd.user_id
      WHERE u.role = 'nanny'
      AND nd.is_available_now = true
      ${excludedNannyIds.length > 0 ? Prisma.sql`AND u.id NOT IN (${Prisma.join(excludedNannyIds)})` : Prisma.empty}
      ${
        skillSearchTerms.length > 0
          ? Prisma.sql`AND (
        EXISTS (SELECT 1 FROM unnest(nd.tags) t WHERE t IN (${Prisma.join(skillSearchTerms)}))
        OR 
        EXISTS (SELECT 1 FROM unnest(nd.skills) s WHERE s IN (${Prisma.join(skillSearchTerms)}))
        OR
        EXISTS (SELECT 1 FROM unnest(nd.categories) c WHERE c IN (${Prisma.join(skillSearchTerms)}))
      )`
          : Prisma.empty
      }
      AND (6371 * acos(cos(radians(${request.location_lat})) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(${request.location_lng})) + sin(radians(${request.location_lat})) * sin(radians(p.lat)))) < ${radiusKm}
    `)) as any[];

    // In-Memory Filtering & Scoring
    const requiredSkills = request.required_skills || [];

    // Get parent's favorite nannies
    const favoriteNannyIds = await this.favoritesService.getFavoriteNannyIds(
      request.parent_id,
    );

    const scoredNannies = nannies
      .map((nanny) => {
        // Calculate Score
        let score = 0;

        // 0. Skill Match (Max 40 pts)
        const nannySkills = nanny.skills || [];
        const matchedSkills = requiredSkills.filter((skill) =>
          nannySkills.includes(skill),
        );
        const skillScore =
          requiredSkills.length > 0
            ? (matchedSkills.length / requiredSkills.length) * 40
            : 40; // If no skills required, everyone gets full skill points
        score += skillScore;

        // 1. Distance (Max 30 pts) - Closer is better
        const distanceScore = Math.max(0, 30 * (1 - nanny.distance / radiusKm));
        score += distanceScore;

        // 2. Experience (Max 20 pts)
        const experience = nanny.experience_years || 0;
        const experienceScore = Math.min(20, experience * 2);
        score += experienceScore;

        // 3. Acceptance Rate (Max 20 pts)
        const acceptanceRate = Number(nanny.acceptance_rate) || 0;
        const acceptanceScore = (acceptanceRate / 100) * 20;
        score += acceptanceScore;

        // 5. Favorite Bonus (+50 pts)
        if (favoriteNannyIds.includes(nanny.id)) {
          score += 50;
        }

        this.logger.debug(
          `[Scoring] Nanny ${nanny.email} — dist:${distanceScore.toFixed(1)} exp:${experienceScore} acc:${acceptanceScore} skills:${skillScore.toFixed(1)} fav:${favoriteNannyIds.includes(nanny.id) ? 50 : 0} TOTAL:${score.toFixed(1)}`,
        );

        return { ...nanny, score };
      })
      .sort((a, b) => b.score - a.score); // Sort by Score DESC

    if (scoredNannies.length > 0) {
      this.logger.log(`[Matching] Found ${scoredNannies.length} potential matches for request ${requestId}. Attempting assignment...`);

      for (const bestMatch of scoredNannies) {
        this.logger.debug(`[Matching] Attempting to assign request ${requestId} to nanny ${bestMatch.id} (score: ${bestMatch.score.toFixed(1)})`);

        try {
          const runAssignment = async (transaction: Prisma.TransactionClient) => {
            // 1. RE-VERIFY AVAILABILITY WITHIN TRANSACTION (Lock-and-Verify)
            const overlap = await transaction.bookings.findFirst({
              where: {
                nanny_id: bestMatch.id,
                status: { in: [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS, BookingStatus.REQUESTED] },
                OR: [
                  {
                    AND: [
                      { start_time: { lt: requestEndTime } },
                      { end_time: { gt: requestStartTime } },
                    ],
                  },
                ],
              },
            });

            if (overlap) {
              this.logger.warn(`[Matching] Race condition: Nanny ${bestMatch.id} already booked for overlapping slot.`);
              throw new Error("NANNY_BUSY");
            }

            // 2. Create assignment (Directly as accepted)
            const assignment = await transaction.assignments.create({
              data: {
                request_id: requestId,
                nanny_id: bestMatch.id,
                response_deadline: new Date(Date.now() + ASSIGNMENT_RESPONSE_DEADLINE_MS),
                status: "accepted",
                responded_at: new Date(),
                rank_position: (request.assignments?.length || 0) + 1,
              },
            });

            // 3. Update request status to accepted
            await transaction.service_requests.update({
              where: { id: requestId },
              data: {
                status: "accepted",
                current_assignment_id: assignment.id,
              },
            });

            // 4. Update associated booking to CONFIRMED
            const updatedBooking = await transaction.bookings.update({
              where: { request_id: requestId, status: { not: BookingStatus.CANCELLED } },
              data: {
                nanny_id: bestMatch.id,
                status: BookingStatus.CONFIRMED,
              },
            });

            // 5. REMOVED: createRecurringRecord and createPaymentPlan moved OUTSIDE
            // the transaction to prevent cross-transaction deadlocks under Serializable isolation.

            return { assignment, booking: updatedBooking };
          };

          let assignmentResult: { assignment: any; booking: any } | null = null;
          let retries = 3;
          while (retries > 0) {
            try {
              assignmentResult = tx
                ? await runAssignment(tx)
                : await this.prisma.$transaction((t) => runAssignment(t), {
                    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                  });
              break; // Success
            } catch (err) {
              // Known business errors should immediately bubble to the outer catch
              if (err.message === "NANNY_BUSY" || err.code === "P2002") {
                throw err;
              }
              // Catch Prisma deadlock or write conflict errors
              if (err.code === "P2034" || (err.message && err.message.includes("write conflict or a deadlock"))) {
                retries--;
                if (retries === 0) throw err;
                this.logger.warn(`[Matching] Write conflict/deadlock for request ${requestId}, retrying assignment... (${retries} left)`);
                // Short random backoff to avoid repeated collisions
                await new Promise((res) => setTimeout(res, 50 + Math.random() * 50));
                continue;
              }
              throw err;
            }
          }

          const { assignment, booking } = assignmentResult!;

          // Run post-commit side-effects using the main prisma client (NOT inside the
          // Serializable tx). These were the source of cross-transaction deadlocks.
          if (assignment) {
            this.createRecurringRecord(this.prisma, requestId, bestMatch.id).catch((err) =>
              this.logger.error(`[Matching] Failed to create recurring record for ${requestId}`, err),
            );
            this.createPaymentPlan(this.prisma, requestId, booking.id, request.parent_id).catch((err) =>
              this.logger.error(`[Matching] Failed to create payment plan for ${requestId}`, err),
            );
          }

          if (assignment) {
            this.logger.log(`[Matching] Successfully assigned request ${requestId} to nanny ${bestMatch.id}`);

            // Notify Nanny
            await this.notificationsService.createNotification(
              bestMatch.id,
              "New Assignment Confirmed",
              `You have been automatically assigned to a new request! Tap to view details.`,
              "info",
            );

            // Notify Parent about the successful match and confirmation
            await this.notificationsService.createNotification(
              request.parent_id,
              "Nanny Assigned!",
              `We found and confirmed a nanny for your request! Tap to view details.`,
              "success",
            );

            // Send Confirmation Emails
            const parent = (request as any).users;
            const nanny = bestMatch;
            const parentName =
              `${parent.profiles?.first_name || ""} ${parent.profiles?.last_name || ""}`.trim() ||
              "Parent";
            const nannyName =
              `${nanny.first_name || ""} ${nanny.last_name || ""}`.trim() ||
              "Nanny";

            const bookingDetails = {
              date: request.date.toISOString().split("T")[0],
              time: request.start_time.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
              duration: Number(request.duration_hours),
              location:
                parent.profiles?.address || "Location specified in profile",
            };

            // Email to Parent
            this.mailService
              .sendBookingConfirmationEmail(
                parent.email,
                parentName,
                "parent",
                { ...bookingDetails, otherPartyName: nannyName },
              )
              .catch((err) =>
                this.logger.error("Failed to send auto-match parent email", err),
              );

            // Email to Nanny
            this.mailService
              .sendBookingConfirmationEmail(
                bestMatch.email,
                nannyName,
                "nanny",
                { ...bookingDetails, otherPartyName: parentName },
              )
              .catch((err) =>
                this.logger.error("Failed to send auto-match nanny email", err),
              );

            // Emit SSE match event to both parties
            const matchedEvent = {
              type: SSE_EVENTS.REQUEST_MATCHED,
              data: { requestId, nannyId: bestMatch.id, assignment },
              timestamp: new Date().toISOString(),
            };
            this.sseService.emitToUsers(
              [request.parent_id, bestMatch.id],
              matchedEvent,
            );

            return assignment;
          }
        } catch (error) {
          if (error.message === "NANNY_BUSY") {
            continue; // Try the next best nanny
          }
          if (error.code === "P2002") {
            this.logger.warn(`[Matching] Race condition: Assignment already exists for request ${requestId}.`);
            return null;
          }
          this.logger.error(`[Matching] Error during assignment for nanny ${bestMatch.id}:`, error);
          // For other errors, continue to try the next nanny
          continue;
        }
      }

      this.logger.warn(`[Matching] Failed to assign any of the ${scoredNannies.length} candidates to request ${requestId}.`);
      // Fall through to "No matches found" notification
    }

    this.logger.warn(`[Matching] No nannies found for request ${requestId}`);
    // Notify parent no matches found
    await this.notificationsService.createNotification(
      request.parent_id,
      "No Matches Found",
      `We couldn't find a nanny for your request at this time. We will keep looking.`,
      "warning",
    );
    return null;
  }

  async findOne(id: string) {
    let request = await this.prisma.service_requests.findUnique({
      where: { id },
      include: {
        users: {
          include: { profiles: true },
        },
        assignments: {
          include: {
            users: { include: { profiles: true, nanny_details: true } },
          },
        },
      },
    });

    // FALLBACK: If not found by Request ID, check if the ID provided is a Booking ID
    if (!request) {
      this.logger.debug(`findOne: Request ID ${id} not found. Checking if it is a Booking ID...`);
      const booking = await this.prisma.bookings.findUnique({
        where: { id },
        select: { request_id: true },
      });

      if (booking && booking.request_id) {
        this.logger.debug(`findOne: Found associated Request ID ${booking.request_id} for Booking ${id}`);
        request = await this.prisma.service_requests.findUnique({
          where: { id: booking.request_id },
          include: {
            users: {
              include: { profiles: true },
            },
            assignments: {
              include: {
                users: { include: { profiles: true, nanny_details: true } },
              },
            },
          },
        });
      }
    }

    if (!request) {
      throw new NotFoundException(`Service request with ID ${id} not found`);
    }

    const { totalAmount, appliedRate: hourlyRate } = await this.pricingService.calculateCost(
      request.category || "CC",
      Number(request.duration_hours || 0),
      Number(request["discount_percentage"] || 0),
      Number(request["plan_duration_months"] || 1),
      request["plan_type"] || "ONE_TIME",
      request["sessions_per_month"],
    );

    return {
      ...request,
      hourly_rate: hourlyRate,
      total_amount: totalAmount,
    };
  }

  /**
   * Helper to create a recurring_bookings record for subscription plans.
   * This should be called when a nanny is assigned (auto or manual).
   */
  async createRecurringRecord(tx: Prisma.TransactionClient | typeof this.prisma, requestId: string, nannyId: string) {
    const request = await tx.service_requests.findUnique({
      where: { id: requestId },
    });

    if (!request || !request.plan_type || request.plan_type === "ONE_TIME") {
      return;
    }

    const dateObj = new Date(request.date);
    const dayName = new Intl.DateTimeFormat("en-US", { weekday: "short" })
      .format(dateObj)
      .toUpperCase();
    const recurrencePattern = `WEEKLY_${dayName}`;

    const endDate = TimeUtils.addMonths(dateObj, request.plan_duration_months || 1);

    // Convert start_time to string "HH:mm" for schema
    // PostgreSQL Time(6) may come back as a Date or a string depending on Prisma version/config.
    const rawStartTime: unknown = request.start_time;
    let startTimeStr = "09:00";
    if (rawStartTime instanceof Date) {
      startTimeStr = rawStartTime.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      });
    } else if (typeof rawStartTime === "string") {
      startTimeStr = rawStartTime.slice(0, 5);
    }

    return tx.recurring_bookings.create({
      data: {
        parent_id: request.parent_id,
        nanny_id: nannyId,
        recurrence_pattern: recurrencePattern,
        start_date: dateObj,
        end_date: endDate,
        start_time: startTimeStr,
        duration_hours: Number(request.duration_hours),
        num_children: request.num_children,
        children_ages: request.children_ages || [],
        special_requirements: request.special_requirements,
        is_active: true,
      },
    });
  }

  /**
   * Helper to initialize payment plan (subscription and installments) when a nanny is successfully assigned.
   */
  async createPaymentPlan(tx: Prisma.TransactionClient | typeof this.prisma, requestId: string, bookingId: string, parentId: string) {
    const request = await tx.service_requests.findUnique({ where: { id: requestId } });
    const booking = await tx.bookings.findUnique({ where: { id: bookingId } });
    
    if (!request || !booking) return;

    const useInstallments = booking.tags && booking.tags.includes("use_installments");
    
    if (useInstallments && (request.plan_duration_months || 1) > 1) {
      const planMonths = Number(request.plan_duration_months);

      // Check if plan already exists (idempotency)
      const existingPlan = await tx.payment_plans.findUnique({
        where: { booking_id: booking.id }
      });
      if (existingPlan) return;

      const plan = await tx.payment_plans.create({
        data: {
          booking_id: booking.id,
          total_cycles: planMonths,
          cycles_completed: 0,
          start_date: new Date(request.date),
          next_due_date: new Date(request.date), // First installment is due now
          status: "active",
        },
      });
    }
  }

  async findAllByParent(parentId: string) {
    const requests = await this.prisma.service_requests.findMany({
      where: {
        parent_id: parentId,
        // Only return requests that do NOT have an active (non-cancelled) booking.
        // Prevents dashboard duplication between "Requests" and "Bookings" views.
        // bookings is a one-to-one nullable relation — use top-level OR with `is`:
        //   - `is: null`  → request has no booking at all yet
        //   - `is: { status: CANCELLED }` → booking was cancelled, treat as inactive
        OR: [
          { bookings: { is: null } },
          { bookings: { is: { status: BookingStatus.CANCELLED } } },
        ],
      },
      orderBy: { created_at: "desc" },
      include: {
        assignments: {
          where: { status: "pending" },
          include: {
            users: { include: { profiles: true, nanny_details: true } },
          },
        },
      },
    });

    const enrichedRequests = await Promise.all(requests.map(async (req) => {
      const { totalAmount } = await this.pricingService.calculateCost(
        req.category || "CC",
        Number(req.duration_hours),
        Number(req["discount_percentage"] || 0),
        Number(req["plan_duration_months"] || 1),
        req["plan_type"] || "ONE_TIME",
        req["sessions_per_month"],
      );

      // Extract nanny from the first pending assignment for the frontend
      const nanny = req.assignments[0]?.users;

      return {
        ...req,
        total_amount: totalAmount,
        nanny,
        title: req.category ? `${req.category} Request` : "Service Request",
      };
    }));

    return enrichedRequests;
  }
}

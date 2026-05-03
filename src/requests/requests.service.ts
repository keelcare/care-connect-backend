import { Prisma } from "@prisma/client";
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateRequestDto } from "./dto/create-request.dto";
import { UsersService } from "../users/users.service";
import { NotificationsService } from "../notifications/notifications.service";
import { FavoritesService } from "../favorites/favorites.service";
import { SseService } from "../sse/sse.service";
import { PricingUtils } from "../common/utils/pricing.utils";
import { SSE_EVENTS } from "../events/sse-event.types";
import { MailService } from "../mail/mail.service";
import { TimeUtils } from "../common/utils/time.utils";
import { AvailabilityService } from "../availability/availability.service";

import { CATEGORY_SKILL_MAP } from "../constants";

@Injectable()
export class RequestsService {
  constructor(
    private prisma: PrismaService,
    private usersService: UsersService,
    private notificationsService: NotificationsService,
    private favoritesService: FavoritesService,
    private sseService: SseService,
    private mailService: MailService,
    private availabilityService: AvailabilityService,
  ) {}

  async create(parentId: string, createRequestDto: CreateRequestDto) {
    console.log(
      "Creating Request with DTO:",
      JSON.stringify(createRequestDto, null, 2),
    );

    // 1. Get parent profile for location
    const parent = await this.usersService.findOne(parentId);
    console.log(
      "RequestsService.create parent:",
      JSON.stringify(parent, null, 2),
    );
    if (
      !parent ||
      !parent.profiles ||
      !parent.profiles.lat ||
      !parent.profiles.lng
    ) {
      console.log("Parent profile incomplete:", parent?.profiles);
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
            } as any,
          });

          const { totalAmount, hourlyRate } = PricingUtils.calculateTotal(
            Number(serviceSettings.hourly_rate),
            Number(createRequestDto.duration_hours),
            Number(createRequestDto.discount_percentage || 0),
            Number(createRequestDto.plan_duration_months || 1),
            createRequestDto.plan_type || "ONE_TIME",
          );

          // Create initial booking (Pending Assignment)
          const booking = await tx.bookings.create({
            data: {
              job_id: null,
              request_id: request.id,
              parent_id: parentId,
              nanny_id: null,
              status: "requested",
              start_time: bookingStartTime,
              end_time: bookingEndTime,
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

          // Create Payment Installments and Plan if subscription and opted-in
          if (
            createRequestDto.use_installments &&
            (createRequestDto.plan_duration_months || 1) > 1
          ) {
            const { monthlyCost } = PricingUtils.calculateTotal(
              Number(serviceSettings.hourly_rate),
              Number(createRequestDto.duration_hours),
              Number(createRequestDto.discount_percentage || 0),
              Number(createRequestDto.plan_duration_months || 1),
              createRequestDto.plan_type || "ONE_TIME",
            );

            const planMonths = Number(createRequestDto.plan_duration_months);

            // 1. Create the Subscription Plan contract
            const plan = await tx.subscription_plans.create({
              data: {
                request_id: request.id,
                booking_id: booking.id,
                parent_id: parentId,
                status: "active",
                total_months: planMonths,
                monthly_amount: monthlyCost,
                start_date: new Date(createRequestDto.date),
                next_due_date: new Date(createRequestDto.date), // First installment is due now
              },
            });

            // 2. Create the individual Installments linked to the plan
            const installments = Array.from({ length: planMonths }).map(
              (_, index) => {
                const dueDate = new Date(createRequestDto.date);
                dueDate.setMonth(dueDate.getMonth() + index);
                return {
                  booking_id: booking.id,
                  subscription_plan_id: plan.id,
                  installment_no: index + 1,
                  amount_due: monthlyCost,
                  due_date: dueDate,
                  status: "pending",
                };
              },
            );

            await tx.payment_installments.createMany({ data: installments });
          }

          return { request, booking, totalAmount, hourlyRate };
        });

      // 3. Trigger auto-matching (Outside transaction)
      await this.triggerMatching(request.id);

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
      console.error("Error creating service request flow:", error);
      throw error;
    }
  }

  async cancelRequest(id: string) {
    let request = await this.prisma.service_requests.findUnique({
      where: { id },
      include: {
        assignments: { where: { status: { in: ["pending", "accepted"] } } },
        bookings: true,
      },
    });

    // Strategy 2: If not found by Request ID, check if the ID provided is a Booking ID
    if (!request) {
      console.log(
        `Request ID ${id} not found. checking if it is a Booking ID...`,
      );
      const booking = await this.prisma.bookings.findUnique({
        where: { id },
        select: { request_id: true },
      });

      if (booking && booking.request_id) {
        console.log(
          `Found associated Request ID ${booking.request_id} for Booking ${id}`,
        );
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

    const requestId = request.id;
    console.log(
      `Cancelling request ${requestId}, current status: ${request.status}`,
    );

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
    if (request.bookings && request.bookings.status !== "CANCELLED") {
      await this.prisma.bookings.update({
        where: { id: request.bookings.id },
        data: {
          status: "CANCELLED",
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

  async triggerMatching(requestId: string) {
    const request = await this.prisma.service_requests.findUnique({
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
      console.log(
        `[Matching] Skipping auto-matching for ${request.category} request ${requestId}. Await manual assignment.`,
      );
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

    console.log(`[DEBUG] Checking Overlap for Request: ${requestId}`);
    console.log(
      `[DEBUG] Window: ${requestStartTime.toISOString()} - ${requestEndTime.toISOString()}`,
    );

    // Find Nannies with overlapping CONFIRMED bookings of any status that blocks availability
    const busyNannies = await this.prisma.bookings.findMany({
      where: {
        nanny_id: { not: null },
        status: "CONFIRMED",
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
      select: { nanny_id: true, start_time: true, end_time: true }, // Select times for logging
    });

    console.log(
      `[DEBUG] Found Busy Nannies:`,
      JSON.stringify(busyNannies, null, 2),
    );

    const busyNannyIds = busyNannies.map((b) => b.nanny_id);
    console.log(
      `Busy Nannies (Overlap ${requestStartTime.toISOString()} - ${requestEndTime.toISOString()}):`,
      busyNannyIds,
    );

    // 2b. Find Nannies with overlapping availability blocks
    // This is a new Phase 4 feature
    const nanniesWithBlocks = await this.prisma.availability_blocks.findMany({
      where: {
        nanny_id: { notIn: busyNannyIds.length > 0 ? busyNannyIds : ["none"] }, // No need to re-check if already busy
      },
    });

    const blockedNannyIds: string[] = [];
    for (const block of nanniesWithBlocks) {
      const isUnavailable = !(await this.availabilityService.isNannyAvailable(
        block.nanny_id,
        requestStartTime,
        requestEndTime,
      ));
      if (isUnavailable) {
        blockedNannyIds.push(block.nanny_id);
      }
    }

    console.log(`Blocked Nannies (Availability Blocks):`, blockedNannyIds);

    // Combine previous rejects, busy nannies, and blocked nannies
    const excludedNannyIds = [
      ...new Set([
        ...previouslyAssignedIds,
        ...busyNannyIds,
        ...blockedNannyIds,
      ]),
    ];

    const radiusKm = 15; // Increased to 15km
    const category = (request as any).category;
    const mappedSkills = CATEGORY_SKILL_MAP[category] || [];
    const skillSearchTerms = [category, ...mappedSkills].filter(Boolean);

    const nannies = (await this.prisma.$queryRaw(Prisma.sql`
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

        console.log(`Nanny ${nanny.email} (${nanny.id}) Score Breakdown:
          Distance: ${distanceScore.toFixed(2)} (Dist: ${nanny.distance.toFixed(2)}km)
          Exp: ${experienceScore}
          Acc: ${acceptanceScore}
          Skills: ${skillScore.toFixed(2)} (${matchedSkills.length}/${requiredSkills.length})
          Favorite: ${favoriteNannyIds.includes(nanny.id) ? 50 : 0}
          TOTAL: ${score.toFixed(2)}
        `);

        return { ...nanny, score };
      })
      .sort((a, b) => b.score - a.score); // Sort by Score DESC

    if (scoredNannies.length > 0) {
      console.log(
        `Found ${scoredNannies.length} potential matches for request ${requestId}. Attempting assignment...`,
      );

      for (const bestMatch of scoredNannies) {
        console.log(
          `Attempting to assign request ${requestId} to nanny ${bestMatch.id} (Score: ${bestMatch.score.toFixed(2)})`,
        );

        try {
          const assignment = await this.prisma.$transaction(
            async (tx) => {
              // 1. RE-VERIFY AVAILABILITY WITHIN TRANSACTION (Lock-and-Verify)
              // This is critical to prevent race conditions at scale.
              const overlap = await tx.bookings.findFirst({
                where: {
                  nanny_id: bestMatch.id,
                  status: "CONFIRMED",
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
                console.log(
                  `Race condition detected: Nanny ${bestMatch.id} is already booked for an overlapping slot.`,
                );
                throw new Error("NANNY_BUSY"); // Throw to rollback and try next match
              }

              // 2. Create assignment (Directly as accepted)
              const assignment = await tx.assignments.create({
                data: {
                  request_id: requestId,
                  nanny_id: bestMatch.id,
                  response_deadline: new Date(Date.now() + 15 * 60 * 1000),
                  status: "accepted",
                  responded_at: new Date(),
                  rank_position: request.assignments.length + 1,
                },
              });

              // 3. Update request status to accepted
              await tx.service_requests.update({
                where: { id: requestId },
                data: {
                  status: "accepted",
                  current_assignment_id: assignment.id,
                },
              });

              // 4. Update associated booking to CONFIRMED
              const updatedBooking = await tx.bookings.update({
                where: { request_id: requestId, status: { not: "CANCELLED" } },
                data: {
                  nanny_id: bestMatch.id,
                  status: "CONFIRMED",
                },
              });

              // 5. If subscription plan, create recurring_bookings entry
              await this.createRecurringRecord(tx, requestId, bestMatch.id);

              return { assignment, booking: updatedBooking };

              return assignment;
            },
            {
              isolationLevel: "Serializable", // Use highest isolation level to ensure no phantom reads
            },
          );

          if (assignment) {
            console.log(
              `Successfully assigned request ${requestId} to nanny ${bestMatch.id}`,
            );

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
                console.error("Failed to send auto-match parent email", err),
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
                console.error("Failed to send auto-match nanny email", err),
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
            console.log(
              `Matching Race Condition: Assignment already exists for request ${requestId}.`,
            );
            return null;
          }
          console.error(
            `Error during assignment for nanny ${bestMatch.id}:`,
            error,
          );
          // For other errors, we might want to continue or stop.
          // Let's continue for now to try other nannies if one assignment fails for transient reasons.
          continue;
        }
      }

      console.log(
        `Failed to assign any of the ${scoredNannies.length} nannies to request ${requestId}`,
      );
      // Fall through to "No matches found" notification
    }

    console.log(`No nannies found for request ${requestId}`);
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
      console.log(
        `findOne: Request ID ${id} not found. checking if it is a Booking ID...`,
      );
      const booking = await this.prisma.bookings.findUnique({
        where: { id },
        select: { request_id: true },
      });

      if (booking && booking.request_id) {
        console.log(
          `findOne: Found associated Request ID ${booking.request_id} for Booking ${id}`,
        );
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

    const service = await this.prisma.services.findUnique({
      where: { name: request.category || "CC" },
    });
    const hourlyRate = Number(service?.hourly_rate || 500);
    const { totalAmount } = PricingUtils.calculateTotal(
      hourlyRate,
      Number(request.duration_hours || 0),
      Number(request["discount_percentage"] || 0),
      Number(request["plan_duration_months"] || 1),
      request["plan_type"] || "ONE_TIME",
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
  async createRecurringRecord(tx: any, requestId: string, nannyId: string) {
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

    const endDate = new Date(dateObj);
    endDate.setMonth(endDate.getMonth() + (request.plan_duration_months || 1));

    // Convert start_time to string "HH:mm" for schema
    // In PostgreSQL Time(6), it usually comes back as a Date or String depending on Prisma version
    let startTimeStr = "09:00";
    if (request.start_time instanceof Date) {
      startTimeStr = request.start_time.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      });
    } else if (typeof request.start_time === "string") {
      startTimeStr = request.start_time.slice(0, 5);
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

  async findAllByParent(parentId: string) {
    const [requests, allServices] = await Promise.all([
      this.prisma.service_requests.findMany({
        where: {
          parent_id: parentId,
          // Only return requests that DO NOT have an active booking yet.
          // This prevents duplication on the frontend dashboard between "Requests" and "Bookings".
          bookings: {
            OR: [
              { id: { equals: undefined } }, // This effectively means no booking
              { status: "CANCELLED" },
            ],
          },
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
      }),
      this.prisma.services.findMany(),
    ]);

    const serviceMap = Object.fromEntries(
      allServices.map((s) => [s.name, Number(s.hourly_rate)]),
    );

    return requests.map((req) => {
      const rate = serviceMap[req.category as string] || 500;
      const { totalAmount } = PricingUtils.calculateTotal(
        rate,
        Number(req.duration_hours || 0),
        Number(req["discount_percentage"] || 0),
        Number(req["plan_duration_months"] || 1),
        req["plan_type"] || "ONE_TIME",
      );

      // Extract nanny from the first pending assignment for the frontend
      const nanny = req.assignments?.[0]?.users;

      return {
        ...req,
        hourly_rate: rate,
        total_amount: totalAmount,
        nanny,
      };
    });
  }
}

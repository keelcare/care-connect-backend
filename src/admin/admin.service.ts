import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { FavoritesService } from "../favorites/favorites.service";
import { ChatService } from "../chat/chat.service";
import { RequestsService } from "../requests/requests.service";
import { CATEGORY_SKILL_MAP } from "../constants";
import { Prisma } from "@prisma/client";
import { SseService } from "../sse/sse.service";
import { SSE_EVENTS } from "../events/sse-event.types";
import { DisputesService } from "../disputes/disputes.service";
import { MailService } from "../mail/mail.service";
import { TimeUtils } from "../common/utils/time.utils";
import { PricingEngineService } from "../common/pricing.service";
import { AvailabilityService } from "../availability/availability.service";
import { BookingStatus } from "../common/constants/booking-status.enum";
import { MATCHING_RADIUS_KM, ASSIGNMENT_RESPONSE_DEADLINE_MS } from "../common/constants/constants";
import { PaginationDto } from "./dto/pagination.dto";
import { AdminAuditService } from "./admin-audit.service";
import { EncryptionService } from "../common/services/encryption.service";

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private favoritesService: FavoritesService,
    private chatService: ChatService,
    @Inject(forwardRef(() => RequestsService))
    private requestsService: RequestsService,
    private sseService: SseService,
    private disputesService: DisputesService,
    private mailService: MailService,
    private availabilityService: AvailabilityService,
    private auditService: AdminAuditService,
    private pricingService: PricingEngineService,
    private encryptionService: EncryptionService,
  ) {}

  // Manual Assignment Management
  async getManualAssignmentRequests() {
    const requests = await this.prisma.service_requests.findMany({
      where: {
        status: "pending",
        category: { in: ["ST", "SN"] },
      },
      include: {
        users: {
          select: {
            email: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
                address: true,
                phone: true,
              },
            },
          },
        },
        bookings: {
          where: { status: { not: BookingStatus.CANCELLED } },
          include: {
            booking_children: {
              include: {
                children: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });



    const standardMapped = await Promise.all(requests.map(async (req) => {
      const parent = req.users;
      const profile = parent?.profiles;
      const booking = req.bookings?.[0];
      const children =
        booking?.booking_children?.map((bc) => bc.children) || [];

      const { totalAmount, appliedRate } = await this.pricingService.calculateCost(
        req.category || "CC",
        Number(req.duration_hours),
        Number((req as any).plan_duration_months || 1),
        (req as any).plan_type || "ONE_TIME",
        (req as any).sessions_per_month,
      );

      return {
        id: req.id,
        category: req.category,
        date: req.date,
        start_time: req.start_time,
        duration_hours: req.duration_hours,
        status: req.status,
        location_lat: req.location_lat,
        location_lng: req.location_lng,
        address: profile?.address || "Location not specified",
        parent_name: profile
          ? `${profile.first_name} ${profile.last_name}`
          : "Unknown Parent",
        hourly_rate: appliedRate,
        total_amount: totalAmount,
        created_at: req.created_at,
        children_count: req.num_children || children.length,
        children_names:
          children.length > 0
            ? children.map((c) => c.first_name).join(", ")
            : "Details not specified",
        parent: {
          id: req.parent_id,
          email: parent?.email,
          first_name: profile?.first_name,
          last_name: profile?.last_name,
          phone: profile?.phone,
          address: profile?.address,
        },
        children: children.map((c) => ({
          id: c.id,
          first_name: c.first_name,
          last_name: c.last_name,
          age: c.dob
            ? Math.floor(
                (new Date().getTime() - new Date(c.dob).getTime()) /
                  (1000 * 60 * 60 * 24 * 365.25),
              )
            : null,
          profile_type: c.profile_type,
          diagnosis: c.diagnosis,
          care_instructions: c.care_instructions,
        })),
        special_requirements: req.special_requirements,
        required_skills: req.required_skills,
        is_recurring: false,
      };
    }));

    const recurringRequests = await this.prisma.recurring_service_requests.findMany({
      where: { status: "active" },
      include: {
        users: {
          select: {
            email: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
                address: true,
                phone: true,
              },
            },
          },
        },
        bookings: {
          where: { status: { not: BookingStatus.CANCELLED } },
          include: {
            booking_children: {
              include: {
                children: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const unassignedRecurring = recurringRequests.filter(req =>
      req.bookings.some(b => !b.nanny_id && b.status === "requested")
    );

    const recurringMapped = await Promise.all(unassignedRecurring.map(async (req) => {
      const parent = req.users;
      const profile = parent?.profiles;
      const booking = req.bookings?.[0];
      const children = booking?.booking_children?.map((bc) => bc.children) || [];

      const { totalAmount, appliedRate } = await this.pricingService.calculateCost(
        req.category || "CC",
        Number(req.duration_hours),
        Number(req.plan_duration_months || 1),
        req.plan_type || "ONE_TIME",
        req.sessions_per_month || req.bookings.length,
      );

      return {
        id: req.id,
        category: req.category || "Recurring",
        date: req.start_date,
        start_time: req.start_time,
        duration_hours: req.duration_hours,
        status: req.status,
        location_lat: req.location_lat,
        location_lng: req.location_lng,
        address: profile?.address || "Location not specified",
        parent_name: profile
          ? `${profile.first_name} ${profile.last_name}`
          : "Unknown Parent",
        hourly_rate: appliedRate,
        total_amount: totalAmount,
        created_at: req.created_at,
        children_count: req.num_children || children.length,
        children_names:
          children.length > 0
            ? children.map((c) => c.first_name).join(", ")
            : "Details not specified",
        parent: {
          id: req.parent_id,
          email: parent?.email,
          first_name: profile?.first_name,
          last_name: profile?.last_name,
          phone: profile?.phone,
          address: profile?.address,
        },
        children: children.map((c) => ({
          id: c.id,
          first_name: c.first_name,
          last_name: c.last_name,
          age: c.dob
            ? Math.floor(
                (new Date().getTime() - new Date(c.dob).getTime()) /
                  (1000 * 60 * 60 * 24 * 365.25),
              )
            : null,
          profile_type: c.profile_type,
          diagnosis: c.diagnosis,
          care_instructions: c.care_instructions,
        })),
        special_requirements: req.special_requirements,
        required_skills: req.required_skills,
        is_recurring: true,
        total_sessions: req.bookings.length,
      };
    }));

    return [...standardMapped, ...recurringMapped].sort(
      (a, b) => new Date(b.created_at as any).getTime() - new Date(a.created_at as any).getTime()
    );
  }

  async getAvailableNanniesForRequest(id: string) {
    try {
      let request: any = await this.prisma.service_requests.findUnique({
        where: { id },
      });

      let actualStartTime: Date;
      let requestEndTime: Date;

      if (!request) {
        // Fallback: Check if it's a recurring request ID or a booking ID
        const recurringReq = await this.prisma.recurring_service_requests.findUnique({
          where: { id }
        });

        if (recurringReq) {
          request = {
            category: recurringReq.category || "Recurring",
            location_lat: recurringReq.location_lat,
            location_lng: recurringReq.location_lng,
            parent_id: recurringReq.parent_id,
          };
          actualStartTime = TimeUtils.combineDateAndTime(
            recurringReq.start_date,
            recurringReq.start_time,
          );
          requestEndTime = TimeUtils.getEndTime(
            actualStartTime,
            Number(recurringReq.duration_hours),
          );
        } else {
          const booking = await this.prisma.bookings.findUnique({
            where: { id },
            include: { recurring_service_requests: true }
          });

          if (booking) {
            request = {
              category: booking.recurring_service_requests?.category || "Recurring",
              location_lat: booking.recurring_service_requests?.location_lat || 0,
              location_lng: booking.recurring_service_requests?.location_lng || 0,
              parent_id: booking.parent_id,
            };
            actualStartTime = booking.start_time!;
            requestEndTime = booking.end_time!;
          } else {
            throw new NotFoundException("Request, Booking, or Recurring Request not found");
          }
        }
      } else {
        actualStartTime = TimeUtils.combineDateAndTime(
          request.date,
          request.start_time,
        );
        requestEndTime = TimeUtils.getEndTime(
          actualStartTime,
          Number(request.duration_hours),
        );
      }

      // Logic adapted from RequestsService.triggerMatching
      const radiusKm = MATCHING_RADIUS_KM;
      const category = request.category;
      const mappedSkills = CATEGORY_SKILL_MAP[category] || [];
      const skillSearchTerms = [category, ...mappedSkills].filter(Boolean);

      // Find Busy Nannies
      const busyNannies = await this.prisma.bookings.findMany({
        where: {
          nanny_id: { not: null },
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS, BookingStatus.REQUESTED] },
          AND: [
            { start_time: { lt: requestEndTime } },
            { end_time: { gt: actualStartTime } },
          ],
        },
        select: { nanny_id: true },
      });
      const busyNannyIds = busyNannies.map((b) => b.nanny_id);

      // Also find nannies with explicit blocks
      const blockedNannies = await this.prisma.availability_blocks.findMany();
      const blockedNannyIds: string[] = [];
      for (const block of blockedNannies) {
        const isUnavailable = this.availabilityService.doesBlockOverlap(
          block,
          actualStartTime,
          requestEndTime,
        );
        if (isUnavailable) {
          blockedNannyIds.push(block.nanny_id);
        }
      }

      const allExcludedIds = [
        ...new Set([...busyNannyIds, ...blockedNannyIds]),
      ];

      // Get basic nanny list within radius and matching skills
      // Note: acos input is capped at [-1, 1] to prevent NaN due to floating point precision errors
      const nannies = (await this.prisma.$queryRaw(Prisma.sql`
        SELECT 
          u.id, 
          u.email,
          nd.skills,
          nd.experience_years,
          nd.acceptance_rate,
          nd.bio,
          p.first_name,
          p.last_name,
          COALESCE(p.location_address, p.address) AS address,
          p.profile_image_url,
          (6371 * acos(
            LEAST(1.0, GREATEST( -1.0, 
              cos(radians(${Number(request.location_lat)})) * cos(radians(CAST(p.lat AS float))) * cos(radians(CAST(p.lng AS float)) - radians(${Number(request.location_lng)})) + 
              sin(radians(${Number(request.location_lat)})) * sin(radians(CAST(p.lat AS float)))
            ))
          )) AS distance
        FROM users u
        JOIN profiles p ON u.id = p.user_id
        JOIN nanny_details nd ON u.id = nd.user_id
        WHERE u.role = 'nanny'
        AND nd.is_available_now = true
        ${allExcludedIds.length > 0 ? Prisma.sql`AND u.id != ALL(ARRAY[${Prisma.join(allExcludedIds)}]::uuid[])` : Prisma.empty}
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
        AND (6371 * acos(
            LEAST(1.0, GREATEST( -1.0,
              cos(radians(${Number(request.location_lat)})) * cos(radians(CAST(p.lat AS float))) * cos(radians(CAST(p.lng AS float)) - radians(${Number(request.location_lng)})) + 
              sin(radians(${Number(request.location_lat)})) * sin(radians(CAST(p.lat AS float)))
            ))
          )) < ${radiusKm}
      `)) as any[];

      const favoriteNannyIds = await this.favoritesService.getFavoriteNannyIds(
        request.parent_id,
      );

      const availableNannies = nannies.map((n) => {
        // Calculate Score Breakdown
        const skillsArr = n.skills || [];
        const matchingSkills = skillsArr.filter((s: string) =>
          skillSearchTerms.includes(s),
        );
        const skillScore = matchingSkills.length * 10;
        const experienceScore = Math.min((n.experience_years || 0) * 2, 20);
        const acceptanceScore = (n.acceptance_rate || 0) / 10;
        const favoriteBonus = favoriteNannyIds.includes(n.id) ? 15 : 0;

        const totalScore =
          skillScore + experienceScore + acceptanceScore + favoriteBonus;

        return {
          id: n.id,
          email: n.email,
          first_name: n.first_name,
          last_name: n.last_name,
          profile_image_url: n.profile_image_url,
          address: n.address,
          bio: n.bio,
          skills: skillsArr,
          experience_years: n.experience_years || 0,
          acceptance_rate: n.acceptance_rate || 0,
          distance_km: n.distance ? Number(Number(n.distance).toFixed(2)) : 0,
          is_favorite: favoriteNannyIds.includes(n.id),
          match_details: {
            matching_skills: matchingSkills,
            score_breakdown: {
              skills: skillScore,
              experience: experienceScore,
              acceptance_rate: acceptanceScore,
              favorite_bonus: favoriteBonus,
            },
            total_score: totalScore,
          },
        };
      });

      return availableNannies.sort(
        (a, b) => b.match_details.total_score - a.match_details.total_score,
      );
    } catch (error) {
      console.error("[AdminService] Error finding nannies:", error);
      throw error;
    }
  }

  async manuallyAssignNanny(requestId: string | undefined, nannyId: string, bookingId?: string, force?: boolean) {
    let request: any;
    let actualStartTime: Date | null = null;
    let requestEndTime: Date | null = null;
    let isRecurring = false;
    let recurringBookings: any[] = [];

    if (bookingId) {
      const booking = await this.prisma.bookings.findUnique({
        where: { id: bookingId },
        include: { users_bookings_parent_idTousers: { include: { profiles: true } } },
      });
      if (!booking) throw new NotFoundException("Booking not found");
      if (booking.status !== "requested" && booking.status !== "pending_assignment")
        throw new BadRequestException(`Booking is already ${booking.status}`);
        
      request = {
        category: "Recurring", // Fallback or fetch from recurring_service_requests
        date: booking.start_time,
        start_time: booking.start_time,
        duration_hours: (booking.end_time!.getTime() - booking.start_time!.getTime()) / 3600000,
        parent_id: booking.parent_id,
        users: booking.users_bookings_parent_idTousers,
      };
      actualStartTime = booking.start_time!;
      requestEndTime = booking.end_time!;
    } else if (requestId) {
      request = await this.prisma.service_requests.findUnique({
        where: { id: requestId },
        include: { users: { include: { profiles: true } } },
      });

      if (!request) {
        request = await this.prisma.recurring_service_requests.findUnique({
          where: { id: requestId },
          include: { 
            users: { include: { profiles: true } },
            bookings: { where: { status: { not: BookingStatus.CANCELLED }, nanny_id: null } }
          },
        });
        if (request) {
          isRecurring = true;
          recurringBookings = request.bookings || [];
        }
      }

      if (!request) throw new NotFoundException("Request not found");
      if (request.status !== "pending" && request.status !== "active")
        throw new BadRequestException(`Request is already ${request.status}`);
      
      if (!isRecurring) {
        // Calculate times for overlap check
        actualStartTime = TimeUtils.combineDateAndTime(
          request.date,
          request.start_time,
        );
        requestEndTime = TimeUtils.getEndTime(
          actualStartTime,
          Number(request.duration_hours),
        );
      }
    } else {
      throw new BadRequestException("Either requestId or bookingId must be provided");
    }

    const nanny = await this.prisma.users.findUnique({
      where: { id: nannyId },
      include: {
        nanny_details: true,
        profiles: true,
      },
    });
    if (!nanny || nanny.role !== "nanny")
      throw new NotFoundException("Nanny not found");

    const result = await this.prisma.$transaction(
      async (tx) => {
        let overlaps: string[] = [];

        if (isRecurring) {
           for (const b of recurringBookings) {
             const bStart = b.start_time;
             const bEnd = b.end_time;
             const overlap = await tx.bookings.findFirst({
               where: {
                 nanny_id: nannyId,
                 status: { in: [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS, BookingStatus.REQUESTED] },
                 AND: [
                   { start_time: { lt: bEnd } },
                   { end_time: { gt: bStart } },
                 ],
               },
             });
             const isAvail = await this.availabilityService.isNannyAvailable(nannyId, bStart, bEnd);
             if (overlap || !isAvail) {
                overlaps.push(bStart.toISOString().split('T')[0]);
             }
           }
        } else {
           // 1. Double check availability
           const overlap = await tx.bookings.findFirst({
             where: {
               nanny_id: nannyId,
               status: { in: [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS, BookingStatus.REQUESTED] },
               AND: [
                 { start_time: { lt: requestEndTime! } },
                 { end_time: { gt: actualStartTime! } },
               ],
             },
           });

           if (overlap) {
             overlaps.push(actualStartTime!.toISOString().split('T')[0]);
           } else {
             const isAvailable = await this.availabilityService.isNannyAvailable(
               nannyId,
               actualStartTime!,
               requestEndTime!,
             );
             if (!isAvailable) overlaps.push(actualStartTime!.toISOString().split('T')[0]);
           }
        }

        if (overlaps.length > 0 && !force) {
           throw new BadRequestException({
             message: isRecurring 
               ? "Nanny has overlapping bookings or is unavailable on some days in this recurring plan."
               : "Nanny is already booked or unavailable for this time slot.",
             overlaps,
             warning: true
           });
        }

        let assignmentId = "recurring-assignment";

        if (!isRecurring) {
          // 2. Create Assignment (directly accepted)
          const assignmentData = {
            response_deadline: new Date(Date.now() + ASSIGNMENT_RESPONSE_DEADLINE_MS),
            status: "accepted",
            responded_at: new Date(),
            rank_position: 1,
            nanny_id: nannyId,
            ...(bookingId ? { booking_id: bookingId } : { request_id: requestId }),
          };

          const existingAssignment = await tx.assignments.findFirst({
            where: bookingId ? { booking_id: bookingId, nanny_id: nannyId } : { request_id: requestId, nanny_id: nannyId }
          });

          let assignment;
          if (existingAssignment) {
            assignment = await tx.assignments.update({
              where: { id: existingAssignment.id },
              data: { ...assignmentData, rejection_reason: null },
            });
          } else {
            assignment = await tx.assignments.create({
              data: assignmentData,
            });
          }
          assignmentId = assignment.id;
        }

        // 3. Update Request or Booking Status
        if (requestId && !isRecurring) {
          await tx.service_requests.update({
            where: { id: requestId },
            data: {
              status: "accepted",
              current_assignment_id: assignmentId,
            },
          });

          await tx.bookings.updateMany({
            where: { request_id: requestId, status: { not: BookingStatus.CANCELLED } },
            data: {
              nanny_id: nannyId,
              status: BookingStatus.CONFIRMED,
            },
          });
        } else if (isRecurring) {
          await tx.bookings.updateMany({
            where: { recurring_request_id: requestId, status: { not: BookingStatus.CANCELLED }, nanny_id: null },
            data: { nanny_id: nannyId, status: BookingStatus.CONFIRMED }
          });
        } else if (bookingId) {
          await tx.bookings.update({
            where: { id: bookingId },
            data: {
              nanny_id: nannyId,
              status: BookingStatus.CONFIRMED,
            },
          });
        }

        // 4.5 Create Recurring Booking Record if subscription
        if (requestId && !isRecurring) {
          await this.requestsService.createRecurringRecord(
            tx,
            requestId,
            nannyId,
          );
        }

        return { success: true, assignmentId };
      },
      { isolationLevel: "ReadCommitted" },
    );

    // Send Confirmation Emails (Outside transaction but after success)
    const parent = (request as any).users;
    const parentName =
      `${parent.profiles?.first_name || ""} ${parent.profiles?.last_name || ""}`.trim() ||
      "Parent";
    const nannyName =
      `${nanny.profiles?.first_name || ""} ${nanny.profiles?.last_name || ""}`.trim() ||
      "Nanny";

    const bookingDetails = {
      date: isRecurring ? request.start_date.toISOString().split("T")[0] + " (Starts)" : request.date.toISOString().split("T")[0],
      time: request.start_time.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      duration: Number(request.duration_hours),
      location: parent.profiles?.address || "Location specified in profile",
    };

    // Email to Parent
    this.mailService
      .sendBookingConfirmationEmail(parent.email, parentName, "parent", {
        ...bookingDetails,
        otherPartyName: nannyName,
      })
      .catch((err) =>
        console.error("Failed to send manual assignment parent email", err),
      );

    // Email to Nanny
    this.mailService
      .sendBookingConfirmationEmail(nanny.email, nannyName, "nanny", {
        ...bookingDetails,
        otherPartyName: parentName,
      })
      .catch((err) =>
        console.error("Failed to send manual assignment nanny email", err),
      );

    // --- Side Effects (Outside Transaction) ---

    // Fetch the updated booking for chat creation
    const updatedBooking = await this.prisma.bookings.findFirst({
      where: isRecurring 
        ? { recurring_request_id: requestId, status: BookingStatus.CONFIRMED }
        : { request_id: requestId, status: BookingStatus.CONFIRMED },
    });

    if (updatedBooking) {
      try {
        await this.chatService.createChat(updatedBooking.id);
      } catch (e) {
        console.error("Manual Assignment: Failed to create chat", e);
      }
    }

    // 5. Notifications
    try {
      await this.notificationsService.createNotification(
        nannyId,
        "New Manual Assignment",
        `Admin has manually assigned you to a ${request.category} request. Tap to view details.`,
        "info",
      );

      await this.notificationsService.createNotification(
        request.parent_id,
        "Nanny Assigned!",
        `We have manually assigned a nanny for your ${request.category} request. Tap to view details.`,
        "success",
      );

      // 6. SSE Real-time Events
      const timestamp = new Date().toISOString();

      // Parent dashboard refreshes
      this.sseService.emitToUser(request.parent_id, {
        type: SSE_EVENTS.ASSIGNMENT_ACCEPTED,
        data: { requestId: request.id, nannyId },
        timestamp,
      });

      this.sseService.emitToUser(request.parent_id, {
        type: SSE_EVENTS.BOOKING_UPDATED,
        data: { requestId: request.id },
        timestamp,
      });

      // Nanny dashboard gets new assignment
      this.sseService.emitToUser(nannyId, {
        type: SSE_EVENTS.ASSIGNMENT_CREATED,
        data: { requestId: request.id },
        timestamp,
      });
    } catch (e) {
      console.error(
        "Manual Assignment: Failed to send notifications or SSE",
        e,
      );
    }

    return result;
  }

  // Category Request Management
  async getCategoryRequests(status: string = "pending") {
    return this.prisma.nanny_category_requests.findMany({
      where: { status },
      include: {
        users: {
          select: {
            email: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });
  }

  async updateCategoryRequestStatus(
    requestId: string,
    status: "approved" | "rejected",
    adminNotes?: string,
    adminId?: string,
    ipAddress?: string,
  ) {
    return this.prisma.$transaction(async (prisma) => {
      const existingRequest = await prisma.nanny_category_requests.findUnique({
        where: { id: requestId },
      });

      if (!existingRequest) {
        throw new NotFoundException("Category request not found");
      }

      if (existingRequest.status !== "pending") {
        throw new BadRequestException(
          `Request is already ${existingRequest.status}`,
        );
      }

      const request = await prisma.nanny_category_requests.update({
        where: { id: requestId },
        data: {
          status,
          admin_notes: adminNotes,
          updated_at: new Date(),
        },
      });

      if (status === "approved") {
        // Use upsert to handle cases where nanny_details record doesn't exist yet
        await prisma.nanny_details.upsert({
          where: { user_id: request.nanny_id },
          update: {
            categories: request.requested_categories,
            tags: request.requested_categories, // Sync to tags for backward compatibility
            updated_at: new Date(),
          },
          create: {
            user_id: request.nanny_id,
            categories: request.requested_categories,
            tags: request.requested_categories, // Sync to tags for backward compatibility
          },
        });
      }

      return request;
    }).then(async (result) => {
      if (adminId) {
        await this.auditService.logAction({
          adminId,
          action: status === "approved" ? "APPROVE_CATEGORY_REQUEST" : "REJECT_CATEGORY_REQUEST",
          targetType: "nanny_category_request",
          targetId: requestId,
          metadata: { status, adminNotes },
          ipAddress,
        });
      }
      return result;
    });
  }

  // User Management
  async getAllUsers(query?: PaginationDto) {
    const page = query?.page || 1;
    const pageSize = query?.pageSize || 10;
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.users.findMany({
        skip,
        take,
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          email: true,
          role: true,
          is_verified: true,
          is_active: true,
          ban_reason: true,
          created_at: true,
          profiles: {
            select: {
              first_name: true,
              last_name: true,
            },
          },
        },
      }),
      this.prisma.users.count()
    ]);

    return {
      items,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    };
  }

  async getUserFullProfile(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        is_verified: true,
        is_active: true,
        ban_reason: true,
        identity_verification_status: true,
        verification_rejection_reason: true,
        created_at: true,
        profiles: true,
        nanny_details: true,
        nanny_onboarding_details: true,
        identity_documents: {
          select: {
            id: true,
            type: true,
            file_path: true,
            uploaded_at: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    if (user.nanny_onboarding_details?.previous_salary) {
      (user.nanny_onboarding_details as any).previous_salary =
        this.encryptionService.decrypt(
          user.nanny_onboarding_details.previous_salary,
        );
    }

    if (user.role !== "nanny") {
      return user;
    }

    const [reviews, bookingStats] = await Promise.all([
      this.prisma.reviews.findMany({
        where: { reviewee_id: userId, is_approved: true },
        select: { rating: true },
      }),
      this.prisma.bookings.groupBy({
        by: ["status"],
        where: { nanny_id: userId },
        _count: { status: true },
      }),
    ]);

    const totalReviews = reviews.length;
    const averageRating =
      totalReviews > 0
        ? Math.round(
            (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) /
              totalReviews) *
              10,
          ) / 10
        : null;

    const bookings = bookingStats.reduce(
      (acc, row) => {
        acc.total += row._count.status;
        acc[row.status ?? "unknown"] = row._count.status;
        return acc;
      },
      { total: 0 } as Record<string, number>,
    );

    return { ...user, averageRating, totalReviews, bookings };
  }

  async verifyUser(userId: string, adminId?: string, ipAddress?: string) {
    const result = await this.prisma.users.update({
      where: { id: userId },
      data: { is_verified: true },
    });
    if (adminId) {
      await this.auditService.logAction({
        adminId,
        action: "VERIFY_USER",
        targetType: "user",
        targetId: userId,
        ipAddress,
      });
    }
    return result;
  }

  async banUser(userId: string, reason?: string, adminId?: string, ipAddress?: string) {
    const result = await this.prisma.users.update({
      where: { id: userId },
      data: {
        is_active: false,
        ban_reason: reason,
      },
    });
    if (adminId) {
      await this.auditService.logAction({
        adminId,
        action: "BAN_USER",
        targetType: "user",
        targetId: userId,
        metadata: { reason },
        ipAddress,
      });
    }
    return result;
  }

  async unbanUser(userId: string, adminId?: string, ipAddress?: string) {
    const result = await this.prisma.users.update({
      where: { id: userId },
      data: {
        is_active: true,
        ban_reason: null,
      },
    });
    if (adminId) {
      await this.auditService.logAction({
        adminId,
        action: "UNBAN_USER",
        targetType: "user",
        targetId: userId,
        ipAddress,
      });
    }
    return result;
  }

  // Booking Management
  async getAllBookings(query?: PaginationDto) {
    const page = query?.page || 1;
    const pageSize = query?.pageSize || 10;
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.bookings.findMany({
        skip,
        take,
        orderBy: { created_at: "desc" },
        include: {
          jobs: true,
          service_requests: true,
          users_bookings_parent_idTousers: {
            select: {
              email: true,
              profiles: {
                select: {
                  first_name: true,
                  last_name: true,
                },
              },
            },
          },
          users_bookings_nanny_idTousers: {
            select: {
              email: true,
              profiles: {
                select: {
                  first_name: true,
                  last_name: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.bookings.count()
    ]);

    return {
      items,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    };
  }

  async getAllRecurringRequests(query?: PaginationDto) {
    const page = query?.page || 1;
    const pageSize = query?.pageSize || 10;
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.recurring_service_requests.findMany({
        skip,
        take,
        orderBy: { created_at: "desc" },
        include: {
          users: {
            select: {
              email: true,
              profiles: {
                select: {
                  first_name: true,
                  last_name: true,
                },
              },
            },
          },
          _count: {
            select: { bookings: { where: { status: { not: "CANCELLED" } } } }
          },
          bookings: {
            where: { start_time: { gte: new Date() }, status: { not: "CANCELLED" } },
            orderBy: { start_time: 'asc' },
            take: 1,
            select: { start_time: true }
          }
        },
      }),
      this.prisma.recurring_service_requests.count()
    ]);

    return {
      items: items.map(req => {
        const { bookings, _count, ...rest } = req;
        return {
          ...rest,
          start_time_formatted: TimeUtils.formatShortTime(req.start_time),
          total_bookings: _count.bookings,
          next_upcoming_date: bookings.length > 0 ? bookings[0].start_time : null
        };
      }),
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    };
  }

  // Dispute Resolution (Delegated to DisputesService)
  async getAllDisputes() {
    return this.disputesService.findAll();
  }

  async getDisputeById(id: string) {
    return this.disputesService.findOne(id);
  }

  async resolveDispute(id: string, resolution: string, resolvedBy: string, ipAddress?: string) {
    const result = await this.disputesService.resolve(id, resolvedBy, { resolution });
    await this.auditService.logAction({
      adminId: resolvedBy,
      action: "RESOLVE_DISPUTE",
      targetType: "dispute",
      targetId: id,
      metadata: { resolution },
      ipAddress,
    });
    return result;
  }

  // Payment Monitoring
  async getAllPayments(query?: PaginationDto) {
    const page = query?.page || 1;
    const pageSize = query?.pageSize || 10;
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.payments.findMany({
        skip,
        take,
        orderBy: { created_at: "desc" },
        include: {
          bookings: {
            include: {
              users_bookings_parent_idTousers: {
                select: {
                  email: true,
                  profiles: { select: { first_name: true, last_name: true } },
                },
              },
              users_bookings_nanny_idTousers: {
                select: {
                  email: true,
                  profiles: { select: { first_name: true, last_name: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.payments.count()
    ]);

    return {
      items,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    };
  }

  async getPaymentStats() {
    const [totalPayments, totalAmount, pendingPayments] = await Promise.all([
      this.prisma.payments.count(),
      this.prisma.payments.aggregate({ _sum: { amount: true } }),
      this.prisma.payments.count({ where: { status: "pending_release" } }),
    ]);

    return {
      totalPayments,
      totalAmount: totalAmount._sum.amount || 0,
      pendingPayments,
    };
  }

  async getAllPaymentPlans() {
    return this.prisma.payment_plans.findMany({
      orderBy: { created_at: "desc" },
      include: {
        bookings: {
          include: {
            users_bookings_parent_idTousers: {
              select: {
                email: true,
                profiles: { select: { first_name: true, last_name: true } },
              },
            },
            service_requests: { select: { category: true } },
          },
        },
        price_snapshots: {
          orderBy: { cycle_number: "asc" },
        },
      },
    });
  }

  async getPaymentPlanStats() {
    const [totalPlans, activePlans, completedPlans, installmentsAmount] = await Promise.all([
      this.prisma.payment_plans.count(),
      this.prisma.payment_plans.count({ where: { status: "active" } }),
      this.prisma.payment_plans.count({ where: { status: "completed" } }),
      this.prisma.price_snapshots.aggregate({
        _sum: { final_amount: true },
        where: { status: "charged" },
      }),
    ]);

    return {
      totalPlans,
      activePlans,
      completedPlans,
      totalCollected: installmentsAmount._sum.final_amount || 0,
    };
  }

  // Review Moderation
  async getAllReviews(query?: PaginationDto) {
    const page = query?.page || 1;
    const pageSize = query?.pageSize || 10;
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.reviews.findMany({
        skip,
        take,
        orderBy: { created_at: "desc" },
        include: {
          users_reviews_reviewer_idTousers: {
            select: {
              email: true,
              profiles: { select: { first_name: true, last_name: true } },
            },
          },
          users_reviews_reviewee_idTousers: {
            select: {
              email: true,
              profiles: { select: { first_name: true, last_name: true } },
            },
          },
          bookings: true,
        },
      }),
      this.prisma.reviews.count()
    ]);

    return {
      items,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    };
  }

  async approveReview(id: string) {
    return this.prisma.reviews.update({
      where: { id },
      data: {
        is_approved: true,
        moderation_status: "approved",
      },
    });
  }

  async rejectReview(id: string) {
    return this.prisma.reviews.update({
      where: { id },
      data: {
        is_approved: false,
        moderation_status: "rejected",
      },
    });
  }

  // Matching Configuration
  async getSettings() {
    return this.prisma.system_settings.findMany();
  }

  async getSetting(key: string) {
    return this.prisma.system_settings.findUnique({
      where: { key },
    });
  }

  async updateSetting(key: string, value: any, adminId?: string, ipAddress?: string) {
    const result = await this.prisma.system_settings.upsert({
      where: { key },
      update: { value, updated_at: new Date() },
      create: { key, value },
    });
    if (adminId) {
      await this.auditService.logAction({
        adminId,
        action: "UPDATE_SETTING",
        targetType: "system_setting",
        metadata: { key, value },
        ipAddress,
      });
    }
    return result;
  }

  // Analytics
  async getDashboardData() {
    const [stats, advancedStats, bookings] = await Promise.all([
      this.getSystemStats(),
      this.getAdvancedStats(),
      this.getAllBookings(),
    ]);

    return {
      stats,
      advancedStats,
      bookings,
    };
  }

  async getSystemStats() {
    const [totalUsers, totalBookings, activeBookings] = await Promise.all([
      this.prisma.users.count(),
      this.prisma.bookings.count(),
      this.prisma.bookings.count({ where: { status: BookingStatus.IN_PROGRESS } }),
    ]);

    return {
      totalUsers,
      totalBookings,
      activeBookings,
    };
  }

  async getAdvancedStats() {
    const [
      totalRequests,
      completedBookings,
      cancelledBookings,
      totalAssignments,
      acceptedAssignments,
      revenueData,
      bookings,
    ] = await Promise.all([
      this.prisma.service_requests.count(),
      this.prisma.bookings.count({ where: { status: BookingStatus.COMPLETED } }),
      this.prisma.bookings.count({ where: { status: BookingStatus.CANCELLED } }),
      this.prisma.assignments.count(),
      this.prisma.assignments.count({ where: { status: "accepted" } }),
      this.prisma.payments.aggregate({ _sum: { amount: true } }),
      this.prisma.bookings.findMany({
        where: { start_time: { not: null } },
        select: { start_time: true },
      }),
    ]);

    const completionRate =
      totalRequests > 0 ? (completedBookings / totalRequests) * 100 : 0;

    const acceptanceRate =
      totalAssignments > 0 ? (acceptedAssignments / totalAssignments) * 100 : 0;

    const totalRevenue = revenueData._sum.amount || 0;

    // Matching Health Metrics
    const matchingSuccessRate =
      totalAssignments > 0 ? (acceptedAssignments / totalAssignments) * 100 : 0;

    // Outcome Breakdown
    const [timedOutAssignments, rejectedAssignments] = await Promise.all([
      this.prisma.assignments.count({ where: { status: "timeout" } }),
      this.prisma.assignments.count({ where: { status: "rejected" } }),
    ]);

    // Popular service times (simplified - count by hour of day)
    const hourCounts = new Array(24).fill(0);
    bookings.forEach((booking) => {
      if (booking.start_time) {
        const hour = new Date(booking.start_time).getHours();
        hourCounts[hour]++;
      }
    });

    const popularTimes = hourCounts
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      completionRate: Math.round(completionRate * 10) / 10,
      acceptanceRate: Math.round(acceptanceRate * 10) / 10,
      matchingSuccessRate: Math.round(matchingSuccessRate * 10) / 10,
      outcomes: {
        accepted: acceptedAssignments,
        timedOut: timedOutAssignments,
        rejected: rejectedAssignments,
      },
      totalRevenue,
      popularTimes,
      totalRequests,
      completedBookings,
      cancelledBookings,
    };
  }
}

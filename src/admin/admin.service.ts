import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from "@nestjs/common";
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
import { PricingUtils } from "../common/utils/pricing.utils";
import { AvailabilityService } from "../availability/availability.service";

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
  ) { }

  // Manual Assignment Management
  async getManualAssignmentRequests() {
    const requests = await this.prisma.service_requests.findMany({
      where: {
        status: 'pending',
        category: { in: ['ST', 'SN'] },
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
          where: { status: { not: "CANCELLED" } },
          include: {
            booking_children: {
              include: {
                children: true
              }
            }
          }
        }
      },
      orderBy: { created_at: 'desc' },
    });

    const allServices = await this.prisma.services.findMany();
    const serviceMap = Object.fromEntries(allServices.map(s => [s.name, Number(s.hourly_rate)]));

    return requests.map(req => {
      const parent = req.users;
      const profile = parent?.profiles;
      const booking = req.bookings?.[0];
      const children = booking?.booking_children?.map(bc => bc.children) || [];

      return {
        id: req.id,
        category: req.category,
        date: req.date,
        start_time: req.start_time,
        duration_hours: req.duration_hours,
        status: req.status,
        location_lat: req.location_lat,
        location_lng: req.location_lng,
        address: profile?.address || "Location not specified", // Added for direct UI mapping
        parent_name: profile ? `${profile.first_name} ${profile.last_name}` : "Unknown Parent",
        hourly_rate: serviceMap[req.category as string] || 500,
        total_amount: PricingUtils.calculateTotal(
          serviceMap[req.category as string] || 500,
          Number(req.duration_hours),
          Number((req as any).discount_percentage || 0),
          Number((req as any).plan_duration_months || 1),
          (req as any).plan_type || 'ONE_TIME'
        ).totalAmount,
        created_at: req.created_at,
        children_count: req.num_children || children.length,
        children_names: children.length > 0
          ? children.map(c => c.first_name).join(", ")
          : "Details not specified",
        parent: {
          id: req.parent_id,
          email: parent?.email,
          first_name: profile?.first_name,
          last_name: profile?.last_name,
          phone: profile?.phone,
          address: profile?.address,
        },
        children: children.map(c => ({
          id: c.id,
          first_name: c.first_name,
          last_name: c.last_name,
          age: c.dob ? Math.floor((new Date().getTime() - new Date(c.dob).getTime()) / (1000 * 60 * 60 * 24 * 365.25)) : null,
          profile_type: c.profile_type,
          diagnosis: c.diagnosis,
          care_instructions: c.care_instructions,
        })),
        special_requirements: req.special_requirements,
        required_skills: req.required_skills,
      };
    });
  }

  async getAvailableNanniesForRequest(requestId: string) {
    try {
      const request = await this.prisma.service_requests.findUnique({
        where: { id: requestId },
      });

      if (!request) throw new NotFoundException("Request not found");

      // Logic adapted from RequestsService.triggerMatching
      const radiusKm = 15;
      const category = request.category;
      const mappedSkills = CATEGORY_SKILL_MAP[category] || [];
      const skillSearchTerms = [category, ...mappedSkills].filter(Boolean);

      // Calculate Request Times for overlap check
      const actualStartTime = TimeUtils.combineDateAndTime(request.date, request.start_time);
      const requestEndTime = TimeUtils.getEndTime(actualStartTime, Number(request.duration_hours));

      // Find Busy Nannies
      const busyNannies = await this.prisma.bookings.findMany({
        where: {
          nanny_id: { not: null },
          status: "CONFIRMED",
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
        const isUnavailable = !await this.availabilityService.isNannyAvailable(
          block.nanny_id,
          actualStartTime,
          requestEndTime
        );
        if (isUnavailable) {
          blockedNannyIds.push(block.nanny_id);
        }
      }

      const allExcludedIds = [...new Set([...busyNannyIds, ...blockedNannyIds])];

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
          p.address,
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
        ${allExcludedIds.length > 0 ? Prisma.sql`AND u.id NOT IN (${Prisma.join(allExcludedIds)})` : Prisma.empty}
        ${skillSearchTerms.length > 0 ? Prisma.sql`AND (
          EXISTS (SELECT 1 FROM unnest(nd.tags) t WHERE t IN (${Prisma.join(skillSearchTerms)}))
          OR 
          EXISTS (SELECT 1 FROM unnest(nd.skills) s WHERE s IN (${Prisma.join(skillSearchTerms)}))
          OR
          EXISTS (SELECT 1 FROM unnest(nd.categories) c WHERE c IN (${Prisma.join(skillSearchTerms)}))
        )` : Prisma.empty}
        AND (6371 * acos(
            LEAST(1.0, GREATEST( -1.0,
              cos(radians(${Number(request.location_lat)})) * cos(radians(CAST(p.lat AS float))) * cos(radians(CAST(p.lng AS float)) - radians(${Number(request.location_lng)})) + 
              sin(radians(${Number(request.location_lat)})) * sin(radians(CAST(p.lat AS float)))
            ))
          )) < ${radiusKm}
      `)) as any[];

      const favoriteNannyIds = await this.favoritesService.getFavoriteNannyIds(request.parent_id);

      const availableNannies = nannies.map((n) => {
        // Calculate Score Breakdown
        const matchingSkills = n.skills.filter((s: string) => skillSearchTerms.includes(s));
        const skillScore = matchingSkills.length * 10;
        const experienceScore = Math.min(n.experience_years * 2, 20);
        const acceptanceScore = (n.acceptance_rate || 0) / 10;
        const favoriteBonus = favoriteNannyIds.includes(n.id) ? 15 : 0;

        const totalScore = skillScore + experienceScore + acceptanceScore + favoriteBonus;

        return {
          id: n.id,
          email: n.email,
          first_name: n.first_name,
          last_name: n.last_name,
          profile_image_url: n.profile_image_url,
          address: n.address,
          bio: n.bio,
          skills: n.skills,
          experience_years: n.experience_years,
          acceptance_rate: n.acceptance_rate,
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

      return availableNannies.sort((a, b) => b.match_details.total_score - a.match_details.total_score);
    } catch (error) {
      console.error("[AdminService] Error finding nannies:", error);
      throw error;
    }
  }

  async manuallyAssignNanny(requestId: string, nannyId: string) {
    const request = await this.prisma.service_requests.findUnique({
      where: { id: requestId },
      include: { users: { include: { profiles: true } } }
    });

    if (!request) throw new NotFoundException("Request not found");
    if (request.status !== 'pending') throw new BadRequestException(`Request is already ${request.status}`);

    const nanny = await this.prisma.users.findUnique({
      where: { id: nannyId },
      include: { 
        nanny_details: true,
        profiles: true
      }
    });
    if (!nanny || nanny.role !== 'nanny') throw new NotFoundException("Nanny not found");

    // Calculate times for overlap check
    const actualStartTime = TimeUtils.combineDateAndTime(request.date, request.start_time);
    const requestEndTime = TimeUtils.getEndTime(actualStartTime, Number(request.duration_hours));

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Double check availability
      const overlap = await tx.bookings.findFirst({
        where: {
          nanny_id: nannyId,
          status: "CONFIRMED",
          AND: [
            { start_time: { lt: requestEndTime } },
            { end_time: { gt: actualStartTime } },
          ],
        },
      });

      if (overlap) throw new BadRequestException("Nanny is already booked for this slot");

      // Check explicit blocks
      const isAvailable = await this.availabilityService.isNannyAvailable(nannyId, actualStartTime, requestEndTime);
      if (!isAvailable) throw new BadRequestException("Nanny has marked themselves as unavailable for this time slot");

      // 2. Create Assignment (directly accepted)
      const assignment = await tx.assignments.create({
        data: {
          request_id: requestId,
          nanny_id: nannyId,
          response_deadline: new Date(Date.now() + 15 * 60 * 1000), // Standard deadline even if pre-accepted
          status: "accepted",
          responded_at: new Date(),
          rank_position: 1, // Manual assignment is always top rank
        },
      });

      // 3. Update Request Status
      await tx.service_requests.update({
        where: { id: requestId },
        data: {
          status: "accepted",
          current_assignment_id: assignment.id,
        },
      });

      // 4. Update Booking to CONFIRMED
      await tx.bookings.updateMany({
        where: { request_id: requestId, status: { not: "CANCELLED" } },
        data: {
          nanny_id: nannyId,
          status: "CONFIRMED",
        },
      });

      // 4.5 Create Recurring Booking Record if subscription
      await this.requestsService.createRecurringRecord(tx, requestId, nannyId);

      return { success: true, assignmentId: assignment.id };
    }, { isolationLevel: 'ReadCommitted' });

    // Send Confirmation Emails (Outside transaction but after success)
    const parent = (request as any).users;
    const parentName = `${parent.profiles?.first_name || ''} ${parent.profiles?.last_name || ''}`.trim() || 'Parent';
    const nannyName = `${nanny.profiles?.first_name || ''} ${nanny.profiles?.last_name || ''}`.trim() || 'Nanny';

    const bookingDetails = {
      date: request.date.toISOString().split('T')[0],
      time: request.start_time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      duration: Number(request.duration_hours),
      location: parent.profiles?.address || 'Location specified in profile',
    };

    // Email to Parent
    this.mailService.sendBookingConfirmationEmail(
      parent.email,
      parentName,
      'parent',
      { ...bookingDetails, otherPartyName: nannyName }
    ).catch(err => console.error("Failed to send manual assignment parent email", err));

    // Email to Nanny
    this.mailService.sendBookingConfirmationEmail(
      nanny.email,
      nannyName,
      'nanny',
      { ...bookingDetails, otherPartyName: parentName }
    ).catch(err => console.error("Failed to send manual assignment nanny email", err));

    // --- Side Effects (Outside Transaction) ---

    // Fetch the updated booking for chat creation
    const updatedBooking = await this.prisma.bookings.findFirst({
      where: { request_id: requestId, status: "CONFIRMED" }
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
      console.error("Manual Assignment: Failed to send notifications or SSE", e);
    }

    return result;
  }


  // Category Request Management
  async getCategoryRequests(status: string = 'pending') {
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
      orderBy: { created_at: 'desc' },
    });
  }

  async updateCategoryRequestStatus(requestId: string, status: 'approved' | 'rejected', adminNotes?: string) {
    return this.prisma.$transaction(async (prisma) => {
      const existingRequest = await prisma.nanny_category_requests.findUnique({
        where: { id: requestId },
      });

      if (!existingRequest) {
        throw new NotFoundException('Category request not found');
      }

      if (existingRequest.status !== 'pending') {
        throw new BadRequestException(`Request is already ${existingRequest.status}`);
      }

      const request = await prisma.nanny_category_requests.update({
        where: { id: requestId },
        data: {
          status,
          admin_notes: adminNotes,
          updated_at: new Date(),
        },
      });

      if (status === 'approved') {
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
    });
  }

  // User Management
  async getAllUsers() {
    return this.prisma.users.findMany({
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
    });
  }

  async verifyUser(userId: string) {
    return this.prisma.users.update({
      where: { id: userId },
      data: { is_verified: true },
    });
  }

  async banUser(userId: string, reason?: string) {
    return this.prisma.users.update({
      where: { id: userId },
      data: {
        is_active: false,
        ban_reason: reason,
      },
    });
  }

  async unbanUser(userId: string) {
    return this.prisma.users.update({
      where: { id: userId },
      data: {
        is_active: true,
        ban_reason: null,
      },
    });
  }

  // Booking Management
  async getAllBookings() {
    return this.prisma.bookings.findMany({
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
    });
  }

  // Dispute Resolution (Delegated to DisputesService)
  async getAllDisputes() {
    return this.disputesService.findAll();
  }

  async getDisputeById(id: string) {
    return this.disputesService.findOne(id);
  }

  async resolveDispute(id: string, resolution: string, resolvedBy: string) {
    return this.disputesService.resolve(id, resolvedBy, { resolution });
  }

  // Payment Monitoring
  async getAllPayments() {
    return this.prisma.payments.findMany({
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
    });
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

  // Review Moderation
  async getAllReviews() {
    return this.prisma.reviews.findMany({
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
    });
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

  async updateSetting(key: string, value: any) {
    return this.prisma.system_settings.upsert({
      where: { key },
      update: { value, updated_at: new Date() },
      create: { key, value },
    });
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
      this.prisma.bookings.count({ where: { status: "IN_PROGRESS" } }),
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
      bookings
    ] = await Promise.all([
      this.prisma.service_requests.count(),
      this.prisma.bookings.count({ where: { status: "COMPLETED" } }),
      this.prisma.bookings.count({ where: { status: "CANCELLED" } }),
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
    const matchingSuccessRate = totalAssignments > 0 ? (acceptedAssignments / totalAssignments) * 100 : 0;
    
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

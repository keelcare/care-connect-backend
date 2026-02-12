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
import { AiService } from "../ai/ai.service";

@Injectable()
export class RequestsService {
  constructor(
    private prisma: PrismaService,
    private usersService: UsersService,
    private notificationsService: NotificationsService,
    private favoritesService: FavoritesService,
    private aiService: AiService,
  ) { }

  async create(parentId: string, createRequestDto: CreateRequestDto) {
    console.log("Creating Request with DTO:", JSON.stringify(createRequestDto, null, 2));

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
      const { request, booking } = await this.prisma.$transaction(async (tx) => {
        // Create the service request
        const startTimeStr = createRequestDto.start_time.split(':').length === 2
          ? `${createRequestDto.start_time}:00`
          : createRequestDto.start_time;

        const request = await tx.service_requests.create({
          data: {
            parent_id: parentId,
            date: new Date(createRequestDto.date),
            start_time: new Date(`${createRequestDto.date}T${startTimeStr}+05:30`), // Explicitly Enforce IST
            duration_hours: createRequestDto.duration_hours,
            num_children: createRequestDto.num_children,
            children_ages: createRequestDto.children_ages || [],
            special_requirements: createRequestDto.special_requirements,
            required_skills: createRequestDto.required_skills || [],
            max_hourly_rate: createRequestDto.max_hourly_rate,
            location_lat: parent.profiles.lat,
            location_lng: parent.profiles.lng,
            category: createRequestDto.category,
            status: "pending",
          } as any,
        });

        // Create initial booking (Pending Assignment)
        const bookingStartTime = new Date(`${createRequestDto.date}T${startTimeStr}+05:30`);
        const bookingEndTime = new Date(bookingStartTime.getTime() + Number(request.duration_hours) * 60 * 60 * 1000);

        await tx.bookings.create({
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

        // Link children to the booking if child_ids were provided
        if (createRequestDto.child_ids && createRequestDto.child_ids.length > 0) {
          await tx.booking_children.createMany({
            data: createRequestDto.child_ids.map((childId) => ({
              booking_id: booking.id,
              child_id: childId,
            })),
          });
        }

        return { request, booking };
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

      return request;
    } catch (error) {
      console.error("Error creating service request flow:", error);
      throw error;
    }
  }

  async cancelRequest(id: string) {
    let request = await this.prisma.service_requests.findUnique({
      where: { id },
      include: {
        assignments: { where: { status: { in: ["pending", "accepted"] } } },
        bookings: { where: { status: { not: "CANCELLED" } } }
      },
    });

    // Strategy 2: If not found by Request ID, check if the ID provided is a Booking ID
    if (!request) {
      console.log(`Request ID ${id} not found. checking if it is a Booking ID...`);
      const booking = await this.prisma.bookings.findUnique({
        where: { id },
        select: { request_id: true }
      });

      if (booking && booking.request_id) {
        console.log(`Found associated Request ID ${booking.request_id} for Booking ${id}`);
        request = await this.prisma.service_requests.findUnique({
          where: { id: booking.request_id },
          include: {
            assignments: { where: { status: { in: ["pending", "accepted"] } } },
            bookings: { where: { status: { not: "CANCELLED" } } }
          },
        });
      }
    }

    if (!request) throw new NotFoundException("Request not found");

    const requestId = request.id;
    console.log(`Cancelling request ${requestId}, current status: ${request.status}`);

    // Status validation
    const allowedStatuses = ["pending", "accepted", "assigned"];
    if (!allowedStatuses.includes(request.status)) {
      // If already cancelled/completed, throw specific error
      if (request.status === "CANCELLED" || request.status === "COMPLETED") {
        throw new BadRequestException(`Cannot cancel a ${request.status} request`);
      }
      // Fallback for other statuses
      throw new BadRequestException(`Cannot cancel a request that is not pending (Current: ${request.status})`);
    }

    // 1. Cancel any pending or accepted assignments
    if (request.assignments.length > 0) {
      await this.prisma.assignments.updateMany({
        where: { request_id: requestId, status: { in: ["pending", "accepted"] } },
        data: {
          status: "cancelled",
          responded_at: new Date(),
        },
      });
    }

    // 2. Cancel associated booking if exists
    if (request.bookings.length > 0) {
      await this.prisma.bookings.updateMany({
        where: { request_id: requestId, status: { not: "CANCELLED" } },
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

    return result;
  }

  async triggerMatching(requestId: string) {
    const request = await this.prisma.service_requests.findUnique({
      where: { id: requestId },
      include: { assignments: true }, // Include previous assignments
    });

    if (!request) throw new NotFoundException("Request not found");

    // Get IDs of nannies already assigned (rejected or timeout)
    const previouslyAssignedIds = request.assignments.map((a) => a.nanny_id);

    // Calculate Request End Time directly from the date object
    let requestStartTime: Date;
    try {
      const datePart = new Date(request.date).toISOString().split('T')[0];
      const timePart = new Date(request.start_time).toISOString().split('T')[1];
      requestStartTime = new Date(`${datePart}T${timePart}`);

      if (isNaN(requestStartTime.getTime())) {
        throw new Error("Invalid start time result");
      }
    } catch (e) {
      console.error("Date parsing failed, falling back to direct date field", e);
      requestStartTime = new Date(request.date);
    }

    const requestEndTime = new Date(requestStartTime.getTime() + Number(request.duration_hours) * 60 * 60 * 1000);

    console.log(`[DEBUG] Checking Overlap for Request: ${requestId}`);
    console.log(`[DEBUG] Window: ${requestStartTime.toISOString()} - ${requestEndTime.toISOString()}`);

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

    console.log(`[DEBUG] Found Busy Nannies:`, JSON.stringify(busyNannies, null, 2));

    const busyNannyIds = busyNannies.map((b) => b.nanny_id);
    console.log(`Busy Nannies (Overlap ${requestStartTime.toISOString()} - ${requestEndTime.toISOString()}):`, busyNannyIds);

    // Combine previous rejects and currently busy nannies
    const excludedNannyIds = [...new Set([...previouslyAssignedIds, ...busyNannyIds])];

    // Format excluded IDs for SQL NOT IN clause
    const excludedIdsSql =
      excludedNannyIds.length > 0
        ? `AND u.id NOT IN (${excludedNannyIds.map((id) => `'${id}'`).join(",")})`
        : "";

    // Hard Filters
    const radiusKm = 15; // Increased to 15km
    const maxRateSql = request.max_hourly_rate
      ? `AND nd.hourly_rate <= ${request.max_hourly_rate}`
      : "";

    const categorySql = (request as any).category
      ? `AND ('${(request as any).category}' = ANY(nd.tags) OR '${(request as any).category}' = ANY(nd.skills))`
      : "";

    const nannies = (await this.prisma.$queryRawUnsafe(`
      SELECT 
        u.id, 
        u.email,
        nd.skills,
        nd.experience_years,
        nd.hourly_rate,
        nd.acceptance_rate,
        (6371 * acos(cos(radians(${request.location_lat})) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(${request.location_lng})) + sin(radians(${request.location_lat})) * sin(radians(p.lat)))) AS distance
      FROM users u
      JOIN profiles p ON u.id = p.user_id
      JOIN nanny_details nd ON u.id = nd.user_id
      WHERE u.role = 'nanny'
      AND u.identity_verification_status = 'verified'
      AND nd.is_available_now = true
      ${excludedIdsSql}
      ${maxRateSql}
      ${categorySql}
      AND (6371 * acos(cos(radians(${request.location_lat})) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(${request.location_lng})) + sin(radians(${request.location_lat})) * sin(radians(p.lat)))) < ${radiusKm}
    `)) as any[];

    // In-Memory Filtering & Scoring
    const requiredSkills = request.required_skills || [];

    // Get parent's favorite nannies
    const favoriteNannyIds = await this.favoritesService.getFavoriteNannyIds(
      request.parent_id,
    );

    // Get historical matching data for AI
    const historicalData = await this.prisma.matching_feedback.findMany({
      where: { was_successful: true },
      take: 50,
      orderBy: { created_at: "desc" },
      include: {
        service_requests: {
          select: { required_skills: true },
        },
        users: {
          include: { nanny_details: true },
        },
      },
    });

    const historicalFormatted = historicalData.map((h) => ({
      request_skills: h.service_requests.required_skills,
      nanny_experience: h.users.nanny_details?.experience_years || 0,
      nanny_skills: h.users.nanny_details?.skills || [],
      was_successful: h.was_successful,
    }));

    // Get AI scores
    const aiScores = await this.aiService.getMatchingRecommendations(
      {
        required_skills: request.required_skills,
        children_ages: request.children_ages,
        special_requirements: request.special_requirements,
        duration_hours: request.duration_hours,
      },
      nannies,
      historicalFormatted,
    );

    const scoredNannies = nannies
      .map((nanny) => {
        // Calculate Score
        let score = 0;

        // 0. Skill Match (Max 40 pts)
        const nannySkills = nanny.skills || [];
        const matchedSkills = requiredSkills.filter(skill => nannySkills.includes(skill));
        const skillScore = requiredSkills.length > 0
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

        // 4. Hourly Rate (Max 10 pts)
        const rate = Number(nanny.hourly_rate) || 0;
        const rateScore = Math.max(0, 10 * (1 - (rate - 10) / 40));
        score += rateScore;

        // 5. Favorite Bonus (+50 pts)
        if (favoriteNannyIds.includes(nanny.id)) {
          score += 50;
        }

        // 6. AI Score (Max 30 pts)
        const aiScore = aiScores.get(nanny.id) || 0;
        score += (aiScore / 100) * 30;

        console.log(`Nanny ${nanny.email} (${nanny.id}) Score Breakdown:
          Distance: ${distanceScore.toFixed(2)} (Dist: ${nanny.distance.toFixed(2)}km)
          Exp: ${experienceScore}
          Acc: ${acceptanceScore}
          Rate: ${rateScore}
          Skills: ${skillScore.toFixed(2)} (${matchedSkills.length}/${requiredSkills.length})
          Favorite: ${favoriteNannyIds.includes(nanny.id) ? 50 : 0}
          AI: ${(aiScore / 100) * 30}
          TOTAL: ${score.toFixed(2)}
        `);

        return { ...nanny, score };
      })
      .sort((a, b) => b.score - a.score); // Sort by Score DESC

    if (scoredNannies.length > 0) {
      // Assign and Auto-Confirm the top-ranked candidate
      const bestMatch = scoredNannies[0];
      console.log(
        `Best match for request ${requestId}: ${bestMatch.id} (Score: ${bestMatch.score.toFixed(2)})`,
      );

      // Perform updates in a transaction for atomicity
      const assignment = await this.prisma.$transaction(async (tx) => {
        // 1. Create assignment (Directly as accepted)
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

        // 2. Update request status to accepted
        await tx.service_requests.update({
          where: { id: requestId },
          data: {
            status: "accepted",
            current_assignment_id: assignment.id,
          },
        });

        // 3. Update associated booking to CONFIRMED
        await tx.bookings.updateMany({
          where: { request_id: requestId, status: { not: "CANCELLED" } },
          data: {
            nanny_id: bestMatch.id,
            status: "CONFIRMED",
          }
        });

        return assignment;
      });

      console.log(`Auto-confirmed request ${requestId} with nanny ${bestMatch.id}`);

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

      return assignment;
    } else {
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
  }

  async findOne(id: string) {
    const request = await this.prisma.service_requests.findUnique({
      where: { id },
      include: {
        users: {
          include: { profiles: true },
        },
        assignments: {
          include: { users: { include: { profiles: true, nanny_details: true } } },
        },
      },
    });

    if (!request) {
      throw new NotFoundException(`Service request with ID ${id} not found`);
    }

    return request;
  }

  async findAllByParent(parentId: string) {
    return this.prisma.service_requests.findMany({
      where: {
        parent_id: parentId,
        // Only return requests that DO NOT have an active booking yet.
        // This prevents duplication on the frontend dashboard between "Requests" and "Bookings".
        bookings: {
          none: {
            status: { not: "CANCELLED" }
          }
        }
      },
      orderBy: { created_at: "desc" },
      include: {
        assignments: {
          where: { status: "pending" },
          include: { users: { include: { profiles: true, nanny_details: true } } },
        },
      },
    });
  }
}

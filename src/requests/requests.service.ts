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
      const { request } = await this.prisma.$transaction(async (tx) => {
        // Create the service request
        const request = await tx.service_requests.create({
          data: {
            parent_id: parentId,
            date: new Date(createRequestDto.date),
            start_time: new Date(`1970-01-01T${createRequestDto.start_time}Z`),
            duration_hours: createRequestDto.duration_hours,
            num_children: createRequestDto.num_children,
            children_ages: createRequestDto.children_ages || [],
            special_requirements: createRequestDto.special_requirements,
            required_skills: createRequestDto.required_skills || [],
            max_hourly_rate: createRequestDto.max_hourly_rate,
            location_lat: parent.profiles.lat,
            location_lng: parent.profiles.lng,
            status: "pending",
          },
        });

        // Create initial booking (Pending Assignment)
        await tx.bookings.create({
          data: {
            job_id: null,
            request_id: request.id,
            parent_id: parentId,
            nanny_id: null,
            status: "requested",
            start_time: new Date(
              request.date.toISOString().split("T")[0] +
              "T" +
              request.start_time.toISOString().split("T")[1]
            ),
            end_time: new Date(
              new Date(
                request.date.toISOString().split("T")[0] +
                "T" +
                request.start_time.toISOString().split("T")[1]
              ).getTime() + Number(request.duration_hours) * 60 * 60 * 1000
            ),
          },
        });

        return { request };
      });

      // 3. Trigger auto-matching (Outside transaction)
      await this.triggerMatching(request.id);

      return request;
    } catch (error) {
      console.error("Error creating service request flow:", error);
      throw error;
    }
  }

  async cancelRequest(id: string) {
    const request = await this.prisma.service_requests.findUnique({
      where: { id },
      include: {
        assignments: { where: { status: { in: ["pending", "accepted"] } } },
        bookings: { where: { status: { not: "CANCELLED" } } }
      },
    });

    if (!request) throw new NotFoundException("Request not found");

    // Status validation: Can cancel if pending, assigned, or accepted 
    // (Essentially as long as it's not already cancelled or completed)
    if (["CANCELLED", "COMPLETED"].includes(request.status)) {
      throw new BadRequestException(
        `Cannot cancel a request that is already ${request.status.toLowerCase()}`,
      );
    }

    // 1. Cancel any pending or accepted assignments
    if (request.assignments.length > 0) {
      await this.prisma.assignments.updateMany({
        where: { request_id: id, status: { in: ["pending", "accepted"] } },
        data: {
          status: "cancelled",
          responded_at: new Date(),
        },
      });
    }

    // 2. Cancel associated booking if exists
    if (request.bookings.length > 0) {
      await this.prisma.bookings.updateMany({
        where: { request_id: id, status: { not: "CANCELLED" } },
        data: {
          status: "CANCELLED",
          cancellation_reason: "User cancelled the service request",
        },
      });
    }

    // 3. Update request status
    return this.prisma.service_requests.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
  }

  async triggerMatching(requestId: string) {
    const request = await this.prisma.service_requests.findUnique({
      where: { id: requestId },
      include: { assignments: true }, // Include previous assignments
    });

    if (!request) throw new NotFoundException("Request not found");

    // Get IDs of nannies already assigned (rejected or timeout)
    const excludedNannyIds = request.assignments.map((a) => a.nanny_id);

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
      AND u.is_verified = true
      AND nd.is_available_now = true
      ${excludedIdsSql}
      ${maxRateSql}
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
      .filter((nanny) => {
        // Filter by Skills (Strict Match: Nanny must have ALL required skills)
        if (requiredSkills.length === 0) return true;
        const nannySkills = nanny.skills || [];
        return requiredSkills.every((skill) => nannySkills.includes(skill));
      })
      .map((nanny) => {
        // Calculate Score
        let score = 0;

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

        return { ...nanny, score };
      })
      .sort((a, b) => b.score - a.score); // Sort by Score DESC

    if (scoredNannies.length > 0) {
      // Assign to the top-ranked candidate
      const bestMatch = scoredNannies[0];
      console.log(
        `Best match for request ${requestId}: ${bestMatch.id} (Score: ${bestMatch.score.toFixed(2)})`,
      );

      // Create assignment
      const assignment = await this.prisma.assignments.create({
        data: {
          request_id: requestId,
          nanny_id: bestMatch.id,
          response_deadline: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes from now
          status: "pending",
          rank_position: request.assignments.length + 1,
        },
      });

      // Update request status
      await this.prisma.service_requests.update({
        where: { id: requestId },
        data: {
          status: "assigned",
          current_assignment_id: assignment.id,
        },
      });

      console.log(`Assigned request ${requestId} to nanny ${bestMatch.id}`);

      // Notify Nanny
      await this.notificationsService.createNotification(
        bestMatch.id,
        "New Service Request",
        `You have a new service request nearby! Tap to view details.`,
        "info",
      );

      // Notify Parent about the match
      await this.notificationsService.createNotification(
        request.parent_id,
        "Nanny Matched!",
        `We found a matching nanny! Waiting for their confirmation.`,
        "info",
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

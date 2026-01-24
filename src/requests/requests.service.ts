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
  ) {}

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
      // 2. Create the service request
      const request = await this.prisma.service_requests.create({
        data: {
          parent_id: parentId,
          date: new Date(createRequestDto.date),
          start_time: new Date(`1970-01-01T${createRequestDto.start_time}Z`), // Store as time on dummy date
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

      // 3. Create initial booking (Pending Assignment)
      await this.prisma.bookings.create({
        data: {
          job_id: null,
          request_id: request.id,
          parent_id: parentId,
          nanny_id: null, // No nanny assigned yet
          status: "requested", // Initial status
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

      // 4. Trigger auto-matching
      await this.triggerMatching(request.id);

      return request;
    } catch (error) {
      console.error("Error creating service request:", error);
      throw error;
    }
  }

  async cancelRequest(id: string) {
    const request = await this.prisma.service_requests.findUnique({
      where: { id },
      include: { assignments: { where: { status: "pending" } } },
    });

    if (!request) throw new NotFoundException("Request not found");
    if (request.status !== "pending") {
      throw new BadRequestException(
        "Cannot cancel a request that is not pending",
      );
    }

    // Cancel any pending assignment
    if (request.assignments.length > 0) {
      await this.prisma.assignments.update({
        where: { id: request.assignments[0].id },
        data: {
          status: "cancelled",
          responded_at: new Date(),
        },
      });
    }

    // Update request status
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
      where: { parent_id: parentId },
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

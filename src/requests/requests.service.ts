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


export const CATEGORY_SKILL_MAP = {
  'CC': ['Infant Care', 'Toddlers', 'Child Care', 'Babysitting', 'Nanny'],
  'ST': ['Shadow Teacher', 'Special Education', 'Autism Support', 'ADHD Support'],
  'SN': ['Special Needs', 'Disability Care', 'Therapy Support', 'Medical Assistance'],
  'EC': ['Elderly Care', 'Geriatric Support', 'Companion Care'],
};

@Injectable()
export class RequestsService {
  constructor(
    private prisma: PrismaService,
    private usersService: UsersService,
    private notificationsService: NotificationsService,
    private favoritesService: FavoritesService,
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

        // Fetch service details for pricing
        const serviceSettings = await this.prisma.services.findUnique({
          where: { name: createRequestDto.category },
        });

        if (!serviceSettings) {
          throw new BadRequestException(`Service category '${createRequestDto.category}' not found.`);
        }

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
            max_hourly_rate: createRequestDto.max_hourly_rate || serviceSettings.hourly_rate, // Use Service Rate
            location_lat: parent.profiles.lat,
            location_lng: parent.profiles.lng,
            category: createRequestDto.category,
            status: "pending",
          } as any,
        });

        // Create initial booking (Pending Assignment)
        const bookingStartTime = new Date(`${createRequestDto.date}T${startTimeStr}+05:30`);
        const bookingEndTime = new Date(bookingStartTime.getTime() + Number(request.duration_hours) * 60 * 60 * 1000);

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
      if (error.code === 'P2002') {
        throw new BadRequestException("An active booking already exists for this request or a duplicate request was detected.");
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
        bookings: true
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
            bookings: true
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

    return result;
  }

  async triggerMatching(requestId: string) {
    const request = await this.prisma.service_requests.findUnique({
      where: { id: requestId },
      include: { assignments: true }, // Include previous assignments
    });

    if (!request) throw new NotFoundException("Request not found");

    // Skip auto-matching for Shadow Teacher and Special Needs categories
    // These will be manually assigned by admins
    if (request.category === 'ST' || request.category === 'SN') {
      console.log(`[Matching] Skipping auto-matching for ${request.category} request ${requestId}. Await manual assignment.`);
      return null;
    }

    // Get IDs of nannies already assigned (rejected or timeout)
    const previouslyAssignedIds = request.assignments.map((a) => a.nanny_id);

    // Calculate Request End Time directly from the date object
    let requestStartTime: Date;
    try {
      if (!request.date || (request as any).start_time === undefined) {
        throw new Error("Missing date or start_time");
      }

      const dateObj = new Date(request.date);
      const startTimeObj = new Date(request.start_time);

      if (isNaN(dateObj.getTime()) || isNaN(startTimeObj.getTime())) {
        throw new Error("Invalid date input components");
      }

      const datePart = dateObj.toISOString().split('T')[0];
      const timePart = startTimeObj.toISOString().split('T')[1];
      requestStartTime = new Date(`${datePart}T${timePart}`);

      if (isNaN(requestStartTime.getTime())) {
        throw new Error("Resulting requestStartTime is NaN");
      }
    } catch (e) {
      console.error("Date parsing failed in triggerMatching, falling back to direct date field", e);
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

    const radiusKm = 15; // Increased to 15km
    const category = (request as any).category;
    const mappedSkills = CATEGORY_SKILL_MAP[category] || [];
    const skillSearchTerms = [category, ...mappedSkills].filter(Boolean);

    const nannies = (await this.prisma.$queryRaw(Prisma.sql`
      SELECT 
        u.id, 
        u.email,
        nd.skills,
        nd.experience_years,
        nd.acceptance_rate,
        (6371 * acos(cos(radians(${request.location_lat})) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(${request.location_lng})) + sin(radians(${request.location_lat})) * sin(radians(p.lat)))) AS distance
      FROM users u
      JOIN profiles p ON u.id = p.user_id
      JOIN nanny_details nd ON u.id = nd.user_id
      WHERE u.role = 'nanny'
      AND u.identity_verification_status = 'verified'
      AND nd.is_available_now = true
      ${excludedNannyIds.length > 0 ? Prisma.sql`AND u.id NOT IN (${Prisma.join(excludedNannyIds)})` : Prisma.empty}
      ${skillSearchTerms.length > 0 ? Prisma.sql`AND (
        EXISTS (SELECT 1 FROM unnest(nd.tags) t WHERE t IN (${Prisma.join(skillSearchTerms)}))
        OR 
        EXISTS (SELECT 1 FROM unnest(nd.skills) s WHERE s IN (${Prisma.join(skillSearchTerms)}))
        OR
        EXISTS (SELECT 1 FROM unnest(nd.categories) c WHERE c IN (${Prisma.join(skillSearchTerms)}))
      )` : Prisma.empty}
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
      console.log(`Found ${scoredNannies.length} potential matches for request ${requestId}. Attempting assignment...`);

      for (const bestMatch of scoredNannies) {
        console.log(`Attempting to assign request ${requestId} to nanny ${bestMatch.id} (Score: ${bestMatch.score.toFixed(2)})`);

        try {
          const assignment = await this.prisma.$transaction(async (tx) => {
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
              console.log(`Race condition detected: Nanny ${bestMatch.id} is already booked for an overlapping slot.`);
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
            await tx.bookings.updateMany({
              where: { request_id: requestId, status: { not: "CANCELLED" } },
              data: {
                nanny_id: bestMatch.id,
                status: "CONFIRMED",
              }
            });

            return assignment;
          }, {
            isolationLevel: 'Serializable', // Use highest isolation level to ensure no phantom reads
          });

          if (assignment) {
            console.log(`Successfully assigned request ${requestId} to nanny ${bestMatch.id}`);

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
          }
        } catch (error) {
          if (error.message === "NANNY_BUSY") {
            continue; // Try the next best nanny
          }
          if (error.code === 'P2002') {
            console.log(`Matching Race Condition: Assignment already exists for request ${requestId}.`);
            return null;
          }
          console.error(`Error during assignment for nanny ${bestMatch.id}:`, error);
          // For other errors, we might want to continue or stop. 
          // Let's continue for now to try other nannies if one assignment fails for transient reasons.
          continue;
        }
      }

      console.log(`Failed to assign any of the ${scoredNannies.length} nannies to request ${requestId}`);
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
          include: { users: { include: { profiles: true, nanny_details: true } } },
        },
      },
    });

    // FALLBACK: If not found by Request ID, check if the ID provided is a Booking ID
    if (!request) {
      console.log(`findOne: Request ID ${id} not found. checking if it is a Booking ID...`);
      const booking = await this.prisma.bookings.findUnique({
        where: { id },
        select: { request_id: true }
      });

      if (booking && booking.request_id) {
        console.log(`findOne: Found associated Request ID ${booking.request_id} for Booking ${id}`);
        request = await this.prisma.service_requests.findUnique({
          where: { id: booking.request_id },
          include: {
            users: {
              include: { profiles: true },
            },
            assignments: {
              include: { users: { include: { profiles: true, nanny_details: true } } },
            },
          },
        });
      }
    }

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
          OR: [
            { id: { equals: undefined } }, // This effectively means no booking
            { status: "CANCELLED" }
          ]
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

import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";
import { users, profiles } from "@prisma/client";
import { UpdateUserDto } from "./dto/update-user.dto";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private prisma: PrismaService) {}

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

  async findUserForAuth(email: string): Promise<
    | (Pick<
        users,
        | "id"
        | "email"
        | "password_hash"
        | "role"
        | "is_verified"
        | "oauth_provider"
        | "is_active"
        | "ban_reason"
      > & {
        profiles: {
          first_name: string | null;
          last_name: string | null;
          profile_image_url: string | null;
        } | null;
      })
    | null
  > {
    return this.prisma.users.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password_hash: true,
        role: true,
        is_verified: true,
        is_active: true,
        ban_reason: true,
        oauth_provider: true,
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

  async findByOAuth(
    provider: string,
    providerId: string,
  ): Promise<
    | (Pick<
        users,
        | "id"
        | "email"
        | "password_hash"
        | "role"
        | "is_verified"
        | "oauth_provider"
        | "is_active"
        | "ban_reason"
      > & {
        profiles: {
          first_name: string | null;
          last_name: string | null;
          profile_image_url: string | null;
        } | null;
      })
    | null
  > {
    return this.prisma.users.findUnique({
      where: {
        oauth_provider_oauth_provider_id: {
          oauth_provider: provider,
          oauth_provider_id: providerId,
        },
      },
      select: {
        id: true,
        email: true,
        role: true,
        password_hash: true,
        is_verified: true,
        is_active: true,
        ban_reason: true,
        oauth_provider: true,
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
      where: { role: "nanny" },
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

  async update(
    id: string,
    updateUserDto: UpdateUserDto | Prisma.usersUpdateInput,
  ) {
    // Handle both UpdateUserDto and Prisma.usersUpdateInput
    // Check if any UpdateUserDto fields are present
    const isUpdateUserDto =
      "firstName" in updateUserDto ||
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
      "availabilitySchedule" in updateUserDto;

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
        hourlyRate,
        bio,
        availabilitySchedule,
      } = dto;

      // Auto-populate address via reverse geocoding if lat/lng provided but no address
      let finalAddress = address;
      if (lat && lng && !address) {
        try {
          const { LocationService } = await import(
            "../location/location.service"
          );
          const { ConfigService } = await import("@nestjs/config");
          const locationService = new LocationService(
            new ConfigService(),
            this.prisma,
          );
          const geocodedAddress = await locationService.reverseGeocode(
            lat,
            lng,
          );
          if (geocodedAddress) {
            finalAddress = geocodedAddress;
            this.logger.log(`Auto-populated address: ${geocodedAddress}`);
          }
        } catch (error) {
          this.logger.warn(`Failed to reverse geocode: ${error.message}`);
          // Continue without address if reverse geocoding fails
        }
      }

      // Update basic profile info
      if (
        firstName ||
        lastName ||
        phone ||
        finalAddress ||
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
            address: finalAddress,
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
            address: finalAddress,
            lat,
            lng,
            profile_image_url: profileImageUrl,
          },
        });
      }

      // Update nanny details if provided
      if (
        skills ||
        experienceYears ||
        hourlyRate ||
        bio ||
        availabilitySchedule
      ) {
        await this.prisma.nanny_details.upsert({
          where: { user_id: id },
          update: {
            skills: skills,
            experience_years: experienceYears,
            hourly_rate: hourlyRate,
            bio,
            availability_schedule: availabilitySchedule,
            updated_at: new Date(),
          },
          create: {
            user_id: id,
            skills: skills || [],
            experience_years: experienceYears,
            hourly_rate: hourlyRate,
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
}

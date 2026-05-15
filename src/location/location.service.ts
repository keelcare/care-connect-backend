import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client } from "@googlemaps/google-maps-services-js";
import { PrismaService } from "../prisma/prisma.service";
import { Decimal } from "@prisma/client/runtime/library";

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface NearbyNanny {
  id: string;
  email: string;
  profile: {
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    address: string | null;
    lat: Decimal | null;
    lng: Decimal | null;
  } | null;
  nanny_details: {
    skills: string[];
    experience_years: number | null;
    hourly_rate: Decimal | null;
    bio: string | null;
  } | null;
  distance: number; // in kilometers
}

export interface NearbyJob {
  id: string;
  title: string;
  description: string | null;
  date: Date;
  time: Date;
  location_lat: Decimal | null;
  location_lng: Decimal | null;
  status: string | null;
  parent: {
    email: string;
    profiles: {
      first_name: string | null;
      last_name: string | null;
    } | null;
  } | null;
  distance: number; // in kilometers
}

@Injectable()
export class LocationService {
  private readonly logger = new Logger(LocationService.name);
  private readonly googleMapsClient: Client;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.googleMapsClient = new Client({});
  }

  /**
   * Convert address to coordinates using Google Geocoding API
   */
  async geocodeAddress(address: string): Promise<Coordinates | null> {
    try {
      const apiKey = this.configService.get<string>("GOOGLE_MAPS_API_KEY");

      if (!apiKey) {
        this.logger.warn("Google Maps API key not configured");
        return null;
      }

      const response = await this.googleMapsClient.geocode({
        params: {
          address,
          key: apiKey,
        },
      });

      if (response.data.results.length === 0) {
        this.logger.warn(`No geocoding results found for address: ${address}`);
        return null;
      }

      const location = response.data.results[0].geometry.location;
      return {
        lat: location.lat,
        lng: location.lng,
      };
    } catch (error) {
      this.logger.error(`Geocoding error: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Convert coordinates to human-readable address using Google Reverse Geocoding API
   */
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    try {
      const apiKey = this.configService.get<string>("GOOGLE_MAPS_API_KEY");

      if (!apiKey) {
        this.logger.warn("Google Maps API key not configured");
        return null;
      }

      const response = await this.googleMapsClient.reverseGeocode({
        params: {
          latlng: { lat, lng },
          key: apiKey,
        },
      });

      if (response.data.results.length === 0) {
        this.logger.warn(
          `No reverse geocoding results found for: ${lat}, ${lng}`,
        );
        return null;
      }

      // Return the formatted address from the first result
      return response.data.results[0].formatted_address;
    } catch (error) {
      this.logger.error(
        `Reverse geocoding error: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   * @returns distance in kilometers
   */
  calculateDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1);
    const dLng = this.toRadians(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return Math.round(distance * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Convert degrees to radians
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Find nearby nannies within a specified radius
   */
  /**
   * Find nearby nannies within a specified radius
   */
  async findNearbyNannies(
    lat: number,
    lng: number,
    radiusKm: number = 10,
  ): Promise<NearbyNanny[]> {
    // 1. Explicit Conversion
    const latNum = parseFloat(lat.toString());
    const lngNum = parseFloat(lng.toString());
    const radiusNum = parseFloat(radiusKm.toString());

    // 2. Validation
    if (isNaN(latNum) || isNaN(lngNum)) {
      throw new BadRequestException("Invalid coordinates provided");
    }

    try {
      // Use raw SQL with parameterized query (Prisma handles safety)
      // We use tagged template literals for parameterized variables
      const nannies = await this.prisma.$queryRaw<any[]>`
        SELECT 
          u.id, 
          u.email, 
          u.role,
          p.first_name,
          p.last_name,
          p.phone,
          p.address,
          p.lat,
          p.lng,
          p.profile_image_url,
          nd.skills,
          nd.experience_years,
          nd.hourly_rate,
          nd.bio,
          (6371 * acos(cos(radians(${latNum})) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(${lngNum})) + sin(radians(${latNum})) * sin(radians(p.lat)))) AS distance
        FROM users u
        JOIN profiles p ON u.id = p.user_id
        LEFT JOIN nanny_details nd ON u.id = nd.user_id
        WHERE u.role = 'nanny'
        AND u.identity_verification_status = 'verified'
        AND p.lat IS NOT NULL
        AND p.lng IS NOT NULL
        AND (6371 * acos(cos(radians(${latNum})) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(${lngNum})) + sin(radians(${latNum})) * sin(radians(p.lat)))) <= ${radiusNum}
        ORDER BY distance ASC
      `;

      // Map raw results to NearbyNanny interface
      return nannies.map((nanny) => ({
        id: nanny.id,
        email: nanny.email,
        profile: {
          first_name: nanny.first_name,
          last_name: nanny.last_name,
          phone: nanny.phone,
          address: nanny.address,
          lat: new Decimal(nanny.lat),
          lng: new Decimal(nanny.lng),
          profile_image_url: nanny.profile_image_url,
        },
        nanny_details: nanny.skills
          ? {
              skills: nanny.skills,
              experience_years: nanny.experience_years,
              hourly_rate: nanny.hourly_rate
                ? new Decimal(nanny.hourly_rate)
                : null,
              bio: nanny.bio,
            }
          : null,
        distance: Math.round(nanny.distance * 100) / 100,
      }));
    } catch (error) {
      this.logger.error(
        `Error finding nearby nannies: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Find nearby jobs within a specified radius
   */
  async findNearbyJobs(
    lat: number,
    lng: number,
    radiusKm: number = 10,
  ): Promise<NearbyJob[]> {
    const latNum = parseFloat(lat.toString());
    const lngNum = parseFloat(lng.toString());
    const radiusNum = parseFloat(radiusKm.toString());

    if (isNaN(latNum) || isNaN(lngNum)) {
      throw new BadRequestException("Invalid coordinates provided");
    }

    try {
      // Use raw SQL for spatial query to avoid fetching all jobs into memory
      const jobs = await this.prisma.$queryRaw<any[]>`
        SELECT 
          j.id, 
          j.title, 
          j.description, 
          j.date, 
          j.time, 
          j.location_lat, 
          j.location_lng, 
          j.status,
          u.id as user_id,
          u.email as user_email,
          p.first_name,
          p.last_name,
          (6371 * acos(cos(radians(${latNum})) * cos(radians(j.location_lat)) * cos(radians(j.location_lng) - radians(${lngNum})) + sin(radians(${latNum})) * sin(radians(j.location_lat)))) AS distance
        FROM jobs j
        JOIN users u ON j.parent_id = u.id
        LEFT JOIN profiles p ON u.id = p.user_id
        WHERE j.status = 'open'
        AND j.location_lat IS NOT NULL
        AND j.location_lng IS NOT NULL
        AND (6371 * acos(cos(radians(${latNum})) * cos(radians(j.location_lat)) * cos(radians(j.location_lng) - radians(${lngNum})) + sin(radians(${latNum})) * sin(radians(j.location_lat)))) <= ${radiusNum}
        ORDER BY distance ASC
      `;

      return jobs.map((job) => ({
        id: job.id,
        title: job.title,
        description: job.description,
        date: job.date,
        time: job.time,
        location_lat: new Decimal(job.location_lat),
        location_lng: new Decimal(job.location_lng),
        status: job.status,
        parent: {
          id: job.user_id,
          email: job.user_email,
          profiles: {
            first_name: job.first_name,
            last_name: job.last_name,
          },
        },
        distance: Math.round(job.distance * 100) / 100,
      }));
    } catch (error) {
      this.logger.error(
        `Error finding nearby jobs: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}

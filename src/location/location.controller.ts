import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { LocationService } from "./location.service";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { GeocodeAddressDto, NearbySearchDto } from "./dto";

/**
 * SECURITY: this controller previously had no class-level guard — only
 * `booking/:id/live` was protected. That left `nannies/nearby` and `jobs/nearby`
 * open to the internet, each returning full contact details and exact home
 * coordinates, so a caller could sweep lat/lng and harvest the entire caregiver
 * and parent base. Both the guard and the response shape below are load-bearing:
 * discovery must never carry contact details or a home address.
 */
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
@Controller("location")
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  /**
   * GET /location/booking/:id/live
   * Live-tracking snapshot for a booking (parent or assigned nanny only).
   */
  @Get("booking/:id/live")
  async getLiveLocation(@Param("id") id: string, @Request() req) {
    return this.locationService.getLiveLocation(id, req.user.id);
  }

  /**
   * POST /location/geocode
   * Convert an address to coordinates
   */
  @Post("geocode")
  async geocodeAddress(@Body() geocodeDto: GeocodeAddressDto) {
    const coordinates = await this.locationService.geocodeAddress(
      geocodeDto.address,
    );

    if (!coordinates) {
      return {
        success: false,
        message: "Could not geocode the provided address",
      };
    }

    return {
      success: true,
      data: coordinates,
    };
  }

  /**
   * GET /location/nannies/nearby?lat=&lng=&radius=
   * Find nearby nannies within a specified radius
   */
  @Get("nannies/nearby")
  async findNearbyNannies(@Query() query: NearbySearchDto) {
    const { lat, lng, radius = 10 } = query;
    const nannies = await this.locationService.findNearbyNannies(
      lat,
      lng,
      radius,
    );

    // Discovery view only. Contact details and the caregiver's home address are
    // deliberately not returned: a parent has no need for them before a booking
    // exists, and this endpoint is enumerable by anyone with an account. The
    // surname is reduced to an initial and coordinates are not echoed at all —
    // `distance` is what the UI actually renders.
    const data = nannies.map((n) => ({
      id: n.id,
      profile: {
        first_name: n.profile?.first_name ?? null,
        last_initial: n.profile?.last_name?.trim()?.charAt(0)?.toUpperCase() ?? null,
        profile_image_url: n.profile?.profile_image_url ?? null,
      },
      nanny_details: n.nanny_details
        ? {
            skills: n.nanny_details.skills,
            experience_years: n.nanny_details.experience_years,
            hourly_rate: n.nanny_details.hourly_rate,
            bio: n.nanny_details.bio,
          }
        : null,
      distance: n.distance,
    }));

    return {
      success: true,
      count: data.length,
      radius: `${radius}km`,
      data,
    };
  }

  /**
   * GET /location/jobs/nearby?lat=&lng=&radius=
   * Find nearby jobs within a specified radius
   */
  @Get("jobs/nearby")
  async findNearbyJobs(@Query() query: NearbySearchDto) {
    const { lat, lng, radius = 10 } = query;
    const jobs = await this.locationService.findNearbyJobs(lat, lng, radius);

    // Same reasoning as nannies/nearby: the posting parent's email is removed,
    // the surname reduced to an initial, and the job's coordinates coarsened to
    // ~1km (2dp) so browsing open jobs cannot map a family's home address.
    const coarse = (v: unknown) =>
      v == null ? null : Math.round(Number(v) * 100) / 100;

    const data = jobs.map((j) => ({
      id: j.id,
      title: j.title,
      description: j.description,
      date: j.date,
      time: j.time,
      status: j.status,
      location_lat: coarse(j.location_lat),
      location_lng: coarse(j.location_lng),
      parent: {
        id: j.parent?.id ?? null,
        first_name: j.parent?.profiles?.first_name ?? null,
        last_initial:
          j.parent?.profiles?.last_name?.trim()?.charAt(0)?.toUpperCase() ?? null,
      },
      distance: j.distance,
    }));

    return {
      success: true,
      count: data.length,
      radius: `${radius}km`,
      data,
    };
  }

  /**
   * Post /location/reverse-geocode
   * Convert coordinates to address
   */
  @Post("reverse-geocode")
  async reverseGeocode(@Body() body: { lat: number; lng: number }) {
    const address = await this.locationService.reverseGeocode(
      body.lat,
      body.lng,
    );

    if (!address) {
      return {
        success: false,
        message: "Could not reverse geocode the provided coordinates",
      };
    }

    return {
      success: true,
      data: { address },
    };
  }
}

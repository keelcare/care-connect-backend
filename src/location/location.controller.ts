import { Controller, Get, Post, Body, Query } from "@nestjs/common";
import { LocationService } from "./location.service";
import { GeocodeAddressDto, NearbySearchDto } from "./dto";

@Controller("location")
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

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

    return {
      success: true,
      count: nannies.length,
      radius: `${radius}km`,
      data: nannies,
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

    return {
      success: true,
      count: jobs.length,
      radius: `${radius}km`,
      data: jobs,
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

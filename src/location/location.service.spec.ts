import { Test, TestingModule } from "@nestjs/testing";
import { LocationService } from "./location.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";

describe("LocationService", () => {
  let service: LocationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationService,
        {
          provide: PrismaService,
          useValue: {
            users: {
              findMany: jest.fn(),
            },
            jobs: {
              findMany: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<LocationService>(LocationService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});

describe("LocationService.getLiveLocation", () => {
  let service: LocationService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      bookings: { findUnique: jest.fn() },
      location_updates: { findMany: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();
    service = module.get(LocationService);
  });

  it("rejects users who are not the booking's parent or nanny", async () => {
    prisma.bookings.findUnique.mockResolvedValue({
      parent_id: "p1",
      nanny_id: "n1",
    });
    await expect(service.getLiveLocation("b1", "stranger")).rejects.toThrow(
      "Not authorized",
    );
  });

  it("computes metre-precise distance so REST agrees with the socket at the fence", async () => {
    // ~104m north of the care location: 2dp-km rounding would call this
    // 0.10km → 100m → "inside" a 100m fence. Metre-precise haversine must not.
    prisma.bookings.findUnique.mockResolvedValue({
      parent_id: "p1",
      nanny_id: "n1",
      status: "IN_PROGRESS",
      care_location_lat: 19.07,
      care_location_lng: 72.87,
      geofence_radius: 100,
    });
    prisma.location_updates.findMany.mockResolvedValue([
      { lat: 19.070936, lng: 72.87, timestamp: new Date() },
    ]);
    const snap = await service.getLiveLocation("b1", "p1");
    expect(snap.distance).toBeGreaterThan(100);
    expect(snap.inside).toBe(false);
  });
});

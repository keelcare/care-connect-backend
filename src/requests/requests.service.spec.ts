import { Test, TestingModule } from "@nestjs/testing";
import { RequestsService } from "./requests.service";
import { PrismaService } from "../prisma/prisma.service";
import { UsersService } from "../users/users.service";
import { NotificationsService } from "../notifications/notifications.service";
import { FavoritesService } from "../favorites/favorites.service";
import { AiService } from "../ai/ai.service";
import { NotFoundException, BadRequestException } from "@nestjs/common";

describe("RequestsService", () => {
  let service: RequestsService;
  let prisma: PrismaService;

  const mockPrisma = {
    service_requests: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    assignments: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    bookings: {
      updateMany: jest.fn(),
    },
    matching_feedback: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRawUnsafe: jest.fn(),
    $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
  };

  const mockUsersService = {
    findOne: jest.fn(),
  };

  const mockNotificationsService = {
    createNotification: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: UsersService, useValue: mockUsersService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: FavoritesService, useValue: { getFavoriteNannyIds: jest.fn().mockResolvedValue([]) } },
        { provide: AiService, useValue: { getMatchingRecommendations: jest.fn().mockResolvedValue(new Map()) } },
      ],
    }).compile();

    service = module.get<RequestsService>(RequestsService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("cancelRequest", () => {
    it("should cancel a pending request and its assignment", async () => {
      const requestId = "req1";
      mockPrisma.service_requests.findUnique.mockResolvedValue({
        id: requestId,
        parent_id: "parent1",
        status: "pending",
        assignments: [{ id: "assign1", status: "pending" }],
        bookings: [],
      });

      await service.cancelRequest(requestId);

      expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
        "parent1", // Correctly should be the parent_id from mockResolvedValue
        "Request Cancelled",
        expect.any(String),
        "warning",
      );
    });

    it("should throw error if request already completed", async () => {
      mockPrisma.service_requests.findUnique.mockResolvedValue({
        id: "req2",
        status: "COMPLETED",
        assignments: [],
        bookings: [],
      });

      await expect(service.cancelRequest("req2")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("triggerMatching", () => {
    it("should match nanny with required skills", async () => {
      const requestId = "req3";
      const requiredSkills = ["CPR", "First Aid"];

      mockPrisma.service_requests.findUnique.mockResolvedValue({
        id: requestId,
        parent_id: "parent1",
        location_lat: 40.7128,
        location_lng: -74.006,
        required_skills: requiredSkills,
        assignments: [],
      });

      // Mock raw query return
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        {
          id: "nanny1",
          skills: ["CPR", "First Aid"],
          distance: 5,
          acceptance_rate: 90,
          hourly_rate: 20,
        },
        {
          id: "nanny2",
          skills: ["CPR"],
          distance: 2,
          acceptance_rate: 95,
          hourly_rate: 18,
        }, // Missing First Aid
      ]);

      mockPrisma.assignments.create.mockResolvedValue({ id: "assign2" });

      await service.triggerMatching(requestId);

      // Verify query includes updated verification check
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining("AND u.identity_verification_status = 'verified'")
      );

      // Should pick nanny1 because nanny2 is missing skills
      expect(mockPrisma.assignments.create).toHaveBeenCalled();

      // Should notify Nanny
      expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
        "nanny1",
        "New Assignment Confirmed",
        expect.any(String),
        "info",
      );

      // Should notify Parent
      expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
        "parent1",
        "Nanny Assigned!",
        expect.any(String),
        "success",
      );
    });
  });
});

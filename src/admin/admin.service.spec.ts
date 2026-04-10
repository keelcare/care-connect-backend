import { Test, TestingModule } from "@nestjs/testing";
import { AdminService } from "./admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { FavoritesService } from "../favorites/favorites.service";
import { ChatService } from "../chat/chat.service";
import { RequestsService } from "../requests/requests.service";
import { SseService } from "../sse/sse.service";

describe("AdminService", () => {
  let service: AdminService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: PrismaService,
          useValue: {
            users: {
              findMany: jest.fn(),
              update: jest.fn(),
              count: jest.fn(),
            },
            bookings: {
              findMany: jest.fn(),
              count: jest.fn(),
            },
            $transaction: jest.fn().mockImplementation((cb) =>
              cb({
                assignments: { create: jest.fn() },
                service_requests: { update: jest.fn() },
                bookings: { updateMany: jest.fn(), findFirst: jest.fn() },
              }),
            ),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            createNotification: jest.fn(),
          },
        },
        {
          provide: FavoritesService,
          useValue: {
            getFavoriteNannyIds: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: ChatService,
          useValue: {
            createChat: jest.fn(),
          },
        },
        {
          provide: RequestsService,
          useValue: {
            triggerMatching: jest.fn(),
          },
        },
        {
          provide: SseService,
          useValue: {
            emitToUser: jest.fn(),
            emitToUsers: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("banUser", () => {
    it("should ban a user", async () => {
      const userId = "user-123";
      const reason = "Violation of terms";
      const mockUpdate = jest.fn().mockResolvedValue({
        id: userId,
        is_active: false,
        ban_reason: reason,
      });
      (service as any).prisma.users.update = mockUpdate;

      const result = await service.banUser(userId, reason);

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: userId },
        data: { is_active: false, ban_reason: reason },
      });
      expect(result).toEqual({
        id: userId,
        is_active: false,
        ban_reason: reason,
      });
    });
  });

  describe("unbanUser", () => {
    it("should unban a user", async () => {
      const userId = "user-123";
      const mockUpdate = jest
        .fn()
        .mockResolvedValue({ id: userId, is_active: true, ban_reason: null });
      (service as any).prisma.users.update = mockUpdate;

      const result = await service.unbanUser(userId);

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: userId },
        data: { is_active: true, ban_reason: null },
      });
      expect(result).toEqual({ id: userId, is_active: true, ban_reason: null });
    });
  });
});

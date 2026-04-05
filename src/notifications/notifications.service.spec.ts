import { Test, TestingModule } from "@nestjs/testing";
import { NotificationsService } from "./notifications.service";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsGateway } from "./notifications.gateway";
import { FcmService } from "./fcm.service";
import { SseService } from "../sse/sse.service";

describe("NotificationsService", () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            notifications: {
              create: jest.fn(),
              findMany: jest.fn(),
            },
          },
        },
        {
          provide: NotificationsGateway,
          useValue: {
            sendNotification: jest.fn(),
          },
        },
        {
          provide: FcmService,
          useValue: {
            sendPushNotification: jest.fn(),
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

    service = module.get<NotificationsService>(NotificationsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});

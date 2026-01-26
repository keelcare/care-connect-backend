import { Test, TestingModule } from "@nestjs/testing";
import { AssignmentsService } from "./assignments.service";
import { PrismaService } from "../prisma/prisma.service";
import { RequestsService } from "../requests/requests.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ChatService } from "../chat/chat.service";

describe("AssignmentsService", () => {
  let service: AssignmentsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentsService,
        {
          provide: PrismaService,
          useValue: {
            assignments: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
            },
            service_requests: {
              update: jest.fn(),
            },
            bookings: {
              create: jest.fn(),
            },
            nanny_details: {
              update: jest.fn(),
            },
          },
        },
        {
          provide: RequestsService,
          useValue: {
            triggerMatching: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendPushNotification: jest.fn(),
          },
        },
        {
          provide: ChatService,
          useValue: {
            createChat: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AssignmentsService>(AssignmentsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});

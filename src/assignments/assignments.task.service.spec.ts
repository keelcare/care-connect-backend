import { Test, TestingModule } from "@nestjs/testing";
import { AssignmentsTaskService } from "./assignments.task.service";
import { PrismaService } from "../prisma/prisma.service";
import { RequestsService } from "../requests/requests.service";

describe("AssignmentsTaskService", () => {
  let service: AssignmentsTaskService;
  let prisma: any;
  let requestsService: any;

  beforeEach(async () => {
    prisma = {
      assignments: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    requestsService = { triggerMatching: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentsTaskService,
        { provide: PrismaService, useValue: prisma },
        { provide: RequestsService, useValue: requestsService },
      ],
    }).compile();

    service = module.get(AssignmentsTaskService);
  });

  it("claims expired assignments atomically (status-guarded) and re-matches", async () => {
    prisma.assignments.findMany.mockResolvedValue([
      { id: "a1", request_id: "r1", status: "pending" },
    ]);
    prisma.assignments.updateMany.mockResolvedValue({ count: 1 });

    await service.handleAssignmentTimeouts();

    // The claim must carry the status guard — an unguarded update would stamp
    // "timeout" over a response written between the findMany and the update.
    expect(prisma.assignments.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "a1", status: "pending" }),
        data: expect.objectContaining({ status: "timeout" }),
      }),
    );
    expect(requestsService.triggerMatching).toHaveBeenCalledWith("r1");
  });

  it("does NOT re-match when the assignment was responded to before the claim", async () => {
    prisma.assignments.findMany.mockResolvedValue([
      { id: "a1", request_id: "r1", status: "pending" },
    ]);
    // Lost the race: a nanny accepted in the gap.
    prisma.assignments.updateMany.mockResolvedValue({ count: 0 });

    await service.handleAssignmentTimeouts();

    expect(requestsService.triggerMatching).not.toHaveBeenCalled();
  });

  it("does nothing when no assignments are expired", async () => {
    prisma.assignments.findMany.mockResolvedValue([]);
    await service.handleAssignmentTimeouts();
    expect(prisma.assignments.updateMany).not.toHaveBeenCalled();
    expect(requestsService.triggerMatching).not.toHaveBeenCalled();
  });
});

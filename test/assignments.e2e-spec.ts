import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/prisma/prisma.service";
import { JwtService } from "@nestjs/jwt";

describe("AssignmentsController (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let nannyToken: string;
  let nannyId: string;
  let parentToken: string;
  let parentId: string;
  let requestId: string;
  let assignmentId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);
    jwtService = app.get<JwtService>(JwtService);

    // Get seeded nanny and parent
    const nanny = await prisma.users.findUnique({
      where: { email: "nanny@example.com" },
    });
    const parent = await prisma.users.findUnique({
      where: { email: "parent@example.com" },
    });

    if (!nanny || !parent) {
      throw new Error("Seeded users not found");
    }

    nannyId = nanny.id;
    parentId = parent.id;
    nannyToken = jwtService.sign({ sub: nanny.id, email: nanny.email });
    parentToken = jwtService.sign({ sub: parent.id, email: parent.email });

    // Create a service request to generate an assignment
    const createRequestDto = {
      date: "2025-12-26",
      start_time: "10:00:00",
      duration_hours: 3,
      num_children: 1,
      children_ages: [4],
      required_skills: [],
      max_hourly_rate: 500.0,
    };

    const requestResponse = await request(app.getHttpServer())
      .post("/requests")
      .set("Authorization", `Bearer ${parentToken}`)
      .send(createRequestDto);

    requestId = requestResponse.body.id;

    // Get the assignment created by auto-matching
    const assignments = await prisma.assignments.findMany({
      where: { request_id: requestId },
      orderBy: { created_at: "desc" },
    });

    if (assignments.length > 0) {
      assignmentId = assignments[0].id;
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("/assignments/nanny/me (GET)", () => {
    it("should get all assignments for the nanny", () => {
      return request(app.getHttpServer())
        .get("/assignments/nanny/me")
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe("/assignments/pending (GET)", () => {
    it("should get pending assignments for the nanny", () => {
      return request(app.getHttpServer())
        .get("/assignments/pending")
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe("/assignments/:id (GET)", () => {
    it("should get assignment details", () => {
      if (!assignmentId) {
        console.warn("No assignment created, skipping test");
        return;
      }

      return request(app.getHttpServer())
        .get(`/assignments/${assignmentId}`)
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.id).toBe(assignmentId);
        });
    });
  });

  describe("/assignments/:id/accept (PUT)", () => {
    it("should accept an assignment and create a booking", async () => {
      // Create a fresh request to ensure we have a pending assignment
      const createRequestDto = {
        date: "2025-12-28",
        start_time: "11:00:00",
        duration_hours: 2,
        num_children: 1,
        children_ages: [5],
        required_skills: [],
        max_hourly_rate: 450.0,
      };

      const requestResponse = await request(app.getHttpServer())
        .post("/requests")
        .set("Authorization", `Bearer ${parentToken}`)
        .send(createRequestDto);

      const newRequestId = requestResponse.body.id;

      // Get the pending assignment
      const assignments = await prisma.assignments.findMany({
        where: { request_id: newRequestId, status: "pending" },
      });

      if (assignments.length === 0) {
        console.warn("No pending assignment found, skipping test");
        return;
      }

      const newAssignmentId = assignments[0].id;

      return request(app.getHttpServer())
        .put(`/assignments/${newAssignmentId}/accept`)
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          console.log("Accept response:", JSON.stringify(res.body, null, 2));
          expect(res.body.assignment).toBeDefined();
          expect(res.body.booking).toBeDefined();
          expect(res.body.assignment.status).toBe("accepted");
        });
    });
  });

  describe("/assignments/:id/reject (PUT)", () => {
    it("should reject an assignment with a reason", async () => {
      // Create another request to test rejection
      const createRequestDto = {
        date: "2025-12-27",
        start_time: "14:00:00",
        duration_hours: 2,
        num_children: 1,
        children_ages: [3],
        required_skills: [],
        max_hourly_rate: 400.0,
      };

      const requestResponse = await request(app.getHttpServer())
        .post("/requests")
        .set("Authorization", `Bearer ${parentToken}`)
        .send(createRequestDto);

      const newRequestId = requestResponse.body.id;

      // Get the assignment
      const assignments = await prisma.assignments.findMany({
        where: { request_id: newRequestId, status: "pending" },
      });

      if (assignments.length === 0) {
        console.warn("No pending assignment found, skipping test");
        return;
      }

      const newAssignmentId = assignments[0].id;

      return request(app.getHttpServer())
        .put(`/assignments/${newAssignmentId}/reject`)
        .set("Authorization", `Bearer ${nannyToken}`)
        .send({ reason: "Not available" })
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
        });
    });
  });
});

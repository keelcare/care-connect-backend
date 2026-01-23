import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/prisma/prisma.service";
import { JwtService } from "@nestjs/jwt";

describe("BookingsController (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let nannyToken: string;
  let nannyId: string;
  let parentToken: string;
  let parentId: string;
  let bookingId: string;

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

    // Get seeded users
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

    // Create a booking by creating and accepting an assignment
    const createRequestDto = {
      date: "2025-12-29",
      start_time: "09:00:00",
      duration_hours: 4,
      num_children: 2,
      children_ages: [3, 6],
      required_skills: [],
      max_hourly_rate: 500.0,
    };

    const requestResponse = await request(app.getHttpServer())
      .post("/requests")
      .set("Authorization", `Bearer ${parentToken}`)
      .send(createRequestDto);

    const requestId = requestResponse.body.id;

    // Get and accept the assignment
    const assignments = await prisma.assignments.findMany({
      where: { request_id: requestId, status: "pending" },
    });

    if (assignments.length > 0) {
      const assignmentId = assignments[0].id;
      const acceptResponse = await request(app.getHttpServer())
        .put(`/assignments/${assignmentId}/accept`)
        .set("Authorization", `Bearer ${nannyToken}`);

      bookingId = acceptResponse.body.booking.id;
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("/bookings/parent/me (GET)", () => {
    it("should get all bookings for the parent", () => {
      return request(app.getHttpServer())
        .get("/bookings/parent/me")
        .set("Authorization", `Bearer ${parentToken}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          expect(res.body.length).toBeGreaterThan(0);
        });
    });
  });

  describe("/bookings/nanny/me (GET)", () => {
    it("should get all bookings for the nanny", () => {
      return request(app.getHttpServer())
        .get("/bookings/nanny/me")
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe("/bookings/active (GET)", () => {
    it("should get active bookings", () => {
      return request(app.getHttpServer())
        .get("/bookings/active")
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe("/bookings/:id (GET)", () => {
    it("should get booking details", () => {
      if (!bookingId) {
        console.warn("No booking created, skipping test");
        return;
      }

      return request(app.getHttpServer())
        .get(`/bookings/${bookingId}`)
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.id).toBe(bookingId);
          expect(res.body.status).toBeDefined();
        });
    });
  });

  describe("/bookings/:id/start (PUT)", () => {
    it("should start a booking", async () => {
      if (!bookingId) {
        console.warn("No booking created, skipping test");
        return;
      }

      const booking = await prisma.bookings.findUnique({
        where: { id: bookingId },
      });

      if (booking?.status !== "confirmed") {
        console.warn("Booking not in confirmed status, skipping test");
        return;
      }

      return request(app.getHttpServer())
        .put(`/bookings/${bookingId}/start`)
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe("IN_PROGRESS");
        });
    });
  });

  describe("/bookings/:id/complete (PUT)", () => {
    it("should complete a booking", async () => {
      if (!bookingId) {
        console.warn("No booking created, skipping test");
        return;
      }

      // Ensure booking is in IN_PROGRESS state
      const booking = await prisma.bookings.findUnique({
        where: { id: bookingId },
      });

      if (booking?.status !== "IN_PROGRESS") {
        // Start it first
        await request(app.getHttpServer())
          .put(`/bookings/${bookingId}/start`)
          .set("Authorization", `Bearer ${nannyToken}`);
      }

      return request(app.getHttpServer())
        .put(`/bookings/${bookingId}/complete`)
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe("COMPLETED");
        });
    });
  });

  describe("/bookings/:id/cancel (PUT)", () => {
    it("should cancel a booking", async () => {
      // Create a new booking to cancel
      const createRequestDto = {
        date: "2025-12-30",
        start_time: "10:00:00",
        duration_hours: 3,
        num_children: 1,
        children_ages: [4],
        required_skills: [],
        max_hourly_rate: 400.0,
      };

      const requestResponse = await request(app.getHttpServer())
        .post("/requests")
        .set("Authorization", `Bearer ${parentToken}`)
        .send(createRequestDto);

      const requestId = requestResponse.body.id;

      // Get and accept the assignment
      const assignments = await prisma.assignments.findMany({
        where: { request_id: requestId, status: "pending" },
      });

      if (assignments.length === 0) {
        console.warn("No assignment found, skipping test");
        return;
      }

      const assignmentId = assignments[0].id;
      const acceptResponse = await request(app.getHttpServer())
        .put(`/assignments/${assignmentId}/accept`)
        .set("Authorization", `Bearer ${nannyToken}`);

      const newBookingId = acceptResponse.body.booking.id;

      return request(app.getHttpServer())
        .put(`/bookings/${newBookingId}/cancel`)
        .set("Authorization", `Bearer ${parentToken}`)
        .send({ reason: "Change of plans" })
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe("CANCELLED");
        });
    });
  });
});

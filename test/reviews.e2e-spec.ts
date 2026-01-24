import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/prisma/prisma.service";
import { JwtService } from "@nestjs/jwt";

describe("ReviewsController (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let nannyToken: string;
  let nannyId: string;
  let parentToken: string;
  let parentId: string;
  let completedBookingId: string;
  let parentReviewId: string;
  let nannyReviewId: string;

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

    // Create and complete a booking for review testing
    const createRequestDto = {
      date: "2025-12-31",
      start_time: "08:00:00",
      duration_hours: 5,
      num_children: 1,
      children_ages: [7],
      required_skills: [],
      max_hourly_rate: 600.0,
    };

    const requestResponse = await request(app.getHttpServer())
      .post("/requests")
      .set("Authorization", `Bearer ${parentToken}`)
      .send(createRequestDto);

    const requestId = requestResponse.body.id;

    // Accept assignment
    const assignments = await prisma.assignments.findMany({
      where: { request_id: requestId, status: "pending" },
    });

    if (assignments.length > 0) {
      const assignmentId = assignments[0].id;
      const acceptResponse = await request(app.getHttpServer())
        .put(`/assignments/${assignmentId}/accept`)
        .set("Authorization", `Bearer ${nannyToken}`);

      completedBookingId = acceptResponse.body.booking.id;

      // Start and complete the booking
      await request(app.getHttpServer())
        .put(`/bookings/${completedBookingId}/start`)
        .set("Authorization", `Bearer ${nannyToken}`);

      await request(app.getHttpServer())
        .put(`/bookings/${completedBookingId}/complete`)
        .set("Authorization", `Bearer ${nannyToken}`);
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("/reviews (POST)", () => {
    it("should create a review from parent for nanny", async () => {
      if (!completedBookingId) {
        console.warn("No completed booking, skipping test");
        return;
      }

      const response = await request(app.getHttpServer())
        .post("/reviews")
        .set("Authorization", `Bearer ${parentToken}`)
        .send({
          bookingId: completedBookingId,
          rating: 5,
          comment: "Excellent nanny! Very professional and caring.",
        })
        .expect(201);

      expect(response.body.rating).toBe(5);
      expect(response.body.reviewer_id).toBe(parentId);
      expect(response.body.reviewee_id).toBe(nannyId);
      parentReviewId = response.body.id;
    });

    it("should create a review from nanny for parent", async () => {
      if (!completedBookingId) {
        console.warn("No completed booking, skipping test");
        return;
      }

      const response = await request(app.getHttpServer())
        .post("/reviews")
        .set("Authorization", `Bearer ${nannyToken}`)
        .send({
          bookingId: completedBookingId,
          rating: 4,
          comment: "Great family to work with!",
        })
        .expect(201);

      expect(response.body.rating).toBe(4);
      expect(response.body.reviewer_id).toBe(nannyId);
      expect(response.body.reviewee_id).toBe(parentId);
      nannyReviewId = response.body.id;
    });

    it("should fail to review incomplete booking", async () => {
      // Create a new booking that's not completed
      const createRequestDto = {
        date: "2026-01-01",
        start_time: "09:00:00",
        duration_hours: 2,
        num_children: 1,
        children_ages: [5],
        required_skills: [],
        max_hourly_rate: 400.0,
      };

      const requestResponse = await request(app.getHttpServer())
        .post("/requests")
        .set("Authorization", `Bearer ${parentToken}`)
        .send(createRequestDto);

      const requestId = requestResponse.body.id;

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
        .post("/reviews")
        .set("Authorization", `Bearer ${parentToken}`)
        .send({
          bookingId: newBookingId,
          rating: 5,
          comment: "Test",
        })
        .expect(400);
    });
  });

  describe("/reviews/:id (PATCH)", () => {
    it("should update own review", () => {
      if (!parentReviewId) {
        console.warn("No review to update, skipping test");
        return;
      }

      return request(app.getHttpServer())
        .patch(`/reviews/${parentReviewId}`)
        .set("Authorization", `Bearer ${parentToken}`)
        .send({
          rating: 4,
          comment: "Updated: Very good nanny!",
        })
        .expect(200)
        .expect((res) => {
          expect(res.body.rating).toBe(4);
          expect(res.body.comment).toBe("Updated: Very good nanny!");
        });
    });

    it("should fail to update someone else's review", () => {
      if (!parentReviewId) {
        console.warn("No review to update, skipping test");
        return;
      }

      return request(app.getHttpServer())
        .patch(`/reviews/${parentReviewId}`)
        .set("Authorization", `Bearer ${nannyToken}`)
        .send({
          rating: 1,
        })
        .expect(403);
    });
  });

  describe("/reviews/nanny/:nannyId (GET)", () => {
    it("should get all reviews for a nanny", () => {
      return request(app.getHttpServer())
        .get(`/reviews/nanny/${nannyId}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          expect(res.body.length).toBeGreaterThanOrEqual(1);
        });
    });
  });

  describe("/reviews/parent/:parentId (GET)", () => {
    it("should get all reviews for a parent", () => {
      return request(app.getHttpServer())
        .get(`/reviews/parent/${parentId}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe("/reviews/booking/:bookingId/can-review (GET)", () => {
    it("should check if user can review a booking", () => {
      if (!completedBookingId) {
        console.warn("No completed booking, skipping test");
        return;
      }

      return request(app.getHttpServer())
        .get(`/reviews/booking/${completedBookingId}/can-review`)
        .set("Authorization", `Bearer ${parentToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty("canReview");
          expect(res.body.canReview).toBe(false); // Already reviewed
          expect(res.body.reason).toContain("already reviewed");
        });
    });
  });

  describe("/reviews/user/:userId (GET)", () => {
    it("should get reviews for a user (nanny)", () => {
      return request(app.getHttpServer())
        .get(`/reviews/user/${nannyId}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe("/reviews/booking/:bookingId (GET)", () => {
    it("should get reviews for a booking", () => {
      if (!completedBookingId) {
        console.warn("No completed booking, skipping test");
        return;
      }

      return request(app.getHttpServer())
        .get(`/reviews/booking/${completedBookingId}`)
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          expect(res.body.length).toBeGreaterThanOrEqual(1);
        });
    });
  });

  describe("/reviews/:id (DELETE)", () => {
    it("should delete own review", () => {
      if (!nannyReviewId) {
        console.warn("No review to delete, skipping test");
        return;
      }

      return request(app.getHttpServer())
        .delete(`/reviews/${nannyReviewId}`)
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toContain("deleted successfully");
        });
    });

    it("should fail to delete someone else's review", () => {
      if (!parentReviewId) {
        console.warn("No review to delete, skipping test");
        return;
      }

      return request(app.getHttpServer())
        .delete(`/reviews/${parentReviewId}`)
        .set("Authorization", `Bearer ${nannyToken}`)
        .expect(403);
    });
  });
});

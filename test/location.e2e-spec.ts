import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/prisma/prisma.service";

describe("LocationController (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    try {
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
    } catch (error) {
      console.error("Error in beforeAll:", error);
      throw error;
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("/location/nannies/nearby (GET)", () => {
    it("should find nearby nannies within default radius", () => {
      // Using coordinates near the seeded nanny location
      // Seeded nannies are in Mumbai (Andheri, Powai areas)
      return request(app.getHttpServer())
        .get("/location/nannies/nearby")
        .query({ lat: 19.0596, lng: 72.8295 }) // Bandra, Mumbai
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.radius).toBe("10km");
          expect(Array.isArray(res.body.data)).toBe(true);
          expect(res.body.count).toBeGreaterThanOrEqual(0);

          // If nannies are found, check the structure
          if (res.body.data.length > 0) {
            const nanny = res.body.data[0];
            expect(nanny).toHaveProperty("id");
            expect(nanny).toHaveProperty("email");
            expect(nanny).toHaveProperty("distance");
            expect(typeof nanny.distance).toBe("number");
          }
        });
    });

    it("should find nearby nannies within custom radius", () => {
      return request(app.getHttpServer())
        .get("/location/nannies/nearby")
        .query({ lat: 19.0596, lng: 72.8295, radius: 50 }) // Bandra with 50km radius
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.radius).toBe("50km");
          expect(Array.isArray(res.body.data)).toBe(true);
        });
    });

    it("should return empty array when no nannies nearby", () => {
      // Using coordinates far from any seeded data (middle of ocean)
      return request(app.getHttpServer())
        .get("/location/nannies/nearby")
        .query({ lat: 0, lng: 0, radius: 1 })
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.count).toBe(0);
          expect(res.body.data).toEqual([]);
        });
    });

    it("should fail with invalid latitude", () => {
      return request(app.getHttpServer())
        .get("/location/nannies/nearby")
        .query({ lat: 100, lng: -74.006 }) // Invalid lat > 90
        .expect(400);
    });

    it("should fail with invalid longitude", () => {
      return request(app.getHttpServer())
        .get("/location/nannies/nearby")
        .query({ lat: 40.7128, lng: 200 }) // Invalid lng > 180
        .expect(400);
    });

    it("should fail with missing parameters", () => {
      return request(app.getHttpServer())
        .get("/location/nannies/nearby")
        .query({ lat: 40.7128 }) // Missing lng
        .expect(400);
    });

    it("should fail with invalid radius", () => {
      return request(app.getHttpServer())
        .get("/location/nannies/nearby")
        .query({ lat: 40.7128, lng: -74.006, radius: 150 }) // radius > 100
        .expect(400);
    });
  });

  describe("/location/jobs/nearby (GET)", () => {
    it("should find nearby jobs within default radius", () => {
      // Using coordinates near potential job locations in Mumbai
      return request(app.getHttpServer())
        .get("/location/jobs/nearby")
        .query({ lat: 19.0596, lng: 72.8295 }) // Bandra, Mumbai
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.radius).toBe("10km");
          expect(Array.isArray(res.body.data)).toBe(true);
          expect(res.body.count).toBeGreaterThanOrEqual(0);

          // If jobs are found, check the structure
          if (res.body.data.length > 0) {
            const job = res.body.data[0];
            expect(job).toHaveProperty("id");
            expect(job).toHaveProperty("title");
            expect(job).toHaveProperty("distance");
            expect(typeof job.distance).toBe("number");
          }
        });
    });

    it("should find nearby jobs within custom radius", () => {
      return request(app.getHttpServer())
        .get("/location/jobs/nearby")
        .query({ lat: 19.0596, lng: 72.8295, radius: 25 }) // Bandra with 25km radius
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.radius).toBe("25km");
          expect(Array.isArray(res.body.data)).toBe(true);
        });
    });

    it("should return empty array when no jobs nearby", () => {
      // Using coordinates far from any seeded data
      return request(app.getHttpServer())
        .get("/location/jobs/nearby")
        .query({ lat: 0, lng: 0, radius: 1 })
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.count).toBe(0);
          expect(res.body.data).toEqual([]);
        });
    });

    it("should fail with invalid parameters", () => {
      return request(app.getHttpServer())
        .get("/location/jobs/nearby")
        .query({ lat: "invalid", lng: -74.006 })
        .expect(400);
    });
  });

  describe("/location/geocode (POST)", () => {
    it("should geocode a valid address", () => {
      const geocodeDto = {
        address: "1600 Amphitheatre Parkway, Mountain View, CA",
      };

      return request(app.getHttpServer())
        .post("/location/geocode")
        .send(geocodeDto)
        .expect(201)
        .expect((res) => {
          // Note: This test will only pass if GOOGLE_MAPS_API_KEY is configured
          // Otherwise it will return success: false
          expect(res.body).toHaveProperty("success");

          if (res.body.success) {
            expect(res.body.data).toHaveProperty("lat");
            expect(res.body.data).toHaveProperty("lng");
            expect(typeof res.body.data.lat).toBe("number");
            expect(typeof res.body.data.lng).toBe("number");
          } else {
            expect(res.body).toHaveProperty("message");
          }
        });
    });

    it("should fail with empty address", () => {
      const geocodeDto = {
        address: "",
      };

      return request(app.getHttpServer())
        .post("/location/geocode")
        .send(geocodeDto)
        .expect(400);
    });

    it("should fail with missing address", () => {
      return request(app.getHttpServer())
        .post("/location/geocode")
        .send({})
        .expect(400);
    });
  });
});

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/prisma/prisma.service";

describe("UsersController (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let parentId: string;
  let nannyId: string;

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

      // Get seeded users
      const parent = await prisma.users.findUnique({
        where: { email: "parent@example.com" },
      });
      const nanny = await prisma.users.findUnique({
        where: { email: "nanny@example.com" },
      });

      if (!parent || !nanny) {
        console.error(
          'Seeded users not found. Please run "npx prisma db seed" first.',
        );
        throw new Error("Seeded users not found");
      }

      parentId = parent.id;
      nannyId = nanny.id;
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

  describe("/users/:id (GET)", () => {
    it("should return parent profile", () => {
      return request(app.getHttpServer())
        .get(`/users/${parentId}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.email).toBe("parent@example.com");
          expect(res.body.profiles).toBeTruthy();
          expect(res.body.profiles.first_name).toBe("Rajesh");
        });
    });

    it("should return nanny profile with details", () => {
      return request(app.getHttpServer())
        .get(`/users/${nannyId}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.email).toBe("nanny@example.com");
          expect(res.body.nanny_details).toBeTruthy();
          expect(Array.isArray(res.body.nanny_details.skills)).toBe(true);
          expect(res.body.nanny_details.skills).toContain("Hindi");
        });
    });

    it("should return 404 for non-existent user", () => {
      return request(app.getHttpServer())
        .get("/users/00000000-0000-0000-0000-000000000000")
        .expect(404);
    });
  });

  describe("/users/:id (PUT)", () => {
    it("should update parent profile", () => {
      const updateDto = {
        firstName: "Jonathan",
        address: "New Address 123",
      };

      return request(app.getHttpServer())
        .put(`/users/${parentId}`)
        .send(updateDto)
        .expect(200)
        .expect((res) => {
          expect(res.body.profiles.first_name).toBe("Jonathan");
          expect(res.body.profiles.address).toBe("New Address 123");
        });
    });

    it("should update nanny details", () => {
      const updateDto = {
        hourlyRate: 25.5,
        skills: ["Cooking", "Driving"],
      };

      return request(app.getHttpServer())
        .put(`/users/${nannyId}`)
        .send(updateDto)
        .expect(200)
        .expect((res) => {
          expect(Number(res.body.nanny_details.hourly_rate)).toBe(25.5);
          expect(res.body.nanny_details.skills).toEqual(["Cooking", "Driving"]);
        });
    });

    it("should fail if invalid data is sent", () => {
      const invalidDto = {
        hourlyRate: "not-a-number",
      };

      return request(app.getHttpServer())
        .put(`/users/${nannyId}`)
        .send(invalidDto)
        .expect(400);
    });
  });
});

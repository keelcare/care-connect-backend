import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/prisma/prisma.service";
import { JwtService } from "@nestjs/jwt";

describe("RequestsController (e2e)", () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let jwtService: JwtService;
    let parentToken: string;
    let parentId: string;
    let requestId: string;

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

        // Get seeded parent
        const parent = await prisma.users.findUnique({
            where: { email: "parent@example.com" },
        });

        if (!parent) {
            throw new Error("Seeded parent not found");
        }

        parentId = parent.id;
        // Generate token for parent
        parentToken = jwtService.sign({ sub: parent.id, email: parent.email });
    });

    afterAll(async () => {
        if (app) {
            await app.close();
        }
    });

    describe("/requests (POST)", () => {
        it("should create a new service request", () => {
            const createRequestDto = {
                date: "2025-12-25",
                start_time: "14:30:00",
                duration_hours: 4,
                num_children: 2,
                children_ages: [3, 5],
                special_requirements: "None",
                required_skills: ["CPR"],
                max_hourly_rate: 25.0,
            };

            return request(app.getHttpServer())
                .post("/requests")
                .set("Authorization", `Bearer ${parentToken}`)
                .send(createRequestDto)
                .expect(201)
                .expect((res) => {
                    expect(res.body).toHaveProperty("id");
                    expect(res.body.parent_id).toBe(parentId);
                    expect(res.body.status).toMatch(/pending|assigned|no_matches/);
                    requestId = res.body.id;
                })
                .catch((err) => {
                    if (err.response) {
                        console.error("Create Request Failed:", JSON.stringify(err.response.body, null, 2));
                    }
                    throw err;
                });
        });

        it("should fail with invalid data", () => {
            const invalidDto = {
                date: "invalid-date",
                duration_hours: -1,
            };

            return request(app.getHttpServer())
                .post("/requests")
                .set("Authorization", `Bearer ${parentToken}`)
                .send(invalidDto)
                .expect(400);
        });

        it("should fail without authorization", () => {
            return request(app.getHttpServer()).post("/requests").send({}).expect(401);
        });
    });

    describe("/requests/:id (GET)", () => {
        it("should get request details", () => {
            return request(app.getHttpServer())
                .get(`/requests/${requestId}`)
                .set("Authorization", `Bearer ${parentToken}`)
                .expect(200)
                .expect((res) => {
                    expect(res.body.id).toBe(requestId);
                    expect(res.body.parent_id).toBe(parentId);
                });
        });

        it("should return 404 for non-existent request", () => {
            return request(app.getHttpServer())
                .get("/requests/00000000-0000-0000-0000-000000000000")
                .set("Authorization", `Bearer ${parentToken}`)
                .expect(404);
        });
    });

    describe("/requests/parent/me (GET)", () => {
        it("should get all requests for the parent", () => {
            return request(app.getHttpServer())
                .get("/requests/parent/me")
                .set("Authorization", `Bearer ${parentToken}`)
                .expect(200)
                .expect((res) => {
                    expect(Array.isArray(res.body)).toBe(true);
                    expect(res.body.length).toBeGreaterThan(0);
                    expect(res.body[0].parent_id).toBe(parentId);
                });
        });
    });
});

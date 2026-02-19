import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/prisma/prisma.service";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";

describe("Concurrency (e2e)", () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let jwtService: JwtService;
    let parent1Token: string;
    let parent2Token: string;
    let nannyId: string;

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

        // 1. Deactivate other nannies in Mumbai to isolate the test nanny
        await prisma.nanny_details.updateMany({
            where: {
                users: {
                    role: "nanny",
                    email: { not: "concurrency-nanny@test.com" }
                }
            },
            data: { is_available_now: false }
        });

        const hashedPassword = await bcrypt.hash("password", 10);

        // 2. Create/Ensure the test Nanny exists and is available
        const nanny = await prisma.users.upsert({
            where: { email: "concurrency-nanny@test.com" },
            update: { identity_verification_status: "verified" },
            create: {
                email: "concurrency-nanny@test.com",
                password_hash: hashedPassword,
                role: "nanny",
                is_verified: true,
                identity_verification_status: "verified",
                profiles: {
                    create: {
                        first_name: "Test",
                        last_name: "Nanny",
                        lat: 19.1136,
                        lng: 72.8697,
                    },
                },
                nanny_details: {
                    create: {
                        skills: ["CPR", "Nanny"],
                        experience_years: 5,
                        is_available_now: true,
                    },
                },
            },
        });
        nannyId = nanny.id;

        // Explicitly make her available for the test
        await prisma.nanny_details.update({
            where: { user_id: nannyId },
            data: { is_available_now: true }
        });

        // 3. Create Parents
        const parent1 = await prisma.users.upsert({
            where: { email: "concurrency-parent1@test.com" },
            update: {},
            create: {
                email: "concurrency-parent1@test.com",
                password_hash: hashedPassword,
                role: "parent",
                is_verified: true,
                profiles: {
                    create: {
                        first_name: "Parent",
                        last_name: "One",
                        lat: 19.0596,
                        lng: 72.8295,
                    },
                },
            },
        });
        parent1Token = jwtService.sign({ sub: parent1.id, email: parent1.email });

        const parent2 = await prisma.users.upsert({
            where: { email: "concurrency-parent2@test.com" },
            update: {},
            create: {
                email: "concurrency-parent2@test.com",
                password_hash: hashedPassword,
                role: "parent",
                is_verified: true,
                profiles: {
                    create: {
                        first_name: "Parent",
                        last_name: "Two",
                        lat: 19.0600,
                        lng: 72.8300,
                    },
                },
            },
        });
        parent2Token = jwtService.sign({ sub: parent2.id, email: parent2.email });

        await prisma.services.upsert({
            where: { name: 'CC' },
            update: {},
            create: { name: 'CC', hourly_rate: 200.0 },
        });
    }, 60000);

    afterAll(async () => {
        // Re-activate other nannies
        await prisma.nanny_details.updateMany({
            where: {
                users: {
                    role: "nanny"
                }
            },
            data: { is_available_now: true }
        });

        // Cleanup
        await prisma.bookings.deleteMany({
            where: {
                users_bookings_nanny_idTousers: {
                    email: "concurrency-nanny@test.com"
                }
            }
        });
        await prisma.assignments.deleteMany({
            where: {
                users: {
                    email: "concurrency-nanny@test.com"
                }
            }
        });
        await prisma.service_requests.deleteMany({
            where: {
                users: {
                    email: { in: ["concurrency-parent1@test.com", "concurrency-parent2@test.com"] }
                }
            }
        });

        if (app) {
            await app.close();
        }
    });

    it("should ensure only ONE booking is confirmed for the same nanny/time slot", async () => {
        const requestData = {
            date: "2026-10-10",
            start_time: "10:00:00",
            duration_hours: 2,
            num_children: 1,
            category: "CC",
            required_skills: ["CPR"],
        };

        console.log("Sending concurrent requests for the same nanny...");

        const results = await Promise.all([
            request(app.getHttpServer())
                .post("/requests")
                .set("Authorization", `Bearer ${parent1Token}`)
                .send(requestData),
            request(app.getHttpServer())
                .post("/requests")
                .set("Authorization", `Bearer ${parent2Token}`)
                .send(requestData),
        ]);

        console.log("Requests finished.");

        // Wait for all async matching to finish
        await new Promise(resolve => setTimeout(resolve, 10000));

        const confirmedBookings = await prisma.bookings.findMany({
            where: {
                nanny_id: nannyId,
                status: "CONFIRMED",
            },
        });

        console.log("Confirmed bookings for nanny count:", confirmedBookings.length);

        // Exactly 1 booking should be confirmed. The other should have failed assignment
        // (either remaining pending or assigned to another if available, but we deactivated others).
        expect(confirmedBookings.length).toBe(1);
    }, 60000);
});

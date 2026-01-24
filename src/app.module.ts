import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "path";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { PrismaModule } from "./prisma/prisma.module";
import { LocationModule } from "./location/location.module";
import { ChatModule } from "./chat/chat.module";
import { BookingsModule } from "./bookings/bookings.module";
import { ReviewsModule } from "./reviews/reviews.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { AdminModule } from "./admin/admin.module";
import { RequestsModule } from "./requests/requests.module";
import { AssignmentsModule } from "./assignments/assignments.module";
import { FavoritesModule } from "./favorites/favorites.module";
import { AiModule } from "./ai/ai.module";
import { RecurringBookingsModule } from "./recurring-bookings/recurring-bookings.module";
import { AvailabilityModule } from "./availability/availability.module";
import { VerificationModule } from "./verification/verification.module";
import { PaymentsModule } from "./payments/payments.module";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import * as Joi from "joi";
import { LoggerModule } from "nestjs-pino";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: "prisma.env",
      validationSchema: Joi.object({
        DATABASE_URL: Joi.string().required(),
        JWT_SECRET: Joi.string().required(),
        PORT: Joi.number().default(4000),
        FRONTEND_URL: Joi.string().uri().optional(), // Marking optional only to avoid breaking dev if not set
      }),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== "production"
            ? {
                target: "pino-pretty",
                options: {
                  singleLine: true,
                },
              }
            : undefined,
      },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1 minute
        limit: 1000, // Increased to 1000 for dev/testing flows
      },
    ]),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), "uploads"),
      serveRoot: "/uploads",
    }),
    ScheduleModule.forRoot(),
    AuthModule,
    UsersModule,
    PrismaModule,
    LocationModule,
    ChatModule,
    BookingsModule,
    ReviewsModule,
    NotificationsModule,
    AdminModule,
    RequestsModule,
    AssignmentsModule,
    FavoritesModule,
    AiModule,
    RecurringBookingsModule,
    AvailabilityModule,
    VerificationModule,
    PaymentsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

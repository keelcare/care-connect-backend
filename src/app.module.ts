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
import { CommonModule } from "./common/common.module";
import { FamilyModule } from "./family/family.module";
import { ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { UserThrottlerGuard } from "./common/guards/user-throttler.guard";
import * as Joi from "joi";
import { LoggerModule } from "nestjs-pino";
import { ServicesModule } from './services/services.module';
import { NanniesModule } from './nannies/nannies.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
      validationSchema: Joi.object({
        // Database
        DATABASE_URL: Joi.string().required(),

        // Authentication
        JWT_SECRET: Joi.string().required(),

        // Server
        PORT: Joi.number().default(4000),
        FRONTEND_URL: Joi.string().uri().optional(),

        // API Keys - Optional (warnings logged in services if missing)
        RAZORPAY_KEY_ID: Joi.string().allow('', null).optional(),
        RAZORPAY_KEY_SECRET: Joi.string().allow('', null).optional(),
        RAZORPAY_WEBHOOK_SECRET: Joi.string().allow('', null).optional(),
        GOOGLE_MAPS_API_KEY: Joi.string().allow('', null).optional(),
        GEMINI_API_KEY: Joi.string().allow('', null).optional(),
        CLOUDINARY_API_KEY: Joi.string().allow('', null).optional(),
        CLOUDINARY_API_SECRET: Joi.string().allow('', null).optional(),
        CLOUDINARY_CLOUD_NAME: Joi.string().allow('', null).optional(),
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
        name: 'default',
        ttl: 60000,
        limit: 300, // Balanced global limit for SPA usage
      }
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
    CommonModule,
    FamilyModule,
    ServicesModule,
    NanniesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
  ],
})
export class AppModule { }

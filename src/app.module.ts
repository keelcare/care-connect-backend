import { Module, NestModule, MiddlewareConsumer } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER } from "@nestjs/core";
import { CorrelationIdMiddleware } from "./common/middleware/correlation-id.middleware";
import { CsrfMiddleware } from "./common/middleware/csrf.middleware";
import { SentryModule, SentryGlobalFilter } from "@sentry/nestjs/setup";
import { ScheduleModule } from "@nestjs/schedule";
import { EventEmitterModule } from "@nestjs/event-emitter";
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
import { ServicesModule } from "./services/services.module";
import { NanniesModule } from "./nannies/nannies.module";
import { NannyOnboardingModule } from "./nanny-onboarding/nanny-onboarding.module";
import { WhatsAppModule } from "./whatsapp/whatsapp.module";
import { SupportModule } from "./support/support.module";
import { SseModule } from "./sse/sse.module";
import { MailModule } from "./mail/mail.module";
import { DisputesModule } from "./disputes/disputes.module";
import { ProgressReportsModule } from "./progress-reports/progress-reports.module";
import { RecurringRequestsModule } from './recurring-requests/recurring-requests.module';
import { AddressesModule } from "./addresses/addresses.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),
    SentryModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req: any) => {
          return req.headers["x-request-id"] || req.id;
        },
        redact: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "req.body.token",
          "req.body.access_token",
          "req.body.refresh_token",
        ],
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
        name: "default",
        ttl: 60000,
        limit: 300, // Balanced global limit for SPA usage
      },
    ]),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    SseModule,
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
    RecurringBookingsModule,
    AvailabilityModule,
    VerificationModule,
    PaymentsModule,
    CommonModule,
    FamilyModule,
    ServicesModule,
    NanniesModule,
    NannyOnboardingModule,
    WhatsAppModule,
    SupportModule,
    MailModule,
    DisputesModule,
    ProgressReportsModule,
    RecurringRequestsModule,
    AddressesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes("*");
    consumer.apply(CsrfMiddleware).forRoutes("*");
  }
}

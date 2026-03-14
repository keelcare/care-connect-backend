import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ServeStaticModule } from "@nestjs/serve-static";
import { EventEmitterModule } from "@nestjs/event-emitter";
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
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { SupportModule } from './support/support.module';
import { SseModule } from './sse/sse.module';
import { MailModule } from './mail/mail.module';
import { DisputesModule } from './disputes/disputes.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
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
    WhatsAppModule,
    SupportModule,
    MailModule,
    DisputesModule,
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

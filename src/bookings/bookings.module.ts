import { Module, forwardRef } from "@nestjs/common";
import { BookingsService } from "./bookings.service";
import { BookingsController } from "./bookings.controller";
import { ChatModule } from "../chat/chat.module";
import { RequestsModule } from "../requests/requests.module";
import { TasksService } from "../tasks/tasks.service";
import { MailModule } from "../mail/mail.module";
import { PaymentsModule } from "../payments/payments.module";
import { BookingListeners } from "./listeners/booking.listeners";
import { ProgressReportsModule } from "../progress-reports/progress-reports.module";

@Module({
  imports: [
    ChatModule,
    RequestsModule,
    MailModule,
    forwardRef(() => PaymentsModule),
    forwardRef(() => ProgressReportsModule),
  ],
  controllers: [BookingsController],
  providers: [BookingsService, TasksService, BookingListeners],
  exports: [BookingsService],
})
export class BookingsModule {}

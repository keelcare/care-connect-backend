import { Module, forwardRef } from "@nestjs/common";
import { BookingsService } from "./bookings.service";
import { BookingsController } from "./bookings.controller";
import { ChatModule } from "../chat/chat.module"; // Import ChatModule to use ChatService later
import { RequestsModule } from "../requests/requests.module";
import { TasksService } from "../tasks/tasks.service";
import { MailModule } from "../mail/mail.module";
import { PaymentsModule } from "../payments/payments.module";

@Module({
  imports: [
    ChatModule,
    RequestsModule,
    MailModule,
    forwardRef(() => PaymentsModule),
  ],
  controllers: [BookingsController],
  providers: [BookingsService, TasksService],
  exports: [BookingsService],
})
export class BookingsModule {}

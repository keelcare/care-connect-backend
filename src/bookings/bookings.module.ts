import { Module } from "@nestjs/common";
import { BookingsService } from "./bookings.service";
import { BookingsController } from "./bookings.controller";
import { ChatModule } from "../chat/chat.module"; // Import ChatModule to use ChatService later
import { RequestsModule } from "../requests/requests.module";
import { TasksService } from "../tasks/tasks.service";

@Module({
  imports: [ChatModule, RequestsModule],
  controllers: [BookingsController],
  providers: [BookingsService, TasksService],
  exports: [BookingsService],
})
export class BookingsModule { }

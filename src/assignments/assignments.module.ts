import { Module } from "@nestjs/common";
import { AssignmentsService } from "./assignments.service";
import { AssignmentsController } from "./assignments.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { RequestsModule } from "../requests/requests.module";
import { AssignmentsTaskService } from "./assignments.task.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { ChatModule } from "../chat/chat.module";

@Module({
  imports: [PrismaModule, RequestsModule, NotificationsModule, ChatModule],
  controllers: [AssignmentsController],
  providers: [AssignmentsService, AssignmentsTaskService],
  exports: [AssignmentsService],
})
export class AssignmentsModule { }

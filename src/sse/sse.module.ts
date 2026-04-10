import { Global, Module } from "@nestjs/common";
import { SseService } from "./sse.service";
import { SseController } from "./sse.controller";

/**
 * SseModule is @Global() so SseService can be injected into any feature
 * module (Bookings, Assignments, Requests, Notifications) without explicit
 * imports. This mirrors how NotificationsModule is already structured.
 */
@Global()
@Module({
  controllers: [SseController],
  providers: [SseService],
  exports: [SseService],
})
export class SseModule {}

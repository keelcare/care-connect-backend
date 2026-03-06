import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  UseGuards,
  Request,
} from "@nestjs/common";
import { AssignmentsService } from "./assignments.service";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";

@Controller("assignments")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Get("nanny/me")
  findAllMyAssignments(@Request() req) {
    return this.assignmentsService.findAllByNanny(req.user.id);
  }

  @Get("pending")
  findPendingAssignments(@Request() req) {
    return this.assignmentsService.findPendingByNanny(req.user.id);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.assignmentsService.findOne(id);
  }

  @Put(":id/accept")
  accept(@Param("id") id: string, @Request() req) {
    return this.assignmentsService.accept(id, req.user.id);
  }

  @Put(":id/reject")
  reject(
    @Param("id") id: string,
    @Request() req,
    @Body("reason") reason?: string,
  ) {
    return this.assignmentsService.reject(id, req.user.id, reason);
  }
}

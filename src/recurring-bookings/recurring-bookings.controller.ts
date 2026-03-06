import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
} from "@nestjs/common";
import { RecurringBookingsService } from "./recurring-bookings.service";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";

@Controller("recurring-bookings")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class RecurringBookingsController {
  constructor(
    private readonly recurringBookingsService: RecurringBookingsService,
  ) {}

  @Get()
  async findAll(@Request() req) {
    return this.recurringBookingsService.findAll(req.user.id, req.user.role);
  }

  @Get(":id")
  async findOne(@Param("id") id: string) {
    return this.recurringBookingsService.findOne(id);
  }

  @Post()
  async create(@Request() req, @Body() data: any) {
    return this.recurringBookingsService.create(req.user.id, data);
  }

  @Put(":id")
  async update(@Param("id") id: string, @Body() data: any) {
    return this.recurringBookingsService.update(id, data);
  }

  @Delete(":id")
  async delete(@Param("id") id: string) {
    return this.recurringBookingsService.delete(id);
  }
}

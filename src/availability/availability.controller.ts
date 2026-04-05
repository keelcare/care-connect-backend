import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
} from "@nestjs/common";
import { AvailabilityService } from "./availability.service";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";

@Controller("availability")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class AvailabilityController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  @Get()
  async findAll(@Request() req) {
    return this.availabilityService.findAll(req.user.id);
  }

  @Post("block")
  async createBlock(@Request() req, @Body() data: any) {
    return this.availabilityService.createBlock(req.user.id, data);
  }

  @Delete(":id")
  async deleteBlock(@Param("id") id: string) {
    return this.availabilityService.delete(id);
  }
}

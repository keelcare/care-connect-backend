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
import { CreateAvailabilityBlockDto } from "./dto/create-availability-block.dto";

@Controller("availability")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class AvailabilityController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  @Get()
  async findAll(@Request() req) {
    return this.availabilityService.findAll(req.user.id);
  }

  @Get("demand-forecast")
  async getDemandForecast(@Request() req) {
    return this.availabilityService.getDemandForecast(req.user.id);
  }

  @Post("block")
  async createBlock(
    @Request() req,
    @Body() data: CreateAvailabilityBlockDto,
  ) {
    return this.availabilityService.createBlock(req.user.id, data);
  }

  @Delete(":id")
  async deleteBlock(@Param("id") id: string, @Request() req) {
    return this.availabilityService.delete(id, req.user.id);
  }
}

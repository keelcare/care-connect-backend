import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
  Req,
} from "@nestjs/common";
import { DisputesService } from "./disputes.service";
import { CreateDisputeDto } from "./dto/create-dispute.dto";
import { ResolveDisputeDto } from "./dto/resolve-dispute.dto";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "../auth/dto/signup.dto";
import { ActiveUserGuard } from "../common/guards/active-user.guard";

@Controller("disputes")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post()
  async raiseDispute(@Req() req, @Body() dto: CreateDisputeDto) {
    return this.disputesService.create(req.user.id, dto);
  }

  @Get("my")
  async getMyDisputes(@Req() req) {
    return this.disputesService.findByUserId(req.user.id);
  }

  // --- Admin Endpoints ---

  @Get("admin")
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  async getAllDisputes() {
    return this.disputesService.findAll();
  }

  @Get("admin/:id")
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  async getDisputeById(@Param("id") id: string) {
    return this.disputesService.findOne(id);
  }

  @Patch("admin/:id/resolve")
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  async resolveDispute(
    @Param("id") id: string,
    @Req() req,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.disputesService.resolve(id, req.user.id, dto);
  }
}

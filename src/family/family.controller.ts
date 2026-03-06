import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { FamilyService } from "./family.service";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { CreateChildDto } from "./dto/create-child.dto";
import { UpdateChildDto } from "./dto/update-child.dto";

@Controller("family/children")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class FamilyController {
  constructor(private readonly familyService: FamilyService) {}

  @Get()
  async findAll(@Request() req) {
    return this.familyService.findAll(req.user.id);
  }

  @Post()
  async create(@Body() dto: CreateChildDto, @Request() req) {
    return this.familyService.create(req.user.id, dto);
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateChildDto,
    @Request() req,
  ) {
    return this.familyService.update(id, req.user.id, dto);
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Request() req) {
    return this.familyService.remove(id, req.user.id);
  }
}

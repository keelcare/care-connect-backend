import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { AddressesService } from "./addresses.service";
import { CreateAddressDto } from "./dto/create-address.dto";
import { UpdateAddressDto } from "./dto/update-address.dto";

@Controller("addresses")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  @Get()
  async list(@Request() req) {
    return this.addressesService.list(req.user.id);
  }

  @Post()
  async create(@Body() dto: CreateAddressDto, @Request() req) {
    return this.addressesService.create(req.user.id, dto);
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateAddressDto,
    @Request() req,
  ) {
    return this.addressesService.update(req.user.id, id, dto);
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Request() req) {
    return this.addressesService.remove(req.user.id, id);
  }

  @Patch(":id/default")
  async setDefault(@Param("id") id: string, @Request() req) {
    return this.addressesService.setDefault(req.user.id, id);
  }
}

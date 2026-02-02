import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
  Request,
  ForbiddenException,
} from "@nestjs/common";
import { UsersService } from "./users.service";
import { UpdateUserDto } from "./dto/update-user.dto";
import { AuthGuard } from "@nestjs/passport";
import { OwnershipGuard, ResourceOwnership, ResourceType } from "../common/guards/ownership.guard";
import { PermissionsGuard, RequirePermissions } from "../common/guards/permissions.guard";
import { Permission } from "../common/constants/permissions.enum";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  @UseGuards(AuthGuard("jwt"))
  @Get("me")
  async getProfile(@Request() req) {
    return this.usersService.findMe(req.user.id);
  }

  @Get("nannies")
  getAllNannies() {
    return this.usersService.findAllNannies();
  }

  @Get(":id")
  getUser(@Param("id") id: string) {
    return this.usersService.findOne(id);
  }

  @UseGuards(AuthGuard("jwt"), OwnershipGuard, PermissionsGuard)
  @RequirePermissions(Permission.USER_WRITE)
  @ResourceOwnership(ResourceType.USER)
  @Put(":id")
  updateUser(@Param("id") id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Post("upload-image")
  uploadImage(@Body() body: { userId: string; imageUrl: string }, @Request() req) {
    if (body.userId !== req.user.id && req.user.role !== 'admin') {
      throw new ForbiddenException('Cannot upload image for another user');
    }
    return this.usersService.uploadImage(body.userId, body.imageUrl);
  }
}

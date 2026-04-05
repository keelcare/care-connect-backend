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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from "./users.service";
import { UpdateUserDto } from "./dto/update-user.dto";
import { UpdatePushTokenDto } from "./dto/update-push-token.dto";
import { AuthGuard } from "@nestjs/passport";
import { OwnershipGuard, ResourceOwnership, ResourceType } from "../common/guards/ownership.guard";
import { PermissionsGuard, RequirePermissions } from "../common/guards/permissions.guard";
import { Permission } from "../common/constants/permissions.enum";
import { ActiveUserGuard, SkipActiveCheck } from "../common/guards/active-user.guard";

@ApiTags('Users')
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @SkipActiveCheck()  // Banned users must reach this so the frontend can show the ban popup
  @Get("me")
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Return current user data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@Request() req) {
    return this.usersService.findMe(req.user.id);
  }

  @Get("nannies")
  @ApiOperation({ summary: 'Get all nannies' })
  @ApiResponse({ status: 200, description: 'Return list of all nannies' })
  getAllNannies() {
    return this.usersService.findAllNannies();
  }

  @Get(":id")
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiResponse({ status: 200, description: 'Return user data' })
  @ApiResponse({ status: 404, description: 'User not found' })
  getUser(@Param("id") id: string) {
    return this.usersService.findOne(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard, OwnershipGuard, PermissionsGuard)
  @RequirePermissions(Permission.USER_WRITE)
  @ResourceOwnership(ResourceType.USER)
  @Put(":id")
  @ApiOperation({ summary: 'Update user profile' })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - not owner or admin' })
  updateUser(@Param("id") id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Post("upload-image")
  @ApiOperation({ summary: 'Upload user profile image' })
  @ApiResponse({ status: 201, description: 'Image uploaded successfully' })
  uploadImage(@Body() body: { userId: string; imageUrl: string }, @Request() req) {
    if (body.userId !== req.user.id && req.user.role !== 'admin') {
      throw new ForbiddenException('Cannot upload image for another user');
    }
    return this.usersService.uploadImage(body.userId, body.imageUrl);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Post("push-token")
  @ApiOperation({ summary: 'Register FCM push token for mobile device' })
  @ApiResponse({ status: 201, description: 'Push token registered successfully' })
  async updatePushToken(@Request() req, @Body() body: UpdatePushTokenDto) {
    await this.usersService.updatePushToken(req.user.id, body.token);
    return { message: 'Push token updated successfully' };
  }
}

import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  Delete,
  Param,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { NanniesService } from "./nannies.service";
import { CreateCategoryRequestDto } from "./dto/create-category-request.dto";
import { PresenceDto } from "../attendance/dto/attendance.dto";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";

@ApiTags("Nannies")
@ApiBearerAuth()
@Controller("nannies")
export class NanniesController {
  constructor(private readonly nanniesService: NanniesService) {}

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Post("me/category-request")
  @ApiOperation({ summary: "Submit a new category upgrade request" })
  @ApiResponse({ status: 201, description: "Request submitted successfully" })
  async createCategoryRequest(
    @Request() req,
    @Body() dto: CreateCategoryRequestDto,
  ) {
    return this.nanniesService.createCategoryRequest(req.user.id, dto);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Get("me/category-request")
  @ApiOperation({ summary: "Get current pending category upgrade request" })
  @ApiResponse({ status: 200, description: "Return pending request if any" })
  async getMyCategoryRequest(@Request() req) {
    return this.nanniesService.getMyCategoryRequest(req.user.id);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Get("me/category-requests/history")
  @ApiOperation({ summary: "Get history of category upgrade requests" })
  @ApiResponse({
    status: 200,
    description: "Return list of historical requests",
  })
  async getMyCategoryRequestsHistory(@Request() req) {
    return this.nanniesService.getMyCategoryRequestsHistory(req.user.id);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Delete("me/category-request/:id")
  @ApiOperation({ summary: "Cancel a pending category upgrade request" })
  @ApiResponse({ status: 200, description: "Request cancelled successfully" })
  async cancelCategoryRequest(@Request() req, @Param("id") id: string) {
    return this.nanniesService.cancelCategoryRequest(req.user.id, id);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Get("me/dashboard")
  @ApiOperation({ summary: "Get nanny dashboard summary (today's earnings, schedule, weekly trend)" })
  @ApiResponse({ status: 200, description: "Dashboard summary returned" })
  async getDashboardSummary(@Request() req) {
    return this.nanniesService.getDashboardSummary(req.user.id);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Get("me/performance")
  @ApiOperation({ summary: "Get nanny performance overview (ratings, completion rate, sentiment)" })
  @ApiResponse({ status: 200, description: "Performance data returned" })
  async getPerformance(@Request() req) {
    return this.nanniesService.getPerformance(req.user.id);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Get("me/settings")
  @ApiOperation({ summary: "Get nanny quick settings (auto-accept, default hours)" })
  @ApiResponse({ status: 200, description: "Settings returned" })
  async getSettings(@Request() req) {
    return this.nanniesService.getSettings(req.user.id);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Post("me/settings")
  @ApiOperation({ summary: "Update nanny quick settings (auto-accept, default hours)" })
  @ApiResponse({ status: 200, description: "Settings updated" })
  async updateSettings(
    @Request() req,
    @Body()
    dto: {
      auto_accept_bookings?: boolean;
      default_start_time?: string | null;
      default_end_time?: string | null;
    },
  ) {
    return this.nanniesService.updateSettings(req.user.id, dto);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Post("me/presence")
  @ApiOperation({
    summary: "Set the caregiver's Online/Away state",
    description:
      "The partner app previously kept this only in device storage, so the toggle could not affect matching and the server had no idea who was reachable.",
  })
  @ApiResponse({ status: 200, description: "Presence updated" })
  async updatePresence(@Request() req, @Body() dto: PresenceDto) {
    return this.nanniesService.updatePresence(req.user.id, dto.online);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Post("me/heartbeat")
  @ApiOperation({
    summary: "Liveness ping from the partner app",
    description:
      "Touches last-seen without changing stated availability. Lets the attendance sweeps distinguish a caregiver who deliberately went Away from one whose app died mid-session.",
  })
  @ApiResponse({ status: 200, description: "Heartbeat recorded" })
  async heartbeat(@Request() req) {
    return this.nanniesService.recordHeartbeat(req.user.id);
  }
}

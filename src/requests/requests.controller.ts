import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
  Param,
  Put,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { RequestsService } from "./requests.service";
import { CreateRequestDto } from "./dto/create-request.dto";
import { TransparentJwtAuthGuard } from "../auth/guards/transparent-jwt-auth.guard";

@ApiTags("Requests")
@ApiBearerAuth()
@Controller("requests")
@UseGuards(TransparentJwtAuthGuard)
export class RequestsController {
  constructor(private readonly requestsService: RequestsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new care service request" })
  @ApiResponse({ status: 201, description: "Request created successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  create(@Request() req, @Body() createRequestDto: CreateRequestDto) {
    return this.requestsService.create(req.user.id, createRequestDto);
  }

  @Get("parent/me")
  @ApiOperation({
    summary: "Get all requests created by the authenticated parent",
  })
  @ApiResponse({ status: 200, description: "Return list of parent requests" })
  findAllMyRequests(@Request() req) {
    return this.requestsService.findAllByParent(req.user.id);
  }

  @Put(":id/cancel")
  @ApiOperation({ summary: "Cancel a care service request" })
  @ApiResponse({ status: 200, description: "Request cancelled successfully" })
  @ApiResponse({ status: 404, description: "Request not found" })
  @ApiResponse({ status: 403, description: "Forbidden - not the owner" })
  async cancelRequest(@Param("id") id: string, @Request() req) {
    const request = await this.requestsService.findOne(id);
    if (!request) throw new NotFoundException("Request not found");
    if (request.parent_id !== req.user.id) {
      throw new ForbiddenException(
        "You are not authorized to cancel this request",
      );
    }
    return this.requestsService.cancelRequest(id);
  }

  @Get(":id/matches")
  @ApiOperation({
    summary: "Get potential nanny matches for a request (Preview)",
  })
  @ApiResponse({ status: 200, description: "Return potential matches" })
  async getMatches(@Param("id") id: string) {
    // This would reuse the matching logic but return list instead of assigning
    // For now, just a placeholder or reuse triggerMatching logic without saving
    return { message: "Not implemented yet" };
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a specific request by ID" })
  @ApiResponse({ status: 200, description: "Return request details" })
  @ApiResponse({ status: 404, description: "Request not found" })
  findOne(@Param("id") id: string) {
    return this.requestsService.findOne(id);
  }
}

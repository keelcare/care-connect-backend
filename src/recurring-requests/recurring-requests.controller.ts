import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
  Param,
  Query,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { RecurringRequestsService } from "./recurring-requests.service";
import { CreateRecurringRequestDto } from "./dto/create-recurring-request.dto";
import { TransparentJwtAuthGuard } from "../auth/guards/transparent-jwt-auth.guard";

@ApiTags("Recurring Requests")
@ApiBearerAuth()
@Controller("recurring-requests")
@UseGuards(TransparentJwtAuthGuard)
export class RecurringRequestsController {
  constructor(
    private readonly recurringRequestsService: RecurringRequestsService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new recurring service request" })
  @ApiResponse({ status: 201, description: "Request created successfully" })
  create(@Request() req, @Body() dto: CreateRecurringRequestDto) {
    return this.recurringRequestsService.create(req.user.id, dto);
  }

  @Get("parent/me")
  @ApiOperation({
    summary: "Get all recurring requests created by the authenticated parent",
  })
  findAllMyRequests(@Request() req) {
    return this.recurringRequestsService.findAllByParent(req.user.id);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a specific recurring request by ID" })
  findOne(@Param("id") id: string) {
    return this.recurringRequestsService.findOne(id);
  }

  @Get(":id/bookings")
  @ApiOperation({ summary: "Get paginated bookings for a recurring request" })
  findBookings(
    @Param("id") id: string,
    @Query("page") page: string,
    @Query("limit") limit: string
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.recurringRequestsService.findBookingsForRequest(id, pageNum, limitNum);
  }
}

import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
  Param,
  Query,
  Delete,
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
  findOne(@Param("id") id: string, @Request() req) {
    return this.recurringRequestsService.findOne(id, req.user.id, req.user.role);
  }

  @Get(":id/cancellation-preview")
  @ApiOperation({
    summary: "What cancelling this plan would actually do, without doing it",
    description:
      "Sessions already paid for that the parent would keep (with the dates " +
      "already on the calendar), sessions that would be cancelled, money that " +
      "stops being payable, and anything still owed.\n\n" +
      "`refundAmount` is always 0: captured money buys sessions that survive " +
      "cancellation rather than being returned. Show this before the confirm " +
      "button — the outcome is a good one the parent cannot otherwise see coming.",
  })
  @ApiResponse({ status: 200, description: "Preview returned" })
  cancellationPreview(@Request() req, @Param("id") id: string) {
    return this.recurringRequestsService.cancellationPreview(id, req.user.id);
  }

  @Delete(":id")
  @ApiOperation({
    summary:
      "Cancel a recurring plan (parent only). Ends the series, retains every session already paid for, and cancels the rest.",
    description:
      "Returns `settlementNumber` — the frozen statement of what was kept and " +
      "what was released, downloadable at `/invoices/plan/:id/settlement/pdf`.",
  })
  @ApiResponse({ status: 200, description: "Plan cancelled successfully" })
  cancel(
    @Request() req,
    @Param("id") id: string,
    @Body("reason") reason?: string,
  ) {
    return this.recurringRequestsService.cancel(id, req.user.id, reason);
  }

  @Get(":id/bookings")
  @ApiOperation({ summary: "Get paginated bookings for a recurring request" })
  findBookings(
    @Request() req,
    @Param("id") id: string,
    @Query("page") page: string,
    @Query("limit") limit: string
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.recurringRequestsService.findBookingsForRequest(
      id,
      pageNum,
      limitNum,
      req.user.id,
      req.user.role,
    );
  }
}

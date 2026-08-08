import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { AttendanceService } from "./attendance.service";
import { AttendanceRollupService } from "./attendance-rollup.service";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "../auth/dto/signup.dto";
import { istDateOnly } from "./attendance.service";
import {
  WaiveEventDto,
  OverrideDayDto,
  AttendanceEventsQueryDto,
} from "./dto/attendance.dto";
import { SCORE_WINDOW_DAYS, BAND_THRESHOLDS } from "./attendance.constants";

@ApiTags("Attendance")
@ApiBearerAuth()
@Controller("attendance")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly rollup: AttendanceRollupService,
  ) {}

  // ─── Caregiver's own record ───────────────────────────────────────────────

  @Get("me/summary")
  @ApiOperation({ summary: "Attendance score and breakdown for the current caregiver" })
  @ApiQuery({ name: "days", required: false, description: `Rolling window, default ${SCORE_WINDOW_DAYS}` })
  @ApiResponse({ status: 200, description: "Score, band, session counts, punctuality and day tallies" })
  async mySummary(@Request() req, @Query("days") days?: string) {
    const windowDays = days ? Math.min(Math.max(Number(days), 7), 365) : SCORE_WINDOW_DAYS;
    return this.attendance.getSummary(req.user.id, windowDays);
  }

  @Get("me/calendar")
  @ApiOperation({ summary: "Day-by-day attendance for one month (YYYY-MM), for the calendar view" })
  async myCalendar(@Request() req, @Query("month") month?: string) {
    return this.attendance.getCalendar(
      req.user.id,
      month ?? new Date().toISOString().slice(0, 7),
    );
  }

  @Get("me/events")
  @ApiOperation({
    summary: "The caregiver's own attendance timeline",
    description:
      "Includes events an admin has excused, flagged as such. A score a caregiver cannot audit is one she has no way to dispute.",
  })
  async myEvents(@Request() req, @Query() query: AttendanceEventsQueryDto) {
    return this.attendance.getEvents(req.user.id, {
      limit: query.limit,
      before: query.before ? new Date(query.before) : undefined,
    });
  }

  // ─── Admin ────────────────────────────────────────────────────────────────

  @Get("overview")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Roster view for one IST day — who was expected, who turned up" })
  @ApiQuery({ name: "date", required: false, description: "YYYY-MM-DD, defaults to today (IST)" })
  async overview(@Query("date") date?: string) {
    return this.attendance.getDailyOverview(
      date ?? istDateOnly().toISOString().slice(0, 10),
    );
  }

  @Get("at-risk")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Caregivers whose attendance score has fallen into the at-risk band" })
  async atRisk(@Query("threshold") threshold?: string) {
    return this.attendance.getAtRiskNannies(
      threshold ? Number(threshold) : BAND_THRESHOLDS.NEEDS_IMPROVEMENT,
    );
  }

  @Get("nanny/:nannyId/summary")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Attendance summary for one caregiver" })
  async nannySummary(
    @Param("nannyId", ParseUUIDPipe) nannyId: string,
    @Query("days") days?: string,
  ) {
    const windowDays = days ? Math.min(Math.max(Number(days), 7), 365) : SCORE_WINDOW_DAYS;
    return this.attendance.getSummary(nannyId, windowDays);
  }

  @Get("nanny/:nannyId/calendar")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Attendance calendar for one caregiver" })
  async nannyCalendar(
    @Param("nannyId", ParseUUIDPipe) nannyId: string,
    @Query("month") month?: string,
  ) {
    return this.attendance.getCalendar(
      nannyId,
      month ?? new Date().toISOString().slice(0, 7),
    );
  }

  @Get("nanny/:nannyId/events")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Attendance timeline for one caregiver" })
  async nannyEvents(
    @Param("nannyId", ParseUUIDPipe) nannyId: string,
    @Query() query: AttendanceEventsQueryDto,
  ) {
    return this.attendance.getEvents(nannyId, {
      limit: query.limit,
      before: query.before ? new Date(query.before) : undefined,
    });
  }

  @Post("events/:eventId/waive")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Excuse an attendance event",
    description:
      "The event stays on the timeline marked as excused and stops counting towards the score. Nothing is deleted — a dispute usually turns on the sequence of what the system believed and when.",
  })
  async waive(
    @Param("eventId", ParseUUIDPipe) eventId: string,
    @Body() dto: WaiveEventDto,
    @Request() req,
  ) {
    return this.attendance.waiveEvent(eventId, req.user.id, dto.reason);
  }

  @Post("nanny/:nannyId/day/:date/override")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Correct a day's attendance status by hand",
    description:
      "Stored alongside the derived status, never over it, so the nightly recompute cannot silently reverse the decision.",
  })
  async override(
    @Param("nannyId", ParseUUIDPipe) nannyId: string,
    @Param("date") date: string,
    @Body() dto: OverrideDayDto,
    @Request() req,
  ) {
    return this.attendance.overrideDay(nannyId, date, dto.status, req.user.id, dto.reason);
  }

  @Post("recompute")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Re-run the roll-up for one day and refresh scores",
    description:
      "For use after a correction. The roll-up derives from bookings and events and upserts, so re-running any past day is safe and produces what the original pass would have.",
  })
  async recompute(@Query("date") date?: string) {
    const target = date ? new Date(`${date}T00:00:00.000Z`) : istDateOnly();
    const days = await this.rollup.rollUpDay(target);
    const scored = await this.rollup.refreshAllScores();
    return { date: target.toISOString().slice(0, 10), dayRecords: days, scoresRefreshed: scored };
  }
}

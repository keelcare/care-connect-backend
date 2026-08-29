import {
  BadRequestException,
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

  /**
   * `Number("abc")` is NaN, and NaN survives Math.min/Math.max — it used to flow
   * straight into `new Date(NaN)` and surface as a Prisma 500 instead of a 400.
   */
  private parseWindow(days?: string): number {
    if (days === undefined) return SCORE_WINDOW_DAYS;
    const n = Number(days);
    if (!Number.isFinite(n)) {
      throw new BadRequestException("days must be a number");
    }
    return Math.min(Math.max(n, 7), 365);
  }

  /** ISO cursor validated here for the same reason — an invalid Date is a 500 in Prisma. */
  private parseBefore(before?: string): Date | undefined {
    if (!before) return undefined;
    const d = new Date(before);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException("before must be an ISO timestamp");
    }
    return d;
  }

  // ─── Caregiver's own record ───────────────────────────────────────────────

  @Get("me/summary")
  @ApiOperation({ summary: "Attendance score and breakdown for the current caregiver" })
  @ApiQuery({ name: "days", required: false, description: `Rolling window, default ${SCORE_WINDOW_DAYS}` })
  @ApiResponse({ status: 200, description: "Score, band, session counts, punctuality and day tallies" })
  async mySummary(@Request() req, @Query("days") days?: string) {
    return this.attendance.getSummary(req.user.id, this.parseWindow(days));
  }

  @Get("me/calendar")
  @ApiOperation({ summary: "Day-by-day attendance for one month (YYYY-MM), for the calendar view" })
  async myCalendar(@Request() req, @Query("month") month?: string) {
    // Default month derived from the IST calendar, not UTC — between midnight
    // and 05:30 IST on the 1st, UTC is still in last month, and the app opened
    // then showed the previous month's calendar with today missing from it.
    return this.attendance.getCalendar(
      req.user.id,
      month ?? istDateOnly().toISOString().slice(0, 7),
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
      before: this.parseBefore(query.before),
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
    const parsed = threshold === undefined ? BAND_THRESHOLDS.NEEDS_IMPROVEMENT : Number(threshold);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException("threshold must be a number");
    }
    return this.attendance.getAtRiskNannies(parsed);
  }

  @Get("nanny/:nannyId/summary")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Attendance summary for one caregiver" })
  async nannySummary(
    @Param("nannyId", ParseUUIDPipe) nannyId: string,
    @Query("days") days?: string,
  ) {
    return this.attendance.getSummary(nannyId, this.parseWindow(days));
  }

  @Get("nanny/:nannyId/calendar")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Attendance calendar for one caregiver" })
  async nannyCalendar(
    @Param("nannyId", ParseUUIDPipe) nannyId: string,
    @Query("month") month?: string,
  ) {
    // Same IST-not-UTC defaulting as the caregiver's own calendar above.
    return this.attendance.getCalendar(
      nannyId,
      month ?? istDateOnly().toISOString().slice(0, 7),
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
      before: this.parseBefore(query.before),
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
    const waived = await this.attendance.waiveEvent(eventId, req.user.id, dto.reason);
    // The score refresh inside `waiveEvent` covers the number, but the day
    // record is only rebuilt by the hourly/nightly crons — which never revisit
    // past dates. Without this, waiving last week's NO_SHOW cleared the score
    // yet left that day reading ABSENT on the roster and calendar forever.
    // The roll-up is idempotent, so re-running it here for an already-waived
    // event is harmless.
    await this.rollup.rollUpDay(waived.attendance_date);
    return waived;
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
    // Validated like the other date params — an arbitrary string became
    // `new Date("…T00:00:00.000Z")` = Invalid Date, which Prisma turns into a 500.
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException("date must be in YYYY-MM-DD format");
    }
    const target = date ? new Date(`${date}T00:00:00.000Z`) : istDateOnly();
    const days = await this.rollup.rollUpDay(target);
    const scored = await this.rollup.refreshAllScores();
    return { date: target.toISOString().slice(0, 10), dayRecords: days, scoresRefreshed: scored };
  }
}

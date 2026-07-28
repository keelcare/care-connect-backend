import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Request,
} from "@nestjs/common";
import { ProgressReportsService } from "./progress-reports.service";
import { TransparentJwtAuthGuard } from "../auth/guards/transparent-jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";

import { CreateTemplateDto } from "./dto/create-template.dto";
import { SubmitReportDto } from "./dto/submit-report.dto";
import { UserRole } from "../auth/dto/signup.dto";

@ApiTags("Progress Reports")
@ApiBearerAuth()
@Controller("progress-reports")
@UseGuards(TransparentJwtAuthGuard, RolesGuard)
export class ProgressReportsController {
  constructor(private readonly progressReportsService: ProgressReportsService) {}

  @Post("templates")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Create a new progress report template (Admin only)" })
  async createTemplate(@Body() dto: CreateTemplateDto, @Request() req) {
    return this.progressReportsService.createTemplate(dto, req.user.id);
  }

  @Get("templates")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Get all active report templates (Admin only)" })
  async getTemplates() {
    return this.progressReportsService.getTemplates();
  }

  @Get("nanny/pending")
  @Roles(UserRole.NANNY)
  @ApiOperation({ summary: "Get pending progress reports for nanny" })
  async getPendingReportsForNanny(@Request() req) {
    return this.progressReportsService.getReportsForNanny(req.user.id, "PENDING");
  }

  @Post(":id/submit")
  @Roles(UserRole.NANNY)
  @ApiOperation({ summary: "Submit a progress report (Nanny only)" })
  async submitReport(
    @Param("id") id: string,
    @Body() dto: SubmitReportDto,
    @Request() req,
  ) {
    return this.progressReportsService.submitReport(id, req.user.id, dto);
  }

  @Get("parent")
  @Roles(UserRole.PARENT)
  @ApiOperation({ summary: "Get all submitted progress reports for parent" })
  async getReportsForParent(@Request() req) {
    return this.progressReportsService.getReportsForParent(req.user.id);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a specific progress report by ID" })
  async getReportById(@Param("id") id: string, @Request() req) {
    return this.progressReportsService.getReportById(
      id,
      req.user.id,
      req.user.role,
    );
  }
}

import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  NotFoundException,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { WhatsAppEnquiryStatus } from "@prisma/client";
import { AuthGuard } from "@nestjs/passport";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsAppMessagingService } from "./whatsapp-messaging.service";
import { AgentReplyDto, UpdateEnquiryDto } from "./dto/whatsapp.dto";
import { AdminGuard } from "../admin/admin.guard";

@ApiTags("Admin – WhatsApp Enquiries")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"), AdminGuard)
@Controller("admin/whatsapp/enquiries")
export class AdminWhatsAppController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: WhatsAppMessagingService,
  ) {}

  /**
   * GET /admin/whatsapp/enquiries
   * List enquiries with optional filters + pagination
   */
  @Get()
  @ApiOperation({ summary: "List all WhatsApp enquiries" })
  @ApiQuery({ name: "status", required: false, enum: WhatsAppEnquiryStatus })
  @ApiQuery({ name: "assigned_to", required: false, type: String })
  @ApiQuery({
    name: "search",
    required: false,
    type: String,
    description: "Name, phone or email",
  })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  async listEnquiries(
    @Query("status") status?: WhatsAppEnquiryStatus,
    @Query("assigned_to") assignedTo?: string,
    @Query("search") search?: string,
    @Query("page") page = "1",
    @Query("limit") limit = "20",
  ) {
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (status) where.status = status;
    if (assignedTo) where.assigned_to = assignedTo;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone_number: { contains: search } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.whatsapp_enquiries.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { created_at: "desc" },
        include: {
          assigned_user: { select: { id: true, email: true } },
        },
      }),
      this.prisma.whatsapp_enquiries.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    };
  }

  /**
   * GET /admin/whatsapp/enquiries/:id
   * Get enquiry details + full WhatsApp message history
   */
  @Get(":id")
  @ApiOperation({ summary: "Get enquiry details with message history" })
  async getEnquiry(@Param("id", ParseUUIDPipe) id: string) {
    const enquiry = await this.prisma.whatsapp_enquiries.findUnique({
      where: { id },
      include: { assigned_user: { select: { id: true, email: true } } },
    });
    if (!enquiry) throw new NotFoundException("Enquiry not found");

    const messages = await this.prisma.whatsapp_messages.findMany({
      where: { phone_number: enquiry.phone_number },
      orderBy: { created_at: "asc" },
      select: {
        id: true,
        direction: true,
        message_body: true,
        created_at: true,
      },
    });

    return { enquiry, messages };
  }

  /**
   * POST /admin/whatsapp/enquiries/:id/reply
   * Agent sends a WhatsApp reply to the customer
   */
  @Post(":id/reply")
  @ApiOperation({ summary: "Send a WhatsApp reply to the customer" })
  async replyToEnquiry(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AgentReplyDto,
  ) {
    const enquiry = await this.prisma.whatsapp_enquiries.findUnique({
      where: { id },
    });
    if (!enquiry) throw new NotFoundException("Enquiry not found");

    await this.messaging.sendTextMessage(enquiry.phone_number, dto.message);

    await this.prisma.whatsapp_messages.create({
      data: {
        phone_number: enquiry.phone_number,
        direction: "OUTBOUND",
        message_body: dto.message,
      },
    });

    if (enquiry.status === "NEW") {
      await this.prisma.whatsapp_enquiries.update({
        where: { id },
        data: { status: "CONTACTED" },
      });
    }

    return { success: true };
  }

  /**
   * PATCH /admin/whatsapp/enquiries/:id
   * Update status, assign agent, or add internal notes
   */
  @Patch(":id")
  @ApiOperation({ summary: "Update enquiry status, assigned agent, or notes" })
  async updateEnquiry(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateEnquiryDto,
  ) {
    const enquiry = await this.prisma.whatsapp_enquiries.findUnique({
      where: { id },
    });
    if (!enquiry) throw new NotFoundException("Enquiry not found");

    return this.prisma.whatsapp_enquiries.update({
      where: { id },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.assigned_to !== undefined && { assigned_to: dto.assigned_to }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });
  }
}

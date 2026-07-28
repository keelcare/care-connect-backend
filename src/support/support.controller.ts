import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Request,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { SupportService } from "./support.service";
import { CreateTicketDto } from "./dto/create-ticket.dto";
import { UpdateTicketDto } from "./dto/update-ticket.dto";
import { CreateTicketMessageDto } from "./dto/create-ticket-message.dto";
import { SubmitCsatDto } from "./dto/submit-csat.dto";
import { AssignTicketDto } from "./dto/assign-ticket.dto";
import { AuthGuard } from "@nestjs/passport";
import { UserRole } from "../auth/dto/signup.dto";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import {
  ActiveUserGuard,
  SkipActiveCheck,
} from "../common/guards/active-user.guard";

@ApiTags("Support")
@ApiBearerAuth()
@Controller("support")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post("tickets")
  @SkipActiveCheck() // Banned users need to submit support tickets to contest their ban
  @ApiOperation({ summary: "Create a new support ticket" })
  @ApiResponse({ status: 201, description: "Ticket created successfully" })
  async createTicket(@Request() req, @Body() createTicketDto: CreateTicketDto) {
    return this.supportService.createTicket(
      req.user.id,
      req.user.role,
      createTicketDto,
    );
  }

  @Get("tickets")
  @SkipActiveCheck() // Banned users need to view their submitted tickets
  @ApiOperation({ summary: "Get all tickets for the current user" })
  @ApiResponse({ status: 200, description: "Return user tickets" })
  async getUserTickets(@Request() req) {
    return this.supportService.getUserTickets(req.user.id);
  }

  @Get("tickets/:id")
  @SkipActiveCheck() // Banned users need to view their ticket status
  @ApiOperation({ summary: "Get ticket details" })
  @ApiResponse({ status: 200, description: "Return ticket details" })
  @ApiResponse({ status: 404, description: "Ticket not found" })
  async getTicket(@Request() req, @Param("id") id: string) {
    const isAdmin = req.user.role === "admin";
    return this.supportService.getTicketById(id, req.user.id, isAdmin);
  }

  // ── Per-ticket conversation (raiser ↔ admin) ──
  @Get("tickets/:id/messages")
  @SkipActiveCheck()
  @ApiOperation({ summary: "Get the conversation for a ticket" })
  async getTicketMessages(@Request() req, @Param("id") id: string) {
    const isAdmin = req.user.role === "admin";
    return this.supportService.getMessages(id, req.user.id, isAdmin);
  }

  @Post("tickets/:id/messages")
  @SkipActiveCheck()
  @ApiOperation({ summary: "Post a message to a ticket conversation" })
  async addTicketMessage(
    @Request() req,
    @Param("id") id: string,
    @Body() dto: CreateTicketMessageDto,
  ) {
    const isAdmin = req.user.role === "admin";
    return this.supportService.addMessage(id, req.user.id, isAdmin, dto.content);
  }

  @Post("tickets/:id/csat")
  @ApiOperation({ summary: "Rate a resolved ticket (customer satisfaction)" })
  async submitCsat(
    @Request() req,
    @Param("id") id: string,
    @Body() dto: SubmitCsatDto,
  ) {
    return this.supportService.submitCsat(id, req.user.id, dto.rating, dto.comment);
  }

  // Admin Endpoints
  @Post("admin/tickets/:id/assign")
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: "Claim or reassign a ticket (Admin only)" })
  async assignTicket(
    @Request() req,
    @Param("id") id: string,
    @Body() dto: AssignTicketDto,
  ) {
    // Omitted adminId = claim for the current admin; explicit null = release.
    const adminId = dto.adminId === undefined ? req.user.id : dto.adminId;
    return this.supportService.assignTicket(id, adminId);
  }

  @Get("admin/tickets/:id")
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: "Get a single ticket with booking + thread (Admin)" })
  async adminGetTicket(@Param("id") id: string) {
    return this.supportService.adminGetTicketById(id);
  }

  @Get("admin/tickets")
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: "Get all support tickets (Admin only)" })
  @ApiResponse({ status: 200, description: "Return all tickets" })
  async getAllTickets() {
    return this.supportService.getAllTickets();
  }

  @Patch("admin/tickets/:id")
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: "Update ticket status/priority/notes (Admin only)" })
  @ApiResponse({ status: 200, description: "Ticket updated successfully" })
  async updateTicket(
    @Param("id") id: string,
    @Body() updateTicketDto: UpdateTicketDto,
  ) {
    return this.supportService.updateTicket(id, updateTicketDto);
  }
}

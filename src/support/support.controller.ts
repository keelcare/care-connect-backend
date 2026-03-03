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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SupportService } from "./support.service";
import { CreateTicketDto } from "./dto/create-ticket.dto";
import { UpdateTicketDto } from "./dto/update-ticket.dto";
import { AuthGuard } from "@nestjs/passport";
import { AdminGuard } from "../admin/admin.guard";

@ApiTags('Support')
@ApiBearerAuth()
@Controller("support")
@UseGuards(AuthGuard("jwt"))
export class SupportController {
    constructor(private readonly supportService: SupportService) { }

    @Post("tickets")
    @ApiOperation({ summary: 'Create a new support ticket' })
    @ApiResponse({ status: 201, description: 'Ticket created successfully' })
    async createTicket(@Request() req, @Body() createTicketDto: CreateTicketDto) {
        return this.supportService.createTicket(req.user.id, req.user.role, createTicketDto);
    }

    @Get("tickets")
    @ApiOperation({ summary: 'Get all tickets for the current user' })
    @ApiResponse({ status: 200, description: 'Return user tickets' })
    async getUserTickets(@Request() req) {
        return this.supportService.getUserTickets(req.user.id);
    }

    @Get("tickets/:id")
    @ApiOperation({ summary: 'Get ticket details' })
    @ApiResponse({ status: 200, description: 'Return ticket details' })
    @ApiResponse({ status: 404, description: 'Ticket not found' })
    async getTicket(@Request() req, @Param("id") id: string) {
        const isAdmin = req.user.role === 'admin';
        return this.supportService.getTicketById(id, req.user.id, isAdmin);
    }

    // Admin Endpoints
    @Get("admin/tickets")
    @UseGuards(AdminGuard)
    @ApiOperation({ summary: 'Get all support tickets (Admin only)' })
    @ApiResponse({ status: 200, description: 'Return all tickets' })
    async getAllTickets() {
        return this.supportService.getAllTickets();
    }

    @Patch("admin/tickets/:id")
    @UseGuards(AdminGuard)
    @ApiOperation({ summary: 'Update ticket status/priority/notes (Admin only)' })
    @ApiResponse({ status: 200, description: 'Ticket updated successfully' })
    async updateTicket(@Param("id") id: string, @Body() updateTicketDto: UpdateTicketDto) {
        return this.supportService.updateTicket(id, updateTicketDto);
    }
}

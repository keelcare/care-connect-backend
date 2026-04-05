import { Controller, Post, Get, Body, UseGuards, Request, Delete, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { NanniesService } from './nannies.service';
import { CreateCategoryRequestDto } from './dto/create-category-request.dto';
import { AuthGuard } from '@nestjs/passport';
import { ActiveUserGuard } from '../common/guards/active-user.guard';

@ApiTags('Nannies')
@ApiBearerAuth()
@Controller('nannies')
export class NanniesController {
    constructor(private readonly nanniesService: NanniesService) { }

    @UseGuards(AuthGuard('jwt'), ActiveUserGuard)
    @Post('me/category-request')
    @ApiOperation({ summary: 'Submit a new category upgrade request' })
    @ApiResponse({ status: 201, description: 'Request submitted successfully' })
    async createCategoryRequest(@Request() req, @Body() dto: CreateCategoryRequestDto) {
        return this.nanniesService.createCategoryRequest(req.user.id, dto);
    }

    @UseGuards(AuthGuard('jwt'), ActiveUserGuard)
    @Get('me/category-request')
    @ApiOperation({ summary: 'Get current pending category upgrade request' })
    @ApiResponse({ status: 200, description: 'Return pending request if any' })
    async getMyCategoryRequest(@Request() req) {
        return this.nanniesService.getMyCategoryRequest(req.user.id);
    }

    @UseGuards(AuthGuard('jwt'), ActiveUserGuard)
    @Get('me/category-requests/history')
    @ApiOperation({ summary: 'Get history of category upgrade requests' })
    @ApiResponse({ status: 200, description: 'Return list of historical requests' })
    async getMyCategoryRequestsHistory(@Request() req) {
        return this.nanniesService.getMyCategoryRequestsHistory(req.user.id);
    }

    @UseGuards(AuthGuard('jwt'), ActiveUserGuard)
    @Delete('me/category-request/:id')
    @ApiOperation({ summary: 'Cancel a pending category upgrade request' })
    @ApiResponse({ status: 200, description: 'Request cancelled successfully' })
    async cancelCategoryRequest(@Request() req, @Param('id') id: string) {
        return this.nanniesService.cancelCategoryRequest(req.user.id, id);
    }
}

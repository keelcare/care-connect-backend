import { Controller, Post, Get, Body, UseGuards, Request, Delete, Param } from '@nestjs/common';
import { NanniesService } from './nannies.service';
import { CreateCategoryRequestDto } from './dto/create-category-request.dto';
import { AuthGuard } from '@nestjs/passport';

@Controller('nannies')
export class NanniesController {
    constructor(private readonly nanniesService: NanniesService) { }

    @UseGuards(AuthGuard('jwt'))
    @Post('me/category-request')
    async createCategoryRequest(@Request() req, @Body() dto: CreateCategoryRequestDto) {
        return this.nanniesService.createCategoryRequest(req.user.id, dto);
    }

    @UseGuards(AuthGuard('jwt'))
    @Get('me/category-request')
    async getMyCategoryRequest(@Request() req) {
        return this.nanniesService.getMyCategoryRequest(req.user.id);
    }

    @UseGuards(AuthGuard('jwt'))
    @Get('me/category-requests/history')
    async getMyCategoryRequestsHistory(@Request() req) {
        return this.nanniesService.getMyCategoryRequestsHistory(req.user.id);
    }

    @UseGuards(AuthGuard('jwt'))
    @Delete('me/category-request/:id')
    async cancelCategoryRequest(@Request() req, @Param('id') id: string) {
        return this.nanniesService.cancelCategoryRequest(req.user.id, id);
    }
}

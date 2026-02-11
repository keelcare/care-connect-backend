import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
  Param,
  Put,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { RequestsService } from "./requests.service";
import { CreateRequestDto } from "./dto/create-request.dto";
import { AuthGuard } from "@nestjs/passport";

@Controller("requests")
@UseGuards(AuthGuard("jwt"))
export class RequestsController {
  constructor(private readonly requestsService: RequestsService) { }

  @Post()
  create(@Request() req, @Body() createRequestDto: CreateRequestDto) {
    return this.requestsService.create(req.user.id, createRequestDto);
  }



  @Get("parent/me")
  findAllMyRequests(@Request() req) {
    return this.requestsService.findAllByParent(req.user.id);
  }

  @Put(":id/cancel")
  async cancelRequest(@Param("id") id: string, @Request() req) {
    const request = await this.requestsService.findOne(id);
    if (!request) throw new NotFoundException("Request not found");
    if (request.parent_id !== req.user.id) {
      throw new ForbiddenException("You are not authorized to cancel this request");
    }
    return this.requestsService.cancelRequest(id);
  }

  @Get(":id/matches")
  async getMatches(@Param("id") id: string) {
    // This would reuse the matching logic but return list instead of assigning
    // For now, just a placeholder or reuse triggerMatching logic without saving
    return { message: "Not implemented yet" };
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.requestsService.findOne(id);
  }
}

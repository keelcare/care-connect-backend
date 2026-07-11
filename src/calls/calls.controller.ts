import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { CallsService } from "./calls.service";

@ApiTags("calls")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
@Controller("calls")
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Get("ice-servers")
  @ApiOperation({ summary: "ICE server list (STUN + TURN) for WebRTC calls" })
  @ApiResponse({ status: 200, description: "RTCIceServer[] usable as-is in RTCPeerConnection" })
  async getIceServers() {
    return this.callsService.getIceServers();
  }
}

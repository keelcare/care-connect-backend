import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseGuards,
  Request,
} from "@nestjs/common";
import { FavoritesService } from "./favorites.service";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";

@Controller("favorites")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get()
  async getFavorites(@Request() req) {
    return this.favoritesService.getFavorites(req.user.id);
  }

  @Post(":nannyId")
  async addFavorite(@Param("nannyId") nannyId: string, @Request() req) {
    return this.favoritesService.addFavorite(req.user.id, nannyId);
  }

  @Delete(":nannyId")
  async removeFavorite(@Param("nannyId") nannyId: string, @Request() req) {
    return this.favoritesService.removeFavorite(req.user.id, nannyId);
  }
}

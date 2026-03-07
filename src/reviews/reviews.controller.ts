import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from "@nestjs/common";
import { ReviewsService } from "./reviews.service";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { CreateReviewDto } from "./dto/create-review.dto";
import { UpdateReviewDto } from "./dto/update-review.dto";

@Controller("reviews")
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  async createReview(@Body() createReviewDto: CreateReviewDto, @Request() req) {
    return this.reviewsService.createReview(createReviewDto, req.user.id);
  }

  @Patch(":id")
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  async updateReview(
    @Param("id") id: string,
    @Body() updateReviewDto: UpdateReviewDto,
    @Request() req,
  ) {
    return this.reviewsService.updateReview(id, updateReviewDto, req.user.id);
  }

  @Delete(":id")
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  async deleteReview(@Param("id") id: string, @Request() req) {
    return this.reviewsService.deleteReview(id, req.user.id);
  }

  @Get("user/:userId")
  async getUserReviews(@Param("userId") userId: string) {
    return this.reviewsService.getReviewsForUser(userId);
  }

  @Get("nanny/:nannyId")
  async getNannyReviews(@Param("nannyId") nannyId: string) {
    return this.reviewsService.getReviewsForNanny(nannyId);
  }

  @Get("parent/:parentId")
  async getParentReviews(@Param("parentId") parentId: string) {
    return this.reviewsService.getReviewsForParent(parentId);
  }

  @Get("booking/:bookingId")
  async getBookingReviews(@Param("bookingId") bookingId: string) {
    return this.reviewsService.getReviewForBooking(bookingId);
  }

  @Get("booking/:bookingId/can-review")
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  async canReviewBooking(
    @Param("bookingId") bookingId: string,
    @Request() req,
  ) {
    return this.reviewsService.canUserReviewBooking(bookingId, req.user.id);
  }

  @Get("written-by/:userId")
  async getWrittenReviews(@Param("userId") userId: string) {
    return this.reviewsService.getReviewsWrittenByUser(userId);
  }
}

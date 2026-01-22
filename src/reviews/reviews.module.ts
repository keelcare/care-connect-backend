import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { ReviewsService } from "./reviews.service";
import { ReviewsController } from "./reviews.controller";

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule { }

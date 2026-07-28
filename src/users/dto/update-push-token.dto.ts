import { IsString, IsNotEmpty, IsOptional, IsIn } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UpdatePushTokenDto {
  @ApiProperty({
    description: "FCM device token for push notifications",
    example: "eXamPLeTokEn123...",
  })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiPropertyOptional({
    description:
      "Device platform — routes delivery: iOS registers a raw APNs token, Android an FCM token",
    enum: ["ios", "android"],
  })
  @IsOptional()
  @IsIn(["ios", "android"])
  platform?: "ios" | "android";
}

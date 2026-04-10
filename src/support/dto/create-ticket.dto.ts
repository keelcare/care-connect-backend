import { IsNotEmpty, IsString, IsOptional, IsEnum } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CreateTicketDto {
  @ApiProperty({ example: "Issue with booking payment" })
  @IsNotEmpty()
  @IsString()
  subject: string;

  @ApiProperty({ example: "I was charged twice for my last booking." })
  @IsNotEmpty()
  @IsString()
  description: string;

  @ApiProperty({
    example: "payment",
    description:
      "Category of the issue e.g. payment, technical, grievance, etc.",
  })
  @IsNotEmpty()
  @IsString()
  category: string;

  @ApiProperty({
    example: "medium",
    enum: ["low", "medium", "high", "critical"],
    required: false,
  })
  @IsOptional()
  @IsEnum(["low", "medium", "high", "critical"])
  priority?: string;
}

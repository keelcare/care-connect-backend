import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CreateTicketMessageDto {
  @ApiProperty({ example: "The nanny hasn't arrived yet." })
  @IsNotEmpty()
  @IsString()
  @MaxLength(5000)
  content: string;
}

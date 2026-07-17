import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SubmitCsatDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({ example: "Quick and helpful, thanks!", required: false })
  @IsOptional()
  @IsString()
  comment?: string;
}

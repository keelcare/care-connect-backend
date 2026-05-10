import { IsString, IsNotEmpty, IsArray, ValidateNested, IsOptional, IsInt, IsUUID } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class AnswerDto {
  @ApiProperty()
  @IsUUID()
  question_id: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  answer_text?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  answer_rating?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  answer_choices?: string[];
}

export class SubmitReportDto {
  @ApiProperty({ type: [AnswerDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers: AnswerDto[];

  @ApiPropertyOptional({ description: "Optional personal remark from nanny" })
  @IsOptional()
  @IsString()
  personal_remark?: string;
}

import {
  IsString,
  IsNotEmpty,
  IsArray,
  ValidateNested,
  IsOptional,
  IsInt,
  IsUUID,
  Min,
  Max,
  ArrayMinSize,
} from "class-validator";
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
  @Min(1)
  @Max(5)
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
  @ArrayMinSize(1, { message: "Answers cannot be empty" })
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers: AnswerDto[];

  @ApiPropertyOptional({ description: "Optional personal remark from nanny" })
  @IsOptional()
  @IsString()
  personal_remark?: string;
}

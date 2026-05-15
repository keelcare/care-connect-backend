import { IsString, IsNotEmpty, IsArray, ValidateNested, IsBoolean, IsInt, IsEnum, IsOptional } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { report_input_type } from "@prisma/client";

export class QuestionDto {
  @ApiProperty({ description: "The text of the question" })
  @IsString()
  @IsNotEmpty()
  question_text: string;

  @ApiProperty({ enum: report_input_type, description: "Type of input expected" })
  @IsEnum(report_input_type)
  input_type: report_input_type;

  @ApiPropertyOptional({ description: "Options for MULTI_CHOICE questions" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @ApiProperty()
  @IsInt()
  display_order: number;
}

export class CreateTemplateDto {
  @ApiProperty({ type: [QuestionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuestionDto)
  questions: QuestionDto[];
}

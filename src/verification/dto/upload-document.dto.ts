import {
  IsNotEmpty,
  IsString,
  IsOptional,
  MaxLength,
  Matches,
  MinLength,
} from "class-validator";

export class UploadDocumentDto {
  @IsNotEmpty()
  @IsString()
  idType: string;

  @IsNotEmpty()
  @IsString()
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  idNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^[6-9]\d{9}$/, {
    message: "Phone number must be a valid Indian mobile number",
  })
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  address?: string;
}

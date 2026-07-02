import {
  IsNotEmpty,
  IsString,
  IsOptional,
  MaxLength,
  Matches,
  MinLength,
  ValidateIf,
} from "class-validator";

// Non-identity document types don't have an associated ID number
const NON_IDENTITY_DOC_TYPES = ["RESUME"];

export class UploadDocumentDto {
  @IsNotEmpty()
  @IsString()
  idType: string;

  @ValidateIf((o) => !NON_IDENTITY_DOC_TYPES.includes(o.idType))
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  idNumber?: string;

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

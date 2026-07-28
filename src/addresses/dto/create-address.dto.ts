import { IsBoolean, IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { Sanitize } from "../../common/decorators/sanitize.decorator";

export class CreateAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Sanitize()
  label?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  @Sanitize()
  address: string;

  @IsNotEmpty()
  @IsLatitude()
  lat: number;

  @IsNotEmpty()
  @IsLongitude()
  lng: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

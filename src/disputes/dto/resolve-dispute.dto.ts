import { IsString, IsNotEmpty } from 'class-validator';

export class ResolveDisputeDto {
  @IsString()
  @IsNotEmpty()
  resolution: string;
}

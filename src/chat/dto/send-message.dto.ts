import { IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class SendMessageDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(5000)
  content: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  attachmentUrl?: string;
}

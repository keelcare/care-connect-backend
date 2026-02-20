import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdatePushTokenDto {
  @ApiProperty({ description: 'FCM device token for push notifications', example: 'eXamPLeTokEn123...' })
  @IsString()
  @IsNotEmpty()
  token: string;
}

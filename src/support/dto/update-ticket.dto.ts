import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateTicketDto {
    @ApiProperty({ example: 'in_progress', enum: ['open', 'in_progress', 'resolved', 'closed'], required: false })
    @IsOptional()
    @IsEnum(['open', 'in_progress', 'resolved', 'closed'])
    status?: string;

    @ApiProperty({ example: 'high', enum: ['low', 'medium', 'high', 'critical'], required: false })
    @IsOptional()
    @IsEnum(['low', 'medium', 'high', 'critical'])
    priority?: string;

    @ApiProperty({ example: 'Investigating the double charge issue.', required: false })
    @IsOptional()
    @IsString()
    admin_notes?: string;
}

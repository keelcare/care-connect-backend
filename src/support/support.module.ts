import { Module } from '@nestjs/common';
import { SupportService } from './support.service';
import { SupportController } from './support.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminModule } from '../admin/admin.module';

@Module({
    imports: [PrismaModule, AdminModule],
    providers: [SupportService],
    controllers: [SupportController],
    exports: [SupportService],
})
export class SupportModule { }

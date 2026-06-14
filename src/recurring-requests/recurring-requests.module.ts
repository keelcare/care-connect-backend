import { Module } from '@nestjs/common';
import { RecurringRequestsController } from './recurring-requests.controller';
import { RecurringRequestsService } from './recurring-requests.service';
import { RecurringRequestsCron } from './recurring-requests.cron';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [RecurringRequestsController],
  providers: [RecurringRequestsService, RecurringRequestsCron]
})
export class RecurringRequestsModule { }

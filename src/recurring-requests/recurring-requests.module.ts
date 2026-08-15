import { Module } from '@nestjs/common';
import { RecurringRequestsController } from './recurring-requests.controller';
import { RecurringRequestsService } from './recurring-requests.service';
import { RecurringRequestsCron } from './recurring-requests.cron';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AddressesModule } from '../addresses/addresses.module';
import { CommonModule } from '../common/common.module';
import { PaymentsModule } from '../payments/payments.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    NotificationsModule,
    AddressesModule,
    CommonModule,
    // The nightly cron opens each plan's next billing cycle before its month begins.
    PaymentsModule,
    // Cancelling a plan freezes a settlement statement — the record of which
    // sessions the family keeps and what stops being payable.
    InvoicesModule,
  ],
  controllers: [RecurringRequestsController],
  providers: [RecurringRequestsService, RecurringRequestsCron]
})
export class RecurringRequestsModule { }

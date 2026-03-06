import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';
import { WhatsAppBotService } from './whatsapp-bot.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { AdminWhatsAppController } from './admin-whatsapp.controller';

@Module({
    imports: [ConfigModule, PrismaModule],
    controllers: [WhatsAppWebhookController, AdminWhatsAppController],
    providers: [WhatsAppMessagingService, WhatsAppBotService],
    exports: [WhatsAppMessagingService],
})
export class WhatsAppModule { }

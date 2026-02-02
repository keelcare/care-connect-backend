import { Module, Global } from '@nestjs/common';
import { EncryptionService } from './services/encryption.service';
import { ConfigModule } from '@nestjs/config';

@Global()
@Module({
    imports: [ConfigModule],
    providers: [EncryptionService],
    exports: [EncryptionService],
})
export class CommonModule { }

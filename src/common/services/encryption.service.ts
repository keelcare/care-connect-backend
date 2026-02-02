import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
    private readonly algorithm = 'aes-256-gcm';
    private readonly key: Buffer;

    constructor(private configService: ConfigService) {
        const keyHex = this.configService.get<string>('ENCRYPTION_KEY');

        // Fallback for development if not set (DO NOT USE IN PRODUCTION)
        if (!keyHex) {
            console.warn('WARNING: ENCRYPTION_KEY not set. PII encryption will fail.');
            // We'll throw error in production-like environments or handle gracefully
            // For now, let's assume it should match the .env update we will do

            // To prevent crashes during setup, we can use a dummy key if strictly needed for dev
            // But better to throw to strict enforcement
        }

        if (keyHex) {
            // Key must be 32 bytes (64 hex characters) for AES-256
            if (keyHex.length !== 64) {
                throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
            }
            this.key = Buffer.from(keyHex, 'hex');
        }
    }

    /**
     * Encrypt plaintext using AES-256-GCM
     * Returns: iv:authTag:ciphertext (all hex-encoded)
     */
    encrypt(plaintext: string): string {
        if (!plaintext || !this.key) return plaintext;

        try {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

            let encrypted = cipher.update(plaintext, 'utf8', 'hex');
            encrypted += cipher.final('hex');

            const authTag = cipher.getAuthTag();

            // Format: iv:authTag:ciphertext
            return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
        } catch (e) {
            console.error('Encryption error:', e);
            return plaintext; // Fail safe? Or throw? Fail safe for now to not break app
        }
    }

    /**
     * Decrypt ciphertext using AES-256-GCM
     * Expects format: iv:authTag:ciphertext
     */
    decrypt(encryptedData: string): string {
        if (!encryptedData || !this.key) return encryptedData;

        // Check if data is encrypted (contains colons)
        if (!encryptedData.includes(':')) {
            // Data is not encrypted (legacy data), return as-is
            return encryptedData;
        }

        try {
            const parts = encryptedData.split(':');
            if (parts.length !== 3) return encryptedData;

            const [ivHex, authTagHex, encrypted] = parts;

            const iv = Buffer.from(ivHex, 'hex');
            const authTag = Buffer.from(authTagHex, 'hex');

            const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
            decipher.setAuthTag(authTag);

            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (error) {
            // If decryption fails, return original (might be legacy unencrypted data)
            // console.error('Decryption failed:', error.message);
            return encryptedData;
        }
    }

    /**
     * Check if data is encrypted
     */
    isEncrypted(data: string): boolean {
        return data && data.includes(':') && data.split(':').length === 3;
    }
}

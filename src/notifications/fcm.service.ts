import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private initialized = false;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.initializeFirebase();
  }

  private initializeFirebase() {
    try {
      const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID');
      const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
      let privateKey = this.configService.get<string>('FIREBASE_PRIVATE_KEY');

      // Handle multiline private keys from env vars properly
      if (privateKey) {
        privateKey = privateKey.replace(/\\n/g, '\n');
      }

      if (!projectId || !clientEmail || !privateKey) {
        this.logger.warn('Firebase Admin credentials missing. Push notifications will be disabled.');
        return;
      }

      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });

      this.initialized = true;
      this.logger.log('Firebase Admin initialized successfully.');
    } catch (error) {
      if (error.code === 'app/duplicate-app') {
        this.initialized = true;
        this.logger.log('Firebase Admin already initialized.');
      } else {
        this.logger.error('Failed to initialize Firebase Admin', error.stack);
      }
    }
  }

  async sendPushNotification(token: string, title: string, body: string, data?: Record<string, string>): Promise<boolean> {
    if (!this.initialized) {
        this.logger.debug('Skipping push notification: Firebase Admin is not initialized.');
        return false;
    }

    if (!token) {
        this.logger.debug('Skipping push notification: No FCM token provided.');
        return false;
    }

    try {
      const payload: admin.messaging.Message = {
        token,
        notification: {
          title,
          body,
        },
        data: data || {},
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                    badge: 1,
                }
            }
        },
        android: {
            notification: {
                sound: 'default',
            }
        }
      };

      const messageId = await admin.messaging().send(payload);
      this.logger.log(`Successfully sent push notification. Message ID: ${messageId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send push notification to token ${token}`, error.stack);
      return false;
    }
  }
}

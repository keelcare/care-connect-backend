import { Injectable } from "@nestjs/common";
import { FcmService, FcmSendOptions } from "./fcm.service";
import { ApnsService } from "./apns.service";

/** Raw APNs device tokens are 64 hex chars; FCM registration tokens contain ':'. */
const APNS_TOKEN_RE = /^[0-9a-f]{64,}$/i;

export interface PushSendOptions {
  highPriority?: boolean;
  ttlSeconds?: number;
  androidChannelId?: string;
}

/**
 * Routes a push to the right transport: Android tokens go through FCM,
 * iOS raw APNs tokens (which firebase-admin cannot send to) go direct to APNs.
 */
@Injectable()
export class PushService {
  constructor(
    private readonly fcmService: FcmService,
    private readonly apnsService: ApnsService,
  ) {}

  async send(
    token: string,
    platform: string | null | undefined,
    title: string,
    body: string,
    data?: Record<string, string>,
    opts?: PushSendOptions,
  ): Promise<boolean> {
    if (!token) return false;
    const isApns = platform === "ios" || (!platform && APNS_TOKEN_RE.test(token));
    if (isApns) {
      return this.apnsService.send(token, title, body, data, {
        highPriority: opts?.highPriority,
        ttlSeconds: opts?.ttlSeconds,
      });
    }
    const fcmOpts: FcmSendOptions = {};
    if (opts?.highPriority) {
      fcmOpts.android = {
        priority: "high",
        ...(opts.ttlSeconds ? { ttl: opts.ttlSeconds * 1000 } : {}),
        notification: {
          sound: "default",
          ...(opts.androidChannelId ? { channelId: opts.androidChannelId } : {}),
        },
      };
    } else if (opts?.androidChannelId) {
      fcmOpts.android = {
        notification: { sound: "default", channelId: opts.androidChannelId },
      };
    }
    return this.fcmService.sendPushNotification(token, title, body, data, fcmOpts);
  }
}

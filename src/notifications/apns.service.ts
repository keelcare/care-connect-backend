import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as http2 from "http2";

const TOKEN_TTL_MS = 45 * 60_000; // Apple allows 20–60 min; refresh comfortably early

export interface ApnsSendOptions {
  /** apns-priority 10 = immediate delivery (calls); default 5 */
  highPriority?: boolean;
  /** Drop the push if undeliverable within this window (e.g. ring timeout). */
  ttlSeconds?: number;
}

/**
 * Direct APNs sender over HTTP/2 with ES256 token auth.
 *
 * Needed because iOS devices register *raw APNs tokens*
 * (expo-notifications getDevicePushTokenAsync), which firebase-admin cannot
 * deliver to. Mirrors FcmService's config-gated graceful disablement.
 */
@Injectable()
export class ApnsService {
  private readonly logger = new Logger(ApnsService.name);
  private jwtCache: { token: string; expires: number } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  get enabled(): boolean {
    return !!(
      this.config.get<string>("APNS_KEY_ID") &&
      this.config.get<string>("APNS_TEAM_ID") &&
      this.config.get<string>("APNS_PRIVATE_KEY") &&
      this.config.get<string>("APNS_BUNDLE_ID")
    );
  }

  async send(
    deviceToken: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    opts?: ApnsSendOptions,
  ): Promise<boolean> {
    if (!this.enabled) {
      this.logger.debug("Skipping APNs push: credentials not configured.");
      return false;
    }
    const host =
      this.config.get<string>("APNS_PRODUCTION") === "false"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
    const payload = JSON.stringify({
      aps: { alert: { title, body }, sound: "default", badge: 1 },
      ...(data || {}),
    });
    const headers: Record<string, string | number> = {
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${this.getAuthToken()}`,
      "apns-topic": this.config.get<string>("APNS_BUNDLE_ID")!,
      "apns-push-type": "alert",
      "apns-priority": opts?.highPriority ? "10" : "5",
    };
    if (opts?.ttlSeconds) {
      headers["apns-expiration"] = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
    }

    return new Promise((resolve) => {
      const client = http2.connect(host);
      client.on("error", (err) => {
        this.logger.error(`APNs connection error: ${err.message}`);
        resolve(false);
      });
      const req = client.request(headers);
      let responseStatus = 0;
      let responseBody = "";
      req.on("response", (res) => {
        responseStatus = Number(res[":status"] ?? 0);
      });
      req.setEncoding("utf8");
      req.on("data", (chunk) => (responseBody += chunk));
      req.on("end", () => {
        client.close();
        if (responseStatus === 200) {
          resolve(true);
        } else {
          this.logger.error(`APNs push failed (HTTP ${responseStatus}): ${responseBody}`);
          resolve(false);
        }
      });
      req.on("error", (err) => {
        this.logger.error(`APNs request error: ${err.message}`);
        client.close();
        resolve(false);
      });
      req.end(payload);
    });
  }

  /** Cached ES256 provider token (Apple rejects tokens older than 1h). */
  private getAuthToken(): string {
    if (this.jwtCache && this.jwtCache.expires > Date.now()) {
      return this.jwtCache.token;
    }
    const privateKey = this.config
      .get<string>("APNS_PRIVATE_KEY")!
      .replace(/\\n/g, "\n");
    const token = this.jwtService.sign(
      { iss: this.config.get<string>("APNS_TEAM_ID") },
      {
        algorithm: "ES256",
        privateKey,
        keyid: this.config.get<string>("APNS_KEY_ID"),
      },
    );
    this.jwtCache = { token, expires: Date.now() + TOKEN_TTL_MS };
    return token;
  }
}

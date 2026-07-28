import { Controller, Get, Header, NotFoundException } from "@nestjs/common";

const IOS_BUNDLE_ID = "com.keel.careconnect";
const ANDROID_PACKAGE = "com.keel.careconnect";

/**
 * Domain-verification files for iOS Universal Links and Android App Links,
 * served at the root of the domain (keelcare.in) once its DNS points at this
 * backend. Excluded from the /v1 global prefix in main.ts.
 *
 * Values come from env so an unconfigured deploy serves 404 — harmless —
 * rather than a wrong file that Apple's CDN would cache for hours:
 *
 *   APPLE_TEAM_ID        Apple Developer Team ID (e.g. AB12CD34EF)
 *   ANDROID_CERT_SHA256  SHA-256 signing-cert fingerprint(s) from
 *                        `eas credentials` — comma-separated if several
 *                        (e.g. upload key + Play App Signing key).
 */
@Controller(".well-known")
export class WellKnownController {
  @Get("apple-app-site-association")
  @Header("Content-Type", "application/json")
  appleAppSiteAssociation() {
    const teamId = process.env.APPLE_TEAM_ID;
    if (!teamId) throw new NotFoundException();
    return {
      applinks: {
        apps: [],
        details: [
          {
            appID: `${teamId}.${IOS_BUNDLE_ID}`,
            paths: ["/auth/callback", "/payment/callback"],
          },
        ],
      },
    };
  }

  @Get("assetlinks.json")
  @Header("Content-Type", "application/json")
  assetLinks() {
    const fingerprints = process.env.ANDROID_CERT_SHA256;
    if (!fingerprints) throw new NotFoundException();
    return [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: ANDROID_PACKAGE,
          sha256_cert_fingerprints: fingerprints.split(",").map((f) => f.trim()),
        },
      },
    ];
  }
}

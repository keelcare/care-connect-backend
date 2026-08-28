// Import with `const Sentry = require("@sentry/nestjs");` if you are using CJS
import * as Sentry from "@sentry/nestjs";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [nodeProfilingIntegration()],

  // Send structured logs to Sentry
  enableLogs: true,
  // Tracing
  // 100% traces at launch. Reduce to 0.2 once traffic grows.
  tracesSampleRate: 1.0,
  // Set sampling rate for profiling - this is evaluated only once per SDK.init call
  profileSessionSampleRate: 1.0,
  // Trace lifecycle automatically enables profiling during active traces
  profileLifecycle: "trace",
  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: false,
  beforeSend(event) {
    // Privacy policy promise: crash reports contain no name, email, account
    // identifier, location, or usage trail — scrub all of it, not just IP/email.
    if (event.user) {
      delete event.user.ip_address;
      delete event.user.email;
      delete event.user.id;
      delete event.user.username;
    }
    if (event.request) {
      if (event.request.headers) {
        delete event.request.headers["cookie"];
        delete event.request.headers["authorization"];
      }
      delete event.request.data;
      delete event.request.query_string;
      delete event.request.cookies;
    }
    if (Array.isArray(event.breadcrumbs)) {
      event.breadcrumbs = event.breadcrumbs.map((b) => {
        if (b.data) {
          const { cookie: _cookie, authorization: _authorization, ...rest } =
            b.data as Record<string, unknown>;
          return { ...b, data: rest };
        }
        return b;
      });
    }
    return event;
  },
});

import "./instrument"; // MUST BE AT THE TOP — Sentry init before everything
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe, Logger } from "@nestjs/common";
import helmet from "helmet";
import { Logger as PinoLogger } from "nestjs-pino";
import cookieParser from "cookie-parser";
import { ThrottleExceptionFilter } from "./common/filters/throttle-exception.filter";

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Use nestjs-pino logger
  app.useLogger(app.get(PinoLogger));

  app.useGlobalFilters(new ThrottleExceptionFilter());

  app.use(cookieParser());

  // Dev-only request logger — safe, redacted, never logs body or cookie values.
  // In production: Sentry captures full request context on errors (instrument.ts).
  // HTTP request/response logs (method, url, status, ms) come from nestjs-pino.
  if (process.env.NODE_ENV !== 'production') {
    app.use((req: any, res: any, next: () => void) => {
      const hasCookies = !!req.headers.cookie;
      const cookieNames = hasCookies
        ? req.headers.cookie.split(';').map((c: string) => c.trim().split('=')[0])
        : [];
      const hasAuth = !!req.headers.authorization;
      logger.debug(
        `[REQ] ${req.method} ${req.url} | origin=${req.headers.origin ?? 'none'} | cookies=[${cookieNames.join(', ')}] | auth=${hasAuth}`,
      );
      next();
    });
  }

  // Connect-src for Helmet needs multiple origins
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    "http://localhost:3000",
    "https://keel-care.vercel.app",
    "https://keelcare.netlify.app",
    "https://care-connect-dev.vercel.app",
    "http://127.0.0.1:3000",
    // Capacitor mobile origin (iOS WKWebView & Android WebView)
    "capacitor://localhost",
    "http://localhost",
    "https://localhost",
    "ionic://localhost",
    "http://192.168.1.38:3000",
    "http://192.168.0.3:3000",
    // Match any vercel.app or netlify.app subdomains for development
  ].filter(Boolean) as string[];

  // Security Headers using Helmet
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            "'unsafe-eval'",
            "https://checkout.razorpay.com",
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          frameSrc: ["'self'", "https://api.razorpay.com"],
          connectSrc: ["'self'", "https://api.razorpay.com", ...allowedOrigins],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      frameguard: {
        action: "deny",
      },
      xssFilter: true,
      noSniff: true,
      hidePoweredBy: true,
    }),
  );

  // Enable CORS with multiple origins
  app.enableCors({
    origin: (origin, callback) => {
      // Allow if no origin (server-to-server or mobile app bypass)
      // or if it matches our list or specific patterns
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        origin.includes(".vercel.app") ||
        origin.includes(".netlify.app") ||
        origin.startsWith("capacitor://") ||
        origin.startsWith("keel://") ||
        origin.startsWith("careconnect://")
      ) {
        callback(null, true);
      } else {
        logger.warn(`[CORS] Origin blocked: ${origin}`);
        callback(null, false);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "X-Platform",
      "X-Device-Id",
    ],
    exposedHeaders: ["set-cookie"],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Trust Proxy for Render (required for Secure cookies behind load balancer)
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set("trust proxy", 1); // Trust first proxy

  // Swagger Documentation configuration
  const { DocumentBuilder, SwaggerModule } = await import("@nestjs/swagger");
  const config = new DocumentBuilder()
    .setTitle("Care Connect API")
    .setDescription("The API documentation for Care Connect backend services.")
    .setVersion("1.0")
    .addBearerAuth()
    .addTag("Authentication", "User authentication and authorization")
    .addTag("Users", "User profile and management")
    .addTag("Nannies", "Nanny specific operations")
    .addTag("Requests", "Care service requests")
    .addTag("Bookings", "Booking management")
    .addTag("Payments", "Payment processing")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
    customSiteTitle: "Care Connect API Docs",
  });

  const port = process.env.PORT ?? 4000;
  await app.listen(port, '0.0.0.0');
  logger.log(`🚀 Application is running on port ${port}`);
  logger.log(`📖 Swagger docs at: http://0.0.0.0:${port}/api/docs`);
}
bootstrap();

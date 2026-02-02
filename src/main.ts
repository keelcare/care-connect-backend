import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { Logger as PinoLogger } from "nestjs-pino";
import cookieParser from "cookie-parser";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Use nestjs-pino logger
  app.useLogger(app.get(PinoLogger));

  app.use(cookieParser());

  // DEBUG MIDDLEWARE: Log all requests to check for cookies
  app.use((req, res, next) => {
    console.log("------------------------------------------------------------------");
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    console.log(`[ORIGIN] ${req.headers.origin}`);
    console.log(`[COOKIES (Header)]`, req.headers.cookie);
    console.log(`[COOKIES (Parsed)]`, req.cookies);
    console.log("------------------------------------------------------------------");
    next();
  });

  // Security Headers using Helmet
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'", // Kept for Next.js hydration scripts if needed, but ideally remove
            "'unsafe-eval'",   // Kept for some dev tools, consider removing for prod
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
          connectSrc: [
            "'self'",
            "https://api.razorpay.com",
            process.env.FRONTEND_URL || "http://localhost:3000",
          ],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      // Strict Transport Security (HSTS)
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
      // Prevent clickjacking
      frameguard: {
        action: 'deny',
      },
      // XSS Protection
      xssFilter: true,
      // Prevent MIME sniffing
      noSniff: true,
      // Hide X-Powered-By
      hidePoweredBy: true,
    }),
  );

  // Enable CORS with strict checks
  app.enableCors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
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

  const port = process.env.PORT ?? 4000;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Application is running on: http://0.0.0.0:${port}`);
}
bootstrap();

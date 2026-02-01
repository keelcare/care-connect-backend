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

  // Security Headers using Helmet
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            "'unsafe-eval'", // often needed for dev or some libs
            "https://checkout.razorpay.com",
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          frameSrc: ["'self'", "https://api.razorpay.com"], // Razorpay uses iframes
          connectSrc: [
            "'self'",
            "https://api.razorpay.com",
            process.env.FRONTEND_URL || "https://keel-care.vercel.app",
          ],
        },
      },
      crossOriginEmbedderPolicy: false, // Often causes issues with resources loaded from other domains
      crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow resources to be loaded cross-origin (e.g., images)
    }),
  );

  // Enable CORS with strict checks
  app.enableCors({
    origin: process.env.FRONTEND_URL || "https://keel-care.vercel.app",
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

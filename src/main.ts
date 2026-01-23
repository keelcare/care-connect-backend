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
          scriptSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline might be needed for some inline scripts, remove if possible
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: [
            "'self'",
            process.env.FRONTEND_URL || "http://localhost:3000",
          ],
        },
      },
      crossOriginEmbedderPolicy: false, // Often causes issues with resources loaded from other domains
      crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow resources to be loaded cross-origin (e.g., images)
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

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  console.log(`🚀 Application is running on: http://localhost:${port}`);
}
bootstrap();

import 'reflect-metadata';
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { Logger as PinoLogger } from "nestjs-pino";
import cookieParser from "cookie-parser";
import { ThrottleExceptionFilter } from "./common/filters/throttle-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Use nestjs-pino logger
  app.useLogger(app.get(PinoLogger));

  // SECURITY: Global exception filter for graceful rate limit responses
  app.useGlobalFilters(new ThrottleExceptionFilter());

  app.use(cookieParser());

  // DEBUG MIDDLEWARE: Log all requests to check for cookies
  app.use((req, res, next) => {
    console.log("------------------------------------------------------------------");
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    console.log(`[ORIGIN] ${req.headers.origin}`);
    console.log(`[COOKIES (Header)]`, req.headers.cookie);
    console.log(`[COOKIES (Parsed)]`, req.cookies);
    console.log(`[BODY]`, req.body);
    console.log("------------------------------------------------------------------");
    next();
  });

  // Connect-src for Helmet needs multiple origins
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    "http://localhost:3000",
    "https://keelcare.netlify.app",
    "https://care-connect-dev.vercel.app",
    "http://127.0.0.1:3000",
    "capacitor://localhost",
    "https://localhost",
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
          connectSrc: [
            "'self'",
            "https://api.razorpay.com",
            ...allowedOrigins,
          ],
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
        action: 'deny',
      },
      xssFilter: true,
      noSniff: true,
      hidePoweredBy: true,
    }),
  );

  // Enable CORS with multiple origins
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
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

  // Swagger Documentation configuration
  const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
  const config = new DocumentBuilder()
    .setTitle('Care Connect API')
    .setDescription('The API documentation for Care Connect backend services.')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Authentication', 'User authentication and authorization')
    .addTag('Users', 'User profile and management')
    .addTag('Nannies', 'Nanny specific operations')
    .addTag('Requests', 'Care service requests')
    .addTag('Bookings', 'Booking management')
    .addTag('Payments', 'Payment processing')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
    customSiteTitle: 'Care Connect API Docs',
  });

  const port = process.env.PORT ?? 4000;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Application is running on: http://0.0.0.0:${port}`);
  console.log(`📖 Swagger documentation available at: http://0.0.0.0:${port}/api/docs`);
}
bootstrap();

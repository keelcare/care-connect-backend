# 🤖 Antigravity Working Instructions: CareConnect Project

This document serves as a persistent context for the **CareConnect** project. Follow these guidelines to maintain consistency and security.

---

## 🏗️ Project Context & Architecture
**CareConnect** is a specialized childcare marketplace platform connecting Parents, Nannies, and Agency Admins.

### Technology Stack
- **Frontend**: [Next.js 16+](file:///Applications/Vscode/CareConnect) (App Router), Tailwind CSS 4, shadcn/ui, Radix UI.
- **Backend**: [NestJS 10+](file:///Applications/Vscode/care-connect-backend) (Modular Architecture).
- **Database**: PostgreSQL (hosted via **Supabase**).
- **ORM**: Prisma 6+.
- **Real-time**: Socket.io for messaging and location tracking.
- **Security**: RBAC, Resource-level Ownership Guards, PII Encryption (AES-256-GCM), Input Sanitization.
- **Integrations**: Razorpay (Payments), Google (Auth/Maps), Cloudinary (Media), Gemini AI (Matching).

### Hosting Environments
- **Frontend**: [Vercel](https://keel-care.vercel.app)
- **Backend**: Hosted as a separate service (e.g., Render or AWS) with CORS locked to the Vercel origin.
- **Database**: [Supabase](https://supabase.com) (Direct connections enabled for Prisma).

---

## 🎨 Coding Conventions

### Backend (NestJS)
- **Modularity**: Follow the standard Folder-per-Module structure.
- **DTOs**: Always use `class-validator` and `class-transformer`.
- **Naming**: `camelCase` for variables/functions, `PascalCase` for classes/modules. File names should be `something.service.ts`, `something.controller.ts`.
- **Validation**: Use strict validation pipes in `main.ts` (whitelist: true).

### Frontend (Next.js)
- **Components**: Use Radix-based components in `src/components/ui`.
- **Tailwind**: Use Tailwind 4 syntax. Avoid inline styles.
- **State**: Use React 19 hooks and Context where necessary.

---

## 🔒 Security Protocol (CRITICAL)

### 1. Resource Authorization
Every resource-modifying endpoint **MUST** be protected by:
- `AuthGuard('jwt')`: Identity verification.
- `OwnershipGuard`: Ensures users only modify their own resources.
- `PermissionsGuard`: RBAC enforcement.

**Example Implementation:**
```typescript
@UseGuards(AuthGuard("jwt"), OwnershipGuard, PermissionsGuard)
@ResourceOwnership(ResourceType.BOOKING)
@RequirePermissions(Permission.BOOKING_WRITE)
@Put(":id")
updateBooking(...)
```

### 2. Data Protection
- **PII Encryption**: Fields like `profile.phone` or sensitive ID numbers are encrypted at the DB level via `PrismaService` middleware.
- **Sanitization**: Apply `@Sanitize()` decorator in DTOs to all string fields that accept user input to prevent XSS.
- **Headers**: `Helmet` is active in `main.ts`. Any new integration (like a new iframe provider) needs CSP update there.

---

## 📋 Common Task Workflows

### Adding a New Entity
1.  **Schema**: Update `schema.prisma` and run `npx prisma db push`.
2.  **Generate**: Run `npx prisma generate` to update types.
3.  **Module**: Use `nest g mo/s/co [name]` to scaffold the module.
4.  **Guard**: Update `ResourceType` enum in `ownership.guard.ts` if it's a new protected resource.
5.  **Permissions**: Update `Permission` enum and role-permissions map in `common/constants`.

### Implementing PII Protection
1.  Add the field name to `sensitiveFields` in `common/services/encryption.service.ts`.
2.  The `PrismaService` middleware will automatically handle encryption on write and decryption on read.

---

## ⚠️ Gotchas & Pitfalls
- **Redis Requirement**: We have **removed** the Redis dependency to simplify the architecture. All token revocations and rate limits are either in-memory or DB-backed (PostgreSQL).
- **CORS**: If local development fails, check the `FRONTEND_URL` in `.env`.
- **Indentation**: The codebase uses 2-space or 4-space indentation depending on the file; **always match the file's existing style** to avoid mismatch errors in `multi_replace_file_content`.

---

## 🧪 Verification Strategy
- **Unit Tests**: Run `npm test` for logic validation.
- **E2E**: Use `test:e2e` for flow validation.
- **Prisma**: Always verify migrations with `prisma generate` to catch type mismatches early.
- **Manual**: When testing UI, use the browser tool and search for unique `id` attributes.

# Agent Instructions: Care Connect Backend

This document contains personalized instructions, context, and workflows for working on the Care Connect Backend.

## 1. Project Overview
- **Name**: Care Connect Backend
- **Description**: NestJS-based backend for connecting parents with nannies.
- **Tech Stack**:
  - **Framework**: NestJS (Node.js)
  - **Language**: TypeScript (loose strictness)
  - **Database**: PostgreSQL (via Docker), Prisma ORM
  - **Auth**: JWT, Passport.js, Google OAuth
  - **Real-time**: Socket.io
- **Hosting**:
  - **Backend**: Render (likely, based on issues)
  - **Frontend**: Vercel

## 2. User Preferences & Workflow
- **Branching**: Always checkout a new branch for new features or significant refactors.
  - Command: `git checkout -b <descriptive-branch-name>`
- **Planning**:
  - **ALWAYS** create an `implementation_plan.md` before starting code changes.
  - **ALWAYS** wait for user approval on the plan.
- **Task Management**:
  - Maintain a `task.md` checklist.
  - Update `task_boundary` frequently to reflect progress.
- **Communication**:
  - Be proactive but safe.
  - Explain the Plan, Execute, Verify loop.

## 3. Code Conventions
- **NestJS**:
  - Use Modules to organize features (`src/users`, `src/auth`).
  - Use DTOs with `class-validator` for input validation.
  - Use Guards for protection (`JwtAuthGuard`, `RolesGuard`).
- **Database (Prisma)**:
  - Schema: `prisma/schema.prisma`
  - Update process: Change schema -> `npx prisma migrate dev` (or `db push` for prototyping, but prefer migrations).
  - **Caution**: Watch out for schema mismatches in production.
- **TypeScript**:
  - `strictNullChecks` is `false`. Be careful with potential null/undefined values despite the loose config.
  - Avoid adding `any` if possible, but respect existing patterns.

## 4. Workflows

### Feature Development
1.  **Analyze**: Understand requirements and related files.
2.  **Plan**: Create `implementation_plan.md` (Design, Changes, Verification).
3.  **Review**: `notify_user` for approval.
4.  **Branch**: `git checkout -b feature/name`.
5.  **Implement**: Write code, strictly following the plan.
6.  **Verify**:
    - Run unit tests: `npm run test`
    - Run generic E2E tests if available: `npm run test:e2e`
    - **Manual Verification**: Verify endpoints using `curl` or description of how to test in browser/Postman. (Note: User often tests manually).

### Bug Fixing
1.  **Repo Check**: Ensure clean state.
2.  **Reproduce**: Understand the error (logs, user description).
3.  **Fix**: Apply changes.
4.  **Verify**: Ensure the specific error is gone.

## 5. Common Gotchas & Troubleshooting
- **Deployment (Render)**:
  - "JavaScript heap out of memory": Node options might need adjustment.
  - `NEXT_PUBLIC_API_URL` vs `FRONTEND_URL` mismatch causing CSP/CORS issues.
- **Database**:
  - `500 Internal Server Error` often points to Schema mismatch (e.g., missing columns in DB vs Prisma).
  - Always verify DB state if generic errors occur.
- **Environment**:
  - `.env` file management is strict. Do not commit sensitive keys.
  - Ensure local `.env` matches the `env.example` structure (if it exists).

## 6. Key File Locations
- **App Entry**: `src/main.ts`
- **Config**: `.env`, `package.json`, `tsconfig.json`
- **Database**: `prisma/schema.prisma`
- **Modules**: `src/<module_name>/` (e.g., `src/auth/auth.module.ts`)
- **Guards**: `src/common/guards/` (assumed based on standard structure) or `src/auth/guards/`.

## 7. Testing
- **Unit**: `npm run test`
- **E2E**: `npm run test:e2e`
- **Coverage**: `npm run test:cov`

## 8. Specific Task Notes
- **Security**: Recent focus on authorization guards (Resource level) and PII encryption.
- **UI/Admin**: Admin panel often needs "Back" buttons and specific currency symbols (Rupee).

## 9. Formatting
- Use GitHub-style markdown.
- Use `backticks` for code/files.
- **Artifacts**: Store in `<appDataDir>/brain/<conversation-id>`.

---
*Last Updated: 2026-02-02*

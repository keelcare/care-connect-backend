# WhatsApp Business Integration – System Architecture Overview

## Project Name
WhatsApp Query Bot + Customer Support Dashboard

## Objective

Integrate WhatsApp Business into CareConnect to:

1. Let parents initiate contact via a "Get in Touch" card on the app/website
2. Redirect them to WhatsApp (app on mobile, web.whatsapp.com on browser)
3. A company chatbot greets them and collects enquiry details
4. Store all conversations and enquiries in the database
5. Expose a **Customer Support Dashboard** for agents to view, manage, and reply to enquiries

---

# 1. Entry Point (Frontend)

The parent clicks the **"Contact Us / Get in Touch"** card.

| Platform | Redirect Target |
|----------|-----------------|
| Mobile App (iOS/Android) | `whatsapp://send?phone=<COMPANY_NUMBER>&text=Hi` (deep link opens WhatsApp app) |
| Web Browser | `https://wa.me/<COMPANY_NUMBER>?text=Hi` (opens web.whatsapp.com) |

> **Frontend role:** Render the card and construct the correct redirect URL based on platform detection. No backend call needed for the redirect itself.

---

# 2. High-Level Architecture

```
Parent (App/Web)
    ↓  Clicks "Get in Touch" card
WhatsApp (app or web.whatsapp.com)
    ↓  Parent sends first message to company number
WhatsApp Cloud API
    ↓  Webhook (POST) to our backend
Backend API (NestJS)
    ↓  Bot Engine processes message, sends reply
Database (PostgreSQL / Prisma)
    ↓
Customer Support Dashboard (New App)
```

---

# 3. Core Components

## 3.1 Frontend Entry Point

**Who owns this:** Frontend team

Responsibilities:
- Detect platform (mobile vs. web)
- Render "Get in Touch" card
- Construct `wa.me` or `whatsapp://` deep link with pre-filled greeting text
- No API call to backend is needed for this step

---

## 3.2 WhatsApp Business Account

**Who owns this:** Company operations

Requirements:
- WhatsApp Business account with a registered phone number
- Verified Meta Business account
- WhatsApp Cloud API enabled (via Meta Developer Portal)
- Webhook URL (HTTPS) pointing to our backend
- Webhook Verify Token stored in environment variables
- Access Token stored in environment variables
- Approved message templates (for post-24h outbound messages)

---

## 3.3 Webhook Endpoint (Backend)

**Who owns this:** Backend

Endpoint:
```
GET  /webhooks/whatsapp   ← Webhook verification by Meta
POST /webhooks/whatsapp   ← Incoming messages from WhatsApp
```

Responsibilities:
- **GET**: Return the hub challenge to verify the webhook with Meta
- **POST**: Validate X-Hub-Signature-256 header
- Parse incoming payload and extract message details
- Store raw message in `whatsapp_messages`
- Delegate to Bot Engine for processing
- Respond with `200 OK` immediately (async processing)

---

## 3.4 Bot Engine (Conversation Controller)

**Who owns this:** Backend

State machine based on `whatsapp_conversations.current_step`.

### Conversation Flow

| Step | Trigger | Bot Response | Next Step |
|------|---------|--------------|-----------|
| `WELCOME` | First message (any text) | "Hi! 👋 Welcome to CareConnect. I'm here to help. May I have your name?" | `COLLECT_NAME` |
| `COLLECT_NAME` | User sends name | "Thanks {name}! What's your phone number?" | `COLLECT_PHONE` |
| `COLLECT_PHONE` | User sends phone | "Got it! What's your email address? *(Type 'skip' to skip)*" | `COLLECT_EMAIL` |
| `COLLECT_EMAIL` | User sends email or 'skip' | "What can we help you with? Reply with a number:\n1. Booking Help\n2. Payment Issue\n3. Finding a Caregiver\n4. Account Support\n5. Other" | `COLLECT_CATEGORY` |
| `COLLECT_CATEGORY` | User picks category | "Please describe your query in a few words." | `COLLECT_ENQUIRY` |
| `COLLECT_ENQUIRY` | User sends message | "Thank you {name}! 🙏 Our team will get back to you shortly. You can also reach us at support@careconnect.com." | `COMPLETED` |

**On completion:**
- Create record in `whatsapp_enquiries`
- Mark conversation status as `COMPLETED`

**Edge cases:**
- Unknown / out-of-flow message → Re-send current step prompt
- Invalid category number → Re-ask with the list
- Duplicate webhook events → Deduplicate by `message_id`

---

## 3.5 WhatsApp Messaging Service (Backend)

**Who owns this:** Backend

Wraps calls to the WhatsApp Cloud API:
- `sendTextMessage(phone, text)` — Send bot reply
- `sendTemplateMessage(phone, templateName, params)` — For post-24h outreach

---

# 4. Database Design

## 4.1 `whatsapp_conversations`

Tracks conversation state per phone number.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| phone_number | String | Unique, indexed |
| name | String? | Collected in COLLECT_NAME step |
| current_step | Enum | WELCOME / COLLECT_NAME / COLLECT_PHONE / COLLECT_EMAIL / COLLECT_CATEGORY / COLLECT_ENQUIRY / COMPLETED |
| status | Enum | ACTIVE / COMPLETED |
| created_at | DateTime | |
| updated_at | DateTime | |

---

## 4.2 `whatsapp_enquiries`

Final support ticket once conversation completes.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| name | String | |
| phone_number | String | Indexed |
| email | String? | Optional |
| category | String | e.g. "Booking Help" |
| message | Text | Raw enquiry message |
| source | Enum | WHATSAPP |
| status | Enum | NEW / CONTACTED / CLOSED |
| assigned_to | UUID? | FK → users (support agent) |
| notes | Text? | Internal agent notes |
| created_at | DateTime | |
| updated_at | DateTime | |

---

## 4.3 `whatsapp_messages`

Full audit log of every sent/received message.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| phone_number | String | Indexed |
| direction | Enum | INBOUND / OUTBOUND |
| message_body | Text | |
| message_id | String? | WhatsApp message ID, for deduplication |
| raw_payload | JSON? | Full webhook payload |
| created_at | DateTime | |

---

# 5. Customer Support Dashboard (New App)

**Who owns this:** Frontend team (separate app / admin panel)

This is a **new standalone dashboard** (Next.js or similar) separate from the main customer-facing apps.

## 5.1 Enquiry List View

- Table of all WhatsApp enquiries
- Columns: Name, Phone, Category, Status, Assigned To, Date
- Filters: Status, Agent, Date Range
- Search: by name, phone, email
- Unread / new indicator

## 5.2 Enquiry Detail View

- Customer info panel (name, phone, email, category)
- Full chronological WhatsApp message history
- Agent reply input → calls backend to send WhatsApp reply
- Status dropdown (New → Contacted → Closed)
- Assign to agent dropdown
- Internal notes section

---

# 6. Backend API Endpoints for Dashboard

**Who owns this:** Backend

All endpoints require admin/agent authentication (JWT, role: admin or support_agent).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/whatsapp/enquiries` | List all enquiries (with filters) |
| GET | `/admin/whatsapp/enquiries/:id` | Get enquiry + message history |
| POST | `/admin/whatsapp/enquiries/:id/reply` | Send WhatsApp reply as agent |
| PATCH | `/admin/whatsapp/enquiries/:id` | Update status / assign agent / add notes |

---

# 7. Security

- Validate X-Hub-Signature-256 on all incoming webhooks
- HTTPS only
- Store WHATSAPP_ACCESS_TOKEN and WHATSAPP_VERIFY_TOKEN in `.env`
- Role-based access for dashboard API (admin / support_agent)
- Rate limiting on webhook endpoint

---

# 8. Implementation Phases

## Phase 1 – Backend Foundation
- [ ] Prisma schema: Add 3 new models + enums
- [ ] Run DB migration
- [ ] `WhatsAppModule` scaffolding
- [ ] Webhook verification (GET endpoint)
- [ ] Webhook receiver + signature validation (POST endpoint)
- [ ] Raw message logging to `whatsapp_messages`
- [ ] Bot engine state machine (all steps)
- [ ] `WhatsAppService` — outbound message calls to Cloud API

## Phase 2 – Dashboard API
- [ ] `GET /admin/whatsapp/enquiries`
- [ ] `GET /admin/whatsapp/enquiries/:id` (with message history)
- [ ] `POST /admin/whatsapp/enquiries/:id/reply`
- [ ] `PATCH /admin/whatsapp/enquiries/:id` (status / assign / notes)

## Phase 3 – Frontend Integration
- [ ] "Get in Touch" card component
- [ ] Platform detection (mobile vs. web)
- [ ] WhatsApp redirect URL construction
- [ ] Customer Support Dashboard (new app)

## Phase 4 – Optimization
- [ ] Queue-based async message processing (Redis/Bull)
- [ ] Auto-assignment logic for agents
- [ ] SLA timers and notifications
- [ ] Analytics on enquiry categories

---

# 9. Division of Responsibilities

| Area | Owner |
|------|-------|
| "Get in Touch" card + redirect | **Frontend** |
| Customer Support Dashboard UI | **Frontend** |
| WhatsApp webhook receiver | **Backend** |
| Bot state engine | **Backend** |
| Database models + migrations | **Backend** |
| Dashboard API endpoints | **Backend** |
| WhatsApp Cloud API integration | **Backend** |

---

# 10. Environment Variables Required (Backend)

```env
WHATSAPP_ACCESS_TOKEN=       # Meta Cloud API token
WHATSAPP_PHONE_NUMBER_ID=    # Phone number ID from Meta
WHATSAPP_VERIFY_TOKEN=       # Custom string for webhook verification
WHATSAPP_API_VERSION=        # e.g. v19.0
```

---

# 11. Open Questions

The development team must confirm:

- [ ] Should we support multilingual conversations? (Default is English)
- [ ] What is the expected daily message volume?
- [ ] Should the dashboard be a new Next.js app or embedded in the existing admin panel?
- [ ] Do we need live/real-time updates in the dashboard (WebSocket/SSE)?
- [ ] What roles should have access to the support dashboard? (admin only, or also `support_agent` role?)
- [ ] Should we use a message queue (Bull/Redis) from Phase 1 or add it in Phase 4?

---

# End of Document
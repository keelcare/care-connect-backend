# Event-Driven Architecture (EDA) Evaluation

This document evaluates the practicality and benefits of transitioning the `care-connect-backend` to an Event-Driven Architecture (EDA), specifically using Redis Streams or Kafka.

## Executive Summary
The current architecture relies on synchronous database operations and third-party integrations (FCM, WebSockets) that block the main execution thread. Migrating the most critical, long-running processes to an EDA using **Redis Streams** will significantly improve system responsiveness, reliability, and scalability.

---

## 1. Pros of Migrating to EDA

### ⚡ Improved Responsiveness
- **Decoupled API Responses**: Critical endpoints like `POST /requests` can return a `201 Created` status in milliseconds, moving the heavy matching logic ([triggerMatching](file:///Applications/Vscode/care-connect-backend/src/requests/requests.service.ts#221-491)) to a background consumer.
- **Latency Reduction**: User-facing operations are no longer gated by the speed of geo-spatial queries or third-party push notification services.

### 🛡️ Enhanced Reliability
- **Fault Isolation**: Failures in non-core services (e.g., FCM push notification timeout) will no longer cause the entire business transaction to roll back or return a 500 error.
- **Automatic Retries**: Message queues allow for built-in retry mechanisms. If a matching attempt fails due to a transient DB lock, the consumer can retry without user intervention.

### 📈 Scalability & Maintainability
- **Independent Scaling**: The matching engine and notification service can be scaled horizontally and independently of the main API server.
- **Improved Code Quality**: Naturally decouples services (Requests, Bookings, Notifications), reducing the "bloated service" pattern and circular dependencies.

---

## 2. Tradeoffs & Challenges

### 🔧 Operational Complexity
- **New Infrastructure**: Requires maintaining a Redis instance with persistence (`APPENDONLY yes`). While simpler than Kafka, it's still an additional component in the stack.
- **Observability**: Debugging distributed flows is harder. Tracking a single user request across a stream to a consumer requires implementing **Correlation IDs**.

### 🧩 Consistency Model
- **Eventual Consistency**: The system moves from immediate consistency to eventual consistency. A notification record might not appear in the DB for a few hundred milliseconds after the action occurs.
- **Message Ordering**: While Redis Streams guarantee ordering within a stream, cross-stream ordering requires careful design.

---

## 3. Impact Analysis

### Technical Impact
- **Main Thread Offloading**: Reduces the CPU and memory pressure on the main NestJS process during peak request times.
- **Database Connection Optimization**: Reduces the duration of high-isolation level transactions (like `Serializable` used in matching).

### Business Impact
- **User Experience**: Drastic reduction in "spinner time" for parents creating care requests.
- **System Stability**: Higher uptime and Fewer "transient 500s" caused by third-party timeouts.

---

## 4. Why Redis Streams (Over Kafka)

| Feature | Redis Streams | Kafka |
| :--- | :--- | :--- |
| **Setup Cost** | Low (Single instance) | High (Multi-node/Cloud) |
| **Complexity** | Minimal (Uses existing Redis knowledge) | Moderate/High (Consumer groups, partitions) |
| **Resource Usage** | Very Low | High (~1.5GB RAM minimum) |
| **Suitability** | **Perfect for current scale** | Overkill until high throughput |

---

## 5. Implementation Roadmap (Phase 1)

### Phase 1: Core Decoupling
- **Scope**: Move [triggerMatching](file:///Applications/Vscode/care-connect-backend/src/requests/requests.service.ts#221-491) and [createNotification](file:///Applications/Vscode/care-connect-backend/src/notifications/notifications.service.ts#18-65) to background workers.
- **Timeline**: 1-2 Days of focused development.
- **Complexity**: Low-Medium (Non-breaking changes).

**Key Milestones:**
1. Setup `EventBusService` (Redis Stream Publisher).
2. Implement `MatchingConsumer` and `NotificationConsumer`.
3. Update service call sites to publish events instead of awaiting logic.

---

## 6. Conclusion
Transitioning to an EDA is **highly practical** for `care-connect-backend`. The immediate gains in user experience and system reliability far outweigh the minor increase in operational complexity. **Recommendation: Proceed with Phase 1 migration using Redis Streams.**

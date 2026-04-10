import { Injectable, Logger } from "@nestjs/common";
import { Subject } from "rxjs";
import { SseEvent } from "../events/sse-event.types";

/**
 * SseService — manages per-user SSE subjects.
 *
 * Design decisions:
 * - One Subject<MessageEvent> per connected user (identified by userId).
 * - If a user has multiple tabs open, only the most-recent connection is tracked.
 *   This is intentional: SSE reconnects are cheap and transient; the browser
 *   handles automatic reconnection natively.
 * - The service is intentionally thin: it only routes events. Business logic
 *   (what to emit and to whom) lives in the feature services.
 */
@Injectable()
export class SseService {
  private readonly logger = new Logger(SseService.name);

  /** userId → { subject, role } that backs the SSE stream for that user */
  private readonly clients = new Map<
    string,
    { subject: Subject<MessageEvent>; role: string }
  >();

  /**
   * Register a new SSE client for a user.
   * Returns the Subject so the controller can convert it to an Observable.
   */
  addClient(userId: string, role: string = "user"): Subject<MessageEvent> {
    // Tear down any existing connection for this user (e.g. tab refresh)
    this.removeClient(userId);

    const subject = new Subject<MessageEvent>();
    this.clients.set(userId, { subject, role });
    this.logger.log(
      `SSE client connected: ${userId} (total: ${this.clients.size})`,
    );
    return subject;
  }

  /**
   * Remove a user's SSE subject and complete the stream so the browser
   * knows the connection ended cleanly.
   */
  removeClient(userId: string): void {
    const existing = this.clients.get(userId);
    if (existing) {
      existing.subject.complete();
      this.clients.delete(userId);
      this.logger.log(
        `SSE client disconnected: ${userId} (total: ${this.clients.size})`,
      );
    }
  }

  /**
   * Push an event to a single user's SSE stream.
   * Silently ignores if the user is not connected (fire-and-forget).
   */
  emitToUser(userId: string, event: SseEvent): void {
    this.emitToUsers([userId], event);
  }

  /**
   * Fan-out helper: push the same event to multiple users.
   */
  emitToUsers(userIds: string[], event: SseEvent): void {
    const messageEvent = new MessageEvent("message", {
      data: JSON.stringify(event),
    });

    // 1. Send to explicitly targeted users
    const sentTo = new Set<string>();
    for (const userId of userIds) {
      const client = this.clients.get(userId);
      if (client) {
        client.subject.next(messageEvent);
        sentTo.add(userId);
      }
    }

    // 2. Broadcast practically *all* SSE events to connected admins
    // Admin dashboards rely on these to update without manual refresh clicks.
    for (const [userId, client] of this.clients.entries()) {
      if (
        (client.role === "admin" || client.role === "super_admin") &&
        !sentTo.has(userId)
      ) {
        client.subject.next(messageEvent);
        sentTo.add(userId);
      }
    }
  }

  /** How many clients are currently connected (useful for health checks). */
  get connectedCount(): number {
    return this.clients.size;
  }
}

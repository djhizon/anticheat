import type { SessionId } from './session.js';

export const RECOVERY_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Server-side, in-memory holder for the short-lived Supabase access token that a password
 * recovery link produced. Keyed by our own session id, never persisted, never sent to a browser.
 */
export class PendingRecoveryStore {
  private readonly entries = new Map<string, { accessToken: string; expiresAt: number }>();

  set(sessionId: SessionId, accessToken: string, nowMs: number): void {
    this.prune(nowMs);
    this.entries.set(sessionId, { accessToken, expiresAt: nowMs + RECOVERY_TOKEN_TTL_MS });
  }

  /** Returns the token without consuming it, or null when missing or expired. */
  peek(sessionId: SessionId, nowMs: number): string | null {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= nowMs) {
      this.entries.delete(sessionId);
      return null;
    }
    return entry.accessToken;
  }

  delete(sessionId: SessionId): void {
    this.entries.delete(sessionId);
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) {
        this.entries.delete(key);
      }
    }
  }
}

/** Fixed-window in-memory limiter (per process). */
export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records an attempt and returns true when it is allowed. */
  take(key: string, nowMs: number): boolean {
    if (this.hits.size >= this.maxKeys) {
      for (const [existing, entry] of this.hits) {
        if (entry.resetAt <= nowMs) {
          this.hits.delete(existing);
        }
      }
    }

    const entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= nowMs) {
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

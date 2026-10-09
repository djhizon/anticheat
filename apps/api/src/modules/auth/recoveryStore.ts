import type { SessionId } from './session.js';

export const RECOVERY_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Server-side, in-memory holder for the short-lived Supabase access token that a password
 * recovery link produced. Keyed by our own session id, never persisted, never sent to a browser.
 */
export class PendingRecoveryStore {
  private readonly entries = new Map<string, { accessToken: string; expiresAt: number }>();

  set(sessionId: SessionId, accessToken: string, nowMs: number): void {
    this.entries.set(sessionId, { accessToken, expiresAt: nowMs + RECOVERY_TOKEN_TTL_MS });
  }

  /** True while a recovery entry exists for the session (the session is reset-only). */
  has(sessionId: SessionId): boolean {
    return this.entries.has(sessionId);
  }

  /** Returns the token without consuming it, or null when missing or expired. */
  peek(sessionId: SessionId, nowMs: number): string | null {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.expiresAt <= nowMs) {
      return null;
    }
    return entry.accessToken;
  }

  delete(sessionId: SessionId): void {
    this.entries.delete(sessionId);
  }

  /** Removes and returns the ids of expired entries so the caller can revoke their sessions. */
  takeExpired(nowMs: number): SessionId[] {
    const expired: SessionId[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) {
        this.entries.delete(key);
        expired.push(key as SessionId);
      }
    }
    return expired;
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
    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) {
      for (const [existing, entry] of this.hits) {
        if (entry.resetAt <= nowMs) {
          this.hits.delete(existing);
        }
      }
      if (this.hits.size >= this.maxKeys) {
        // Nothing expired: evict the oldest key so the map stays bounded.
        const oldest = this.hits.keys().next();
        if (oldest.done !== true) {
          this.hits.delete(oldest.value);
        }
      }
    }

    const entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= nowMs) {
      this.hits.delete(key);
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** True when the key already used up its attempts in the current window (records nothing). */
  isLimited(key: string, nowMs: number): boolean {
    const entry = this.hits.get(key);
    return entry !== undefined && entry.resetAt > nowMs && entry.count >= this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }
}

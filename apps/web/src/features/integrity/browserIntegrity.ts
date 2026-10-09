/**
 * Shared types used across integrity modules.
 * The original Codex "Browser Activity Lab" engine was removed in Pack 8.
 */

export interface AttemptContext {
  readonly id: string;
  readonly active: boolean;
  readonly deadline: number;
}

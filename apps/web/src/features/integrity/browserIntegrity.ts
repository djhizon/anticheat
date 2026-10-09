/**
 * Shared types used across integrity modules.
 * The original Codex "Browser Activity Lab" engine was removed.
 */

export interface AttemptContext {
  readonly id: string;
  readonly active: boolean;
  readonly deadline: number;
}

export type Opaque<T, Brand extends string> = T & {
  readonly __brand: Brand;
};

export type UserId = Opaque<string, 'UserId'>;
export type ExamId = Opaque<string, 'ExamId'>;
export type AttemptId = Opaque<string, 'AttemptId'>;

export type UserRole = 'student' | 'instructor';

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export interface AuditEventInput {
  readonly action: string;
  readonly actorId?: UserId;
  readonly attemptId?: AttemptId;
  readonly occurredAt: Date;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditSink {
  append(event: AuditEventInput): void | Promise<void>;
}

export type ProblemCode =
  'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'validation_failed' | 'invalid_state';

export interface ProblemDetails {
  readonly code: ProblemCode;
  readonly message: string;
}

const publicProblemMessages: Record<ProblemCode, string> = {
  unauthorized: 'Authentication is required.',
  forbidden: 'You do not have permission to perform this action.',
  not_found: 'The requested resource was not found.',
  conflict: 'The request conflicts with the current state.',
  validation_failed: 'The request contains invalid data.',
  invalid_state: 'The request could not be completed.',
};

export class DomainError extends Error {
  readonly code: ProblemCode;
  readonly details: Readonly<Record<string, string | number | boolean>> | undefined;

  constructor(
    code: ProblemCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function problemFromError(error: unknown): ProblemDetails {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      message: publicProblemMessages[error.code],
    };
  }

  return {
    code: 'invalid_state',
    message: 'The request could not be completed.',
  };
}

/** "1 word", "2 words": a count with its noun in the right number. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

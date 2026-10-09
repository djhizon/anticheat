import type { DatabaseSync } from 'node:sqlite';

import type {
  AssignmentId,
  ExamAnswerValue,
  AttemptStatus,
  ExamVersionId,
  QuestionOption,
  QuestionType,
  QuestionVersionId,
} from '@exam-anti-cheat/contracts/exam';
import type { AttemptId, ExamId, Opaque, UserId, UserRole } from '@exam-anti-cheat/contracts';

export type ExamVersionStatus = 'draft' | 'published';

export interface ExamRecord {
  readonly id: ExamId;
  readonly slug: string;
  readonly createdAt: string;
}

export interface ExamVersionRecord {
  readonly id: ExamVersionId;
  readonly examId: ExamId;
  readonly versionNumber: number;
  readonly title: string;
  readonly durationSeconds: number;
  readonly status: ExamVersionStatus;
  readonly createdAt: string;
  readonly publishedAt: string | null;
}

export interface ExamAssignmentRecord {
  readonly id: AssignmentId;
  readonly examVersionId: ExamVersionId;
  readonly studentId: UserId;
  readonly assignedAt: string;
  readonly extraTimeSeconds: number;
  readonly examVersion: ExamVersionRecord;
}

export interface ExamAssignmentListRecord {
  readonly assignment: ExamAssignmentRecord;
  readonly attemptId: AttemptId | null;
  readonly attemptStatus: AttemptStatus | null;
}

export interface ExamAttemptRecord {
  readonly id: AttemptId;
  readonly assignmentId: AssignmentId;
  readonly attemptSeed: string;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly baseDeadline: string;
  readonly effectiveDeadline: string;
  readonly submittedAt: string | null;
  readonly expiredAt: string | null;
  readonly assignment: ExamAssignmentRecord;
}

export interface ExamQuestionRecord {
  readonly id: QuestionVersionId;
  readonly type: QuestionType;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  readonly position: number;
}

export interface ExamDeliveryRecord {
  readonly attempt: ExamAttemptRecord;
  readonly questions: readonly ExamQuestionRecord[];
  readonly answers: ExamAnswerSnapshotRecord;
}

export interface ExamAnswerSnapshotRecord {
  readonly revision: number;
  readonly savedAt: string | null;
  readonly answers: Readonly<Record<string, ExamAnswerValue>>;
}

export interface AttemptMutationRecord {
  readonly requestHash: string;
  readonly resultingRevision: number;
  readonly responseJson: string;
}

export interface NewExamRecord {
  readonly id: ExamId;
  readonly slug: string;
  readonly createdAt: string;
}

export interface NewExamVersionRecord {
  readonly id: ExamVersionId;
  readonly examId: ExamId;
  readonly versionNumber: number;
  readonly title: string;
  readonly durationSeconds: number;
  readonly status: ExamVersionStatus;
  readonly createdAt: string;
  readonly publishedAt: string | null;
}

export interface NewQuestionVersionRecord {
  readonly id: QuestionVersionId;
  readonly type: QuestionType;
  readonly prompt: string;
  readonly optionsJson: string;
  readonly answerKeyJson: string;
  readonly createdAt: string;
}

export interface NewAttemptRecord {
  readonly id: AttemptId;
  readonly assignmentId: AssignmentId;
  readonly attemptSeed: string;
  readonly startedAt: string;
  readonly baseDeadline: string;
  readonly effectiveDeadline: string;
}

function asOpaque<Brand extends string>(value: string): Opaque<string, Brand> {
  if (value.trim() === '') {
    throw new Error('Exam identifiers must not be empty.');
  }
  return value as Opaque<string, Brand>;
}

function readString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(message);
  }
  return value;
}

function readNullableString(value: unknown, message: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return readString(value, message);
}

function readInteger(value: unknown, message: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(message);
  }
  return parsed;
}

function readAnswer(value: unknown): ExamAnswerValue {
  const parsed = JSON.parse(
    readString(value, 'The database returned an invalid answer.'),
  ) as unknown;
  if (
    parsed === null ||
    typeof parsed === 'string' ||
    typeof parsed === 'boolean' ||
    (typeof parsed === 'number' && Number.isFinite(parsed))
  ) {
    return parsed;
  }
  throw new Error('The database returned an invalid answer.');
}

function isQuestionType(value: unknown): value is QuestionType {
  return (
    typeof value === 'string' &&
    ['multiple_choice', 'true_false', 'identification', 'numeric', 'short_answer'].includes(value)
  );
}

function isAttemptStatus(value: unknown): value is AttemptStatus {
  return value === 'in_progress' || value === 'submitted' || value === 'expired';
}

function isExamVersionStatus(value: unknown): value is ExamVersionStatus {
  return value === 'draft' || value === 'published';
}

function readOptions(value: unknown): readonly QuestionOption[] {
  const parsed: unknown = JSON.parse(readString(value, 'The database returned invalid options.'));
  if (!Array.isArray(parsed)) {
    throw new Error('The database returned invalid options.');
  }

  return parsed.map((option) => {
    if (
      typeof option !== 'object' ||
      option === null ||
      typeof option.id !== 'string' ||
      typeof option.text !== 'string'
    ) {
      throw new Error('The database returned invalid question options.');
    }
    return { id: option.id, text: option.text };
  });
}

function readExamVersion(row: Record<string, unknown>): ExamVersionRecord {
  const status = row.version_status;
  if (!isExamVersionStatus(status)) {
    throw new Error('The database returned an invalid exam version status.');
  }

  return {
    id: asOpaque<'ExamVersionId'>(readString(row.exam_version_id, 'Invalid exam version ID.')),
    examId: asOpaque<'ExamId'>(readString(row.exam_id, 'Invalid exam ID.')),
    versionNumber: readInteger(row.version_number, 'Invalid exam version number.'),
    title: readString(row.version_title, 'Invalid exam version title.'),
    durationSeconds: readInteger(row.duration_seconds, 'Invalid exam duration.'),
    status,
    createdAt: readString(row.version_created_at, 'Invalid exam version timestamp.'),
    publishedAt: readNullableString(row.published_at, 'Invalid publication timestamp.'),
  };
}

function readAssignment(row: Record<string, unknown>): ExamAssignmentRecord {
  return {
    id: asOpaque<'AssignmentId'>(readString(row.assignment_id, 'Invalid assignment ID.')),
    examVersionId: asOpaque<'ExamVersionId'>(
      readString(row.exam_version_id, 'Invalid assignment exam version ID.'),
    ),
    studentId: asOpaque<'UserId'>(readString(row.student_id, 'Invalid assignment student ID.')),
    assignedAt: readString(row.assigned_at, 'Invalid assignment timestamp.'),
    extraTimeSeconds: readInteger(row.extra_time_seconds, 'Invalid extra-time accommodation.'),
    examVersion: readExamVersion(row),
  };
}

function readAttempt(row: Record<string, unknown>): ExamAttemptRecord {
  const status = row.attempt_status;
  if (!isAttemptStatus(status)) {
    throw new Error('The database returned an invalid attempt status.');
  }

  return {
    id: asOpaque<'AttemptId'>(readString(row.attempt_id, 'Invalid attempt ID.')),
    assignmentId: asOpaque<'AssignmentId'>(
      readString(row.attempt_assignment_id, 'Invalid attempt assignment ID.'),
    ),
    attemptSeed: readString(row.attempt_seed, 'Invalid attempt seed.'),
    status,
    startedAt: readString(row.started_at, 'Invalid attempt start timestamp.'),
    baseDeadline: readString(row.base_deadline, 'Invalid attempt base deadline.'),
    effectiveDeadline: readString(row.effective_deadline, 'Invalid attempt deadline.'),
    submittedAt: readNullableString(row.submitted_at, 'Invalid submission timestamp.'),
    expiredAt: readNullableString(row.expired_at, 'Invalid expiration timestamp.'),
    assignment: readAssignment(row),
  };
}

function readQuestion(row: Record<string, unknown>): ExamQuestionRecord {
  if (!isQuestionType(row.question_type)) {
    throw new Error('The database returned an invalid question type.');
  }

  return {
    id: asOpaque<'QuestionVersionId'>(
      readString(row.question_version_id, 'Invalid question version ID.'),
    ),
    type: row.question_type,
    prompt: readString(row.prompt, 'Invalid question prompt.'),
    options: readOptions(row.options_json),
    position: readInteger(row.position, 'Invalid question position.'),
  };
}

export class ExamRepository {
  constructor(private readonly database: DatabaseSync) {}

  async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const value = await work();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original operation failure.
      }
      throw error;
    }
  }

  findExamById(id: ExamId): ExamRecord | null {
    const row = this.database
      .prepare('SELECT id, slug, created_at FROM exams WHERE id = ?')
      .get(id);
    if (row === undefined) {
      return null;
    }

    return {
      id: asOpaque<'ExamId'>(readString(row.id, 'Invalid exam ID.')),
      slug: readString(row.slug, 'Invalid exam slug.'),
      createdAt: readString(row.created_at, 'Invalid exam timestamp.'),
    };
  }

  findExamVersionById(id: ExamVersionId): ExamVersionRecord | null {
    const row = this.database
      .prepare(
        `SELECT id AS exam_version_id, exam_id, version_number, title AS version_title,
                duration_seconds, status AS version_status, created_at AS version_created_at,
                published_at
         FROM exam_versions
         WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? null : readExamVersion(row);
  }

  isStudent(userId: UserId): boolean {
    const row = this.database.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    return row?.role === ('student' satisfies UserRole);
  }

  insertExam(exam: NewExamRecord): void {
    this.database
      .prepare('INSERT INTO exams (id, slug, created_at) VALUES (?, ?, ?)')
      .run(exam.id, exam.slug, exam.createdAt);
  }

  insertExamVersion(version: NewExamVersionRecord): void {
    this.database
      .prepare(
        `INSERT INTO exam_versions
          (id, exam_id, version_number, title, duration_seconds, status, created_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.id,
        version.examId,
        version.versionNumber,
        version.title,
        version.durationSeconds,
        version.status,
        version.createdAt,
        version.publishedAt,
      );
  }

  publishExamVersion(id: ExamVersionId, publishedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE exam_versions
         SET status = 'published', published_at = ?
         WHERE id = ? AND status = 'draft'`,
      )
      .run(publishedAt, id);
    if (Number(result.changes) !== 1) {
      throw new Error('The exam version could not be published.');
    }
  }

  insertQuestionVersion(question: NewQuestionVersionRecord): void {
    this.database
      .prepare(
        `INSERT INTO question_versions
          (id, question_type, prompt, options_json, answer_key_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        question.id,
        question.type,
        question.prompt,
        question.optionsJson,
        question.answerKeyJson,
        question.createdAt,
      );
  }

  insertExamVersionQuestion(
    examVersionId: ExamVersionId,
    questionVersionId: QuestionVersionId,
    position: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO exam_version_questions
          (exam_version_id, question_version_id, position)
         VALUES (?, ?, ?)`,
      )
      .run(examVersionId, questionVersionId, position);
  }

  insertAssignment(
    id: AssignmentId,
    examVersionId: ExamVersionId,
    studentId: UserId,
    assignedAt: string,
    extraTimeSeconds: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO exam_assignments
          (id, exam_version_id, student_id, assigned_at, extra_time_seconds)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, examVersionId, studentId, assignedAt, extraTimeSeconds);
  }

  findAssignmentForStudent(id: AssignmentId, studentId: UserId): ExamAssignmentRecord | null {
    const row = this.database
      .prepare(
        `SELECT assignment.id AS assignment_id, assignment.exam_version_id,
                assignment.student_id, assignment.assigned_at, assignment.extra_time_seconds,
                version.exam_id, version.version_number, version.title AS version_title,
                version.duration_seconds, version.status AS version_status,
                version.created_at AS version_created_at, version.published_at
         FROM exam_assignments AS assignment
         JOIN exam_versions AS version ON version.id = assignment.exam_version_id
         WHERE assignment.id = ? AND assignment.student_id = ? AND version.status = 'published'`,
      )
      .get(id, studentId);
    return row === undefined ? null : readAssignment(row);
  }

  listAssignmentsForStudent(studentId: UserId): readonly ExamAssignmentListRecord[] {
    const rows = this.database
      .prepare(
        `SELECT assignment.id AS assignment_id, assignment.exam_version_id,
                assignment.student_id, assignment.assigned_at, assignment.extra_time_seconds,
                version.exam_id, version.version_number, version.title AS version_title,
                version.duration_seconds, version.status AS version_status,
                version.created_at AS version_created_at, version.published_at,
                attempt.id AS attempt_id, attempt.status AS attempt_status
         FROM exam_assignments AS assignment
         JOIN exam_versions AS version ON version.id = assignment.exam_version_id
         LEFT JOIN exam_attempts AS attempt ON attempt.assignment_id = assignment.id
         WHERE assignment.student_id = ? AND version.status = 'published'
         ORDER BY assignment.assigned_at, assignment.id`,
      )
      .all(studentId);

    return rows.map((row) => {
      const attemptStatus = row.attempt_status;
      if (attemptStatus !== null && !isAttemptStatus(attemptStatus)) {
        throw new Error('The database returned an invalid attempt status.');
      }
      return {
        assignment: readAssignment(row),
        attemptId:
          row.attempt_id === null || row.attempt_id === undefined
            ? null
            : asOpaque<'AttemptId'>(readString(row.attempt_id, 'Invalid attempt ID.')),
        attemptStatus: attemptStatus ?? null,
      };
    });
  }

  insertAttempt(attempt: NewAttemptRecord): void {
    this.database
      .prepare(
        `INSERT INTO exam_attempts
          (id, assignment_id, status, attempt_seed, started_at, base_deadline, effective_deadline)
         VALUES (?, ?, 'in_progress', ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.assignmentId,
        attempt.attemptSeed,
        attempt.startedAt,
        attempt.baseDeadline,
        attempt.effectiveDeadline,
      );
  }

  findAttemptByAssignmentForStudent(
    assignmentId: AssignmentId,
    studentId: UserId,
  ): ExamAttemptRecord | null {
    const row = this.database
      .prepare(this.attemptQuery('attempt.assignment_id = ? AND assignment.student_id = ?'))
      .get(assignmentId, studentId);
    return row === undefined ? null : readAttempt(row);
  }

  findAttemptForStudent(id: AttemptId, studentId: UserId): ExamAttemptRecord | null {
    const row = this.database
      .prepare(this.attemptQuery('attempt.id = ? AND assignment.student_id = ?'))
      .get(id, studentId);
    return row === undefined ? null : readAttempt(row);
  }

  findQuestionsForVersion(examVersionId: ExamVersionId): readonly ExamQuestionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT question.id AS question_version_id, question.question_type,
                question.prompt, question.options_json, membership.position
         FROM exam_version_questions AS membership
         JOIN question_versions AS question ON question.id = membership.question_version_id
         WHERE membership.exam_version_id = ?
         ORDER BY membership.position`,
      )
      .all(examVersionId);
    return rows.map(readQuestion);
  }

  findDeliveryForStudent(id: AttemptId, studentId: UserId): ExamDeliveryRecord | null {
    const attempt = this.findAttemptForStudent(id, studentId);
    if (attempt === null || attempt.assignment.examVersion.status !== 'published') {
      return null;
    }

    return {
      attempt,
      questions: this.findQuestionsForVersion(attempt.assignment.examVersion.id),
      answers: this.findAnswerSnapshot(id),
    };
  }

  findAnswerSnapshot(attemptId: AttemptId): ExamAnswerSnapshotRecord {
    const rows = this.database
      .prepare(
        `SELECT question_version_id, answer_json, revision, saved_at
         FROM attempt_answers
         WHERE attempt_id = ?
         ORDER BY question_version_id`,
      )
      .all(attemptId);
    const answers: Record<string, ExamAnswerValue> = {};
    let revision = 0;
    let savedAt: string | null = null;
    for (const row of rows) {
      const questionVersionId = readString(
        row.question_version_id,
        'Invalid answered question ID.',
      );
      const rowRevision = readInteger(row.revision, 'Invalid answer revision.');
      if (rowRevision <= 0) {
        throw new Error('Invalid answer revision.');
      }
      answers[questionVersionId] = readAnswer(row.answer_json);
      revision = Math.max(revision, rowRevision);
      savedAt = readString(row.saved_at, 'Invalid answer timestamp.');
    }
    return { revision, savedAt, answers };
  }

  replaceAttemptAnswers(
    attemptId: AttemptId,
    answers: Readonly<Record<string, ExamAnswerValue>>,
    revision: number,
    savedAt: string,
  ): void {
    this.database.prepare('DELETE FROM attempt_answers WHERE attempt_id = ?').run(attemptId);
    const insert = this.database.prepare(
      `INSERT INTO attempt_answers
        (attempt_id, question_version_id, answer_json, revision, saved_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [questionVersionId, answer] of Object.entries(answers)) {
      insert.run(attemptId, questionVersionId, JSON.stringify(answer), revision, savedAt);
    }
  }

  findAttemptMutation(
    attemptId: AttemptId,
    idempotencyKey: string,
    operation: 'save_answers' | 'submit_attempt',
  ): AttemptMutationRecord | null {
    const row = this.database
      .prepare(
        `SELECT request_hash, resulting_revision, response_json
         FROM attempt_mutations
         WHERE attempt_id = ? AND idempotency_key = ? AND operation = ?`,
      )
      .get(attemptId, idempotencyKey, operation);
    if (row === undefined) {
      return null;
    }
    return {
      requestHash: readString(row.request_hash, 'Invalid mutation hash.'),
      resultingRevision: readInteger(row.resulting_revision, 'Invalid mutation revision.'),
      responseJson: readString(row.response_json, 'Invalid mutation response.'),
    };
  }

  insertAttemptMutation(
    attemptId: AttemptId,
    idempotencyKey: string,
    operation: 'save_answers' | 'submit_attempt',
    requestHash: string,
    resultingRevision: number,
    responseJson: string,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO attempt_mutations
          (attempt_id, idempotency_key, operation, request_hash, resulting_revision, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        idempotencyKey,
        operation,
        requestHash,
        resultingRevision,
        responseJson,
        createdAt,
      );
  }

  expireAttemptIfDue(id: AttemptId, now: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE exam_attempts
         SET status = 'expired', expired_at = ?
         WHERE id = ? AND status = 'in_progress' AND effective_deadline <= ?`,
      )
      .run(now, id, now);
    return Number(result.changes) === 1;
  }

  expireDueAttemptsForStudent(studentId: UserId, now: string): void {
    this.database
      .prepare(
        `UPDATE exam_attempts
         SET status = 'expired', expired_at = ?
         WHERE status = 'in_progress' AND effective_deadline <= ?
           AND assignment_id IN (
             SELECT id FROM exam_assignments WHERE student_id = ?
           )`,
      )
      .run(now, now, studentId);
  }

  submitAttemptIfActive(id: AttemptId, now: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE exam_attempts
         SET status = 'submitted', submitted_at = ?
         WHERE id = ? AND status = 'in_progress' AND effective_deadline > ?`,
      )
      .run(now, id, now);
    return Number(result.changes) === 1;
  }

  private attemptQuery(condition: string): string {
    return `
      SELECT attempt.id AS attempt_id, attempt.assignment_id AS attempt_assignment_id,
             attempt.status AS attempt_status, attempt.attempt_seed, attempt.started_at,
             attempt.base_deadline, attempt.effective_deadline, attempt.submitted_at,
             attempt.expired_at,
             assignment.id AS assignment_id, assignment.exam_version_id,
             assignment.student_id, assignment.assigned_at, assignment.extra_time_seconds,
             version.exam_id, version.version_number, version.title AS version_title,
             version.duration_seconds, version.status AS version_status,
             version.created_at AS version_created_at, version.published_at
      FROM exam_attempts AS attempt
      JOIN exam_assignments AS assignment ON assignment.id = attempt.assignment_id
      JOIN exam_versions AS version ON version.id = assignment.exam_version_id
      WHERE ${condition} AND version.status = 'published'
    `;
  }
}

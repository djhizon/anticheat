/* global console, process */

import type { ExamVersionId } from '@exam-anti-cheat/contracts/exam';

import { loadConfig } from './config.js';
import { createAuthPlugin } from './modules/auth/auth.plugin.js';
import { createExamPlugin } from './modules/exam/exam.plugin.js';
import type { SeedQuestionInput } from './modules/exam/exam.service.js';
import { generateExamQuestions } from './modules/integrity/questionGenerator.js';

const demoEmail = process.env.DEMO_STUDENT_EMAIL ?? 'demo.student@example.test';
const demoPassword = process.env.DEMO_STUDENT_PASSWORD ?? 'Demo exam password 2026!';
const instructorEmail = process.env.DEMO_INSTRUCTOR_EMAIL ?? 'demo.instructor@example.test';
const instructorPassword = process.env.DEMO_INSTRUCTOR_PASSWORD ?? 'Demo instructor password 2026!';
const demoSlug = 'pack8-ai-exam';

function readString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(message);
  }
  return value;
}

async function seedDemo(): Promise<void> {
  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    throw new Error('The demo seed is disabled in production.');
  }

  const config = loadConfig(process.env);

  // ── Wipe old data so the browser shows fresh content ──────────────────────
  const auth = createAuthPlugin(config);
  console.log('🗑  Wiping old exam data…');
  const wipeStatements = [
    `DELETE FROM exam_attempt_mutations`,
    `DELETE FROM answer_revisions`,
    `DELETE FROM audio_sessions`,
    `DELETE FROM app_events`,
    `DELETE FROM keystroke_events`,
    `DELETE FROM gaze_events`,
    `DELETE FROM liveness_events`,
    `DELETE FROM liveness_challenges`,
    `DELETE FROM phone_enrollments`,
    `DELETE FROM voice_events`,
    `DELETE FROM exam_attempts`,
    `DELETE FROM exam_assignments`,
    `DELETE FROM question_versions`,
    `DELETE FROM exam_versions`,
    `DELETE FROM exam_questions`,
    `DELETE FROM exams`,
  ];
  for (const sql of wipeStatements) {
    try {
      auth.database.prepare(sql).run();
    } catch {
      // Table may not exist yet on a fresh DB — that's fine
    }
  }

  try {
    // ── Ensure demo student account exists ───────────────────────────────────
    let student = auth.repository.findUserByEmail(demoEmail);
    if (student === null) {
      await auth.service.register({ email: demoEmail, password: demoPassword });
      student = auth.repository.findUserByEmail(demoEmail);
    }
    if (student === null || student.role !== 'student') {
      throw new Error('The demo student account could not be prepared.');
    }

    // ── Ensure demo instructor account exists (registration only creates students) ──
    if (auth.repository.findUserByEmail(instructorEmail) === null) {
      await auth.service.register({ email: instructorEmail, password: instructorPassword });
    }
    auth.database
      .prepare(`UPDATE users SET role = 'instructor' WHERE email = ?`)
      .run(instructorEmail);

    const exam = createExamPlugin(auth.database, auth.boundary, config);

    // ── Generate questions with Gemini ───────────────────────────────────────
    let generatedResult: Awaited<ReturnType<typeof generateExamQuestions>>;
    let questions: readonly SeedQuestionInput[] = [];
    let examDuration = 3600;

    if (config.geminiKeys.length > 0) {
      console.log('🤖  Generating exam questions with Gemini gemini-3.6-flash…');
      console.log('    (using keys 0-4 for generation, keys 5-9 reserved for AI-check)');
      try {
        generatedResult = await generateExamQuestions(config.geminiKeys, {
          topic: 'Computer Science fundamentals — networking, algorithms, databases, and security',
          count: 10,
          difficulty: 'medium',
          types: ['multiple_choice', 'true_false', 'identification', 'short_answer', 'numeric'],
        });
        questions = generatedResult.questions;
        examDuration = generatedResult.estimatedDurationSeconds;
        console.log(`✅  Generated ${questions.length} questions (Est time: ${examDuration}s)`);
      } catch (err) {
        console.warn(
          '⚠️  Gemini generation failed, falling back to static questions:',
          err instanceof Error ? err.message : err,
        );
        questions = FALLBACK_QUESTIONS;
      }
    } else {
      console.log('ℹ️  No GEMINI_API_KEYS — using static fallback questions');
      questions = FALLBACK_QUESTIONS;
    }

    // ── Seed the exam ────────────────────────────────────────────────────────
    let examVersionId: ExamVersionId;
    const existingVersion = auth.database
      .prepare(
        `SELECT id FROM exam_versions
         WHERE exam_id = (SELECT id FROM exams WHERE slug = ?)
           AND status = 'published'
         ORDER BY version_number DESC LIMIT 1`,
      )
      .get(demoSlug);

    if (existingVersion !== undefined) {
      examVersionId = readString(
        existingVersion.id,
        'The demo exam version is invalid.',
      ) as ExamVersionId;
    } else {
      const seeded = await exam.service.seedPublishedExam({
        slug: demoSlug,
        title: '🤖 AI-Generated Exam — Pack 8',
        versionNumber: 1,
        durationSeconds: examDuration,
        questions: [...questions],
      });
      examVersionId = seeded.examVersionId;
    }

    const existingAssignment = auth.database
      .prepare(
        `SELECT id FROM exam_assignments
         WHERE exam_version_id = ? AND student_id = ?`,
      )
      .get(examVersionId, student.id);
    if (existingAssignment === undefined) {
      await exam.service.assignExam({ examVersionId, studentId: student.id });
    }

    console.log('');
    console.log('──────────────────────────────────────────');
    console.log(`✅  Demo student:  ${demoEmail}`);
    console.log(`✅  Demo password: ${demoPassword}`);
    console.log(`✅  Instructor:    ${instructorEmail} / ${instructorPassword}`);
    console.log(`✅  Exam:          🤖 AI-Generated Exam — Pack 8`);
    console.log(`✅  Questions:     ${questions.length}`);
    console.log('──────────────────────────────────────────');
    console.log('   Open http://127.0.0.1:5173 to test');
    console.log('   Hard-refresh the browser (Cmd+Shift+R) to clear old data');
    console.log('──────────────────────────────────────────');
  } finally {
    auth.close();
  }
}

// ── Static fallback questions (used when no API keys) ─────────────────────────
const FALLBACK_QUESTIONS = [
  {
    type: 'multiple_choice' as const,
    prompt: 'Which OSI layer handles logical addressing and routing?',
    options: [
      { id: 'a', text: 'Data Link (Layer 2)' },
      { id: 'b', text: 'Network (Layer 3)' },
      { id: 'c', text: 'Transport (Layer 4)' },
      { id: 'd', text: 'Session (Layer 5)' },
    ],
    answerKey: 'b',
  },
  {
    type: 'true_false' as const,
    prompt: 'A hash function is reversible given enough computing power.',
    answerKey: false,
  },
  {
    type: 'identification' as const,
    prompt:
      'Name the sorting algorithm with average time complexity O(n log n) that uses a pivot element.',
    answerKey: 'Quicksort',
  },
  {
    type: 'numeric' as const,
    prompt: 'How many bits are in an IPv4 address?',
    answerKey: 32,
  },
  {
    type: 'short_answer' as const,
    prompt:
      'Explain the difference between symmetric and asymmetric encryption in two to three sentences.',
    answerKey:
      'Symmetric encryption uses the same key for encryption and decryption, making it fast but requiring secure key exchange. Asymmetric encryption uses a key pair — a public key to encrypt and a private key to decrypt — eliminating the need to share a secret key. Asymmetric is slower but enables secure communication over untrusted channels.',
  },
  {
    type: 'multiple_choice' as const,
    prompt: 'Which SQL clause filters rows after grouping?',
    options: [
      { id: 'a', text: 'WHERE' },
      { id: 'b', text: 'HAVING' },
      { id: 'c', text: 'ORDER BY' },
      { id: 'd', text: 'DISTINCT' },
    ],
    answerKey: 'b',
  },
  {
    type: 'true_false' as const,
    prompt: 'TCP guarantees packet delivery order; UDP does not.',
    answerKey: true,
  },
  {
    type: 'identification' as const,
    prompt: 'What data structure gives O(1) average-case lookup by key?',
    answerKey: 'Hash table',
  },
  {
    type: 'numeric' as const,
    prompt: 'What is the maximum number of nodes in a binary tree of height 3?',
    answerKey: 15,
  },
  {
    type: 'short_answer' as const,
    prompt: 'Describe what SQL injection is and name one mitigation technique.',
    answerKey:
      'SQL injection is a security vulnerability where an attacker inserts malicious SQL code into an input field, causing the database to execute unintended commands. One mitigation is using parameterized queries (prepared statements), which separate SQL code from user input.',
  },
] as const;

void seedDemo().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'The demo seed failed.');
  process.exitCode = 1;
});

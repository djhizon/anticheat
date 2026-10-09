/**
 * AI question generator using Gemini gemini-3.6-flash.
 * Uses the FIRST 5 keys (indices 0-4) — the last 5 are reserved for AI-check & liveness.
 * Generates realistic exam questions on any topic.
 */

import { GeminiRotatingClient } from './gemini.js';

export interface GeneratedQuestion {
  readonly type: 'multiple_choice' | 'true_false' | 'identification' | 'numeric' | 'short_answer';
  readonly prompt: string;
  readonly options?: Array<{ id: string; text: string }>;
  readonly answerKey: string | number | boolean;
}

export interface GenerateQuestionsOptions {
  readonly topic: string;
  readonly count?: number;
  readonly difficulty?: 'easy' | 'medium' | 'hard';
  readonly types?: Array<GeneratedQuestion['type']>;
  readonly model?: string;
  readonly embeddingModel?: string;
}

const FALLBACK_EXAM_QUESTIONS = [
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
] satisfies readonly GeneratedQuestion[];

/** Return fresh objects so callers cannot mutate the shared fallback fixture. */
export function createFallbackExamQuestions(): readonly GeneratedQuestion[] {
  return FALLBACK_EXAM_QUESTIONS.map((question) => ({
    ...question,
    ...(question.options === undefined
      ? {}
      : { options: question.options.map((option) => ({ ...option })) }),
  }));
}

const QUESTION_GEN_PROMPT = (opts: GenerateQuestionsOptions) =>
  `
You are an exam question writer for a university-level course.
Generate exactly ${opts.count ?? 10} exam questions about: "${opts.topic}"
Difficulty: ${opts.difficulty ?? 'medium'}

Question types to include (mix them): ${(opts.types ?? ['multiple_choice', 'true_false', 'identification', 'short_answer']).join(', ')}

Rules:
- Questions must be clear, unambiguous, and academically appropriate
- multiple_choice: provide exactly 3-4 options with ids "a","b","c","d"
- true_false: answer must be boolean true or false
- identification: answer is a single word or short phrase (max 5 words)
- numeric: answer must be a number
- short_answer: requires 1-3 sentence written response; answer key is a model answer
- Do NOT repeat question types consecutively more than twice
- Make questions test genuine understanding, not just memorization

Return ONLY valid JSON array with this exact shape, no markdown:
[
  {
    "type": "multiple_choice",
    "prompt": "Question text here?",
    "options": [{"id":"a","text":"Option A"},{"id":"b","text":"Option B"},{"id":"c","text":"Option C"}],
    "answerKey": "a"
  },
  {
    "type": "true_false",
    "prompt": "Statement to evaluate.",
    "answerKey": true
  },
  {
    "type": "identification",
    "prompt": "What is...?",
    "answerKey": "Answer"
  },
  {
    "type": "short_answer",
    "prompt": "Explain in your own words...",
    "answerKey": "Model answer paragraph."
  }
]
`.trim();

export async function generateExamQuestions(
  apiKeys: readonly string[],
  opts: GenerateQuestionsOptions,
): Promise<{ questions: readonly GeneratedQuestion[]; estimatedDurationSeconds: number }> {
  const genKeys = apiKeys.slice(0, 5).filter((k) => k.length > 0);
  if (genKeys.length === 0) {
    throw new Error('No Gemini API keys available for question generation.');
  }

  const gemini = new GeminiRotatingClient({
    keys: genKeys,
    model: opts.model ?? 'gemini-3.6-flash',
    embeddingModel: opts.embeddingModel ?? 'gemini-embedding-001',
  });

  const count = opts.count ?? 10;
  const prompt = QUESTION_GEN_PROMPT({ ...opts, count });

  let allQuestions = [];
  if (count > 5) {
    const batchSize = 5;
    let remaining = count;
    while (remaining > 0) {
      const thisBatch = Math.min(batchSize, remaining);
      const batchPrompt = QUESTION_GEN_PROMPT({ ...opts, count: thisBatch });
      const raw = await gemini.generateContent(batchPrompt);
      const parsed = parseQuestions(raw);
      allQuestions.push(...parsed);
      remaining -= thisBatch;
      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    allQuestions = allQuestions.slice(0, count);
  } else {
    const raw = await gemini.generateContent(prompt);
    allQuestions = parseQuestions(raw);
  }

  const estPrompt = `Given this exam consisting of ${allQuestions.length} questions of varying types, estimate a generous, relaxed time limit (in seconds) for a student to complete it. Provide ONLY the raw integer number of seconds, nothing else:\n\n${JSON.stringify(allQuestions, null, 2)}`;
  let estSecs = 3600;
  try {
    const estRaw = await gemini.generateContent(estPrompt);
    const parsedSecs = parseInt(estRaw.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(parsedSecs) && parsedSecs > 0) {
      estSecs = parsedSecs;
    }
  } catch (e) {
    console.error('Failed to estimate time, defaulting to 3600', e);
  }

  return { questions: allQuestions, estimatedDurationSeconds: estSecs };
}

function parseQuestions(raw: string): GeneratedQuestion[] {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned) as unknown[];
  if (!Array.isArray(parsed)) throw new Error('Gemini returned non-array for questions');

  return parsed.map((q): GeneratedQuestion => {
    const item = q as Record<string, unknown>;
    const type = String(item.type ?? 'short_answer') as GeneratedQuestion['type'];
    const result: GeneratedQuestion = {
      type,
      prompt: String(item.prompt ?? ''),
      answerKey: item.answerKey as string | number | boolean,
    };
    if (Array.isArray(item.options)) {
      return { ...result, options: item.options as Array<{ id: string; text: string }> };
    }
    return result;
  });
}

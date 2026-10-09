/**
 * Cross-student answer similarity using Gemini embeddings + cosine similarity.
 * Run post-exam by instructor. Clusters answers per question and flags close pairs.
 */

import type { GeminiRotatingClient } from './gemini.js';

export interface SimilarityPair {
  readonly studentAId: string;
  readonly studentBId: string;
  readonly score: number; // 0.0 – 1.0
  readonly flagged: boolean; // score > threshold
}

export interface SimilarityReport {
  readonly questionId: string;
  readonly pairs: readonly SimilarityPair[];
  readonly threshold: number;
  readonly generatedAt: string;
}

const SIMILARITY_THRESHOLD = 0.92;

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function computeSimilarityReport(
  gemini: GeminiRotatingClient,
  questionId: string,
  answers: ReadonlyArray<{ readonly studentId: string; readonly text: string }>,
  threshold = SIMILARITY_THRESHOLD,
): Promise<SimilarityReport> {
  if (answers.length < 2) {
    return {
      questionId,
      pairs: [],
      threshold,
      generatedAt: new Date().toISOString(),
    };
  }

  // Embed all answers (rate-limit friendly: sequential with small delay)
  const embeddings: Array<readonly number[]> = [];
  for (const answer of answers) {
    const embedding = await gemini.embedText(answer.text);
    embeddings.push(embedding);
    await new Promise((r) => setTimeout(r, 100)); // 100ms between embeds
  }

  // Compute all pairs
  const pairs: SimilarityPair[] = [];
  for (let i = 0; i < answers.length; i++) {
    for (let j = i + 1; j < answers.length; j++) {
      const score = cosineSimilarity(embeddings[i]!, embeddings[j]!);
      pairs.push({
        studentAId: answers[i]!.studentId,
        studentBId: answers[j]!.studentId,
        score: Math.round(score * 1000) / 1000,
        flagged: score > threshold,
      });
    }
  }

  // Sort by similarity descending
  pairs.sort((a, b) => b.score - a.score);

  return {
    questionId,
    pairs,
    threshold,
    generatedAt: new Date().toISOString(),
  };
}

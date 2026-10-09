/**
 * AI-generation pattern checker using Gemini gemini-3.6-flash.
 * Sends the exact question + student answer verbatim. Returns a structured report.
 * No auto-penalty — results shown to instructor only.
 */

import type { GeminiRotatingClient } from './gemini.js';

export interface AiCheckFlag {
  readonly phrase: string;
  readonly reason: string;
}

export interface AiCheckReport {
  readonly score: number; // 0.0 (human) – 1.0 (very likely AI)
  readonly flags: readonly AiCheckFlag[];
  readonly summary: string;
  readonly checkedAt: string;
}

const SYSTEM_PROMPT = `You are an academic integrity assistant reviewing student exam answers.
Analyse the answer for signs of AI generation. Consider:
- Generic templated phrasing ("In conclusion", "It is important to note", "This demonstrates that")
- Unnaturally uniform sentence length and structure
- Vocabulary that is improbably advanced for the context
- Complete absence of personal voice, hedging, or uncertainty
- Over-structured bullet-point thinking in a written answer
- Ideas that exactly match common AI responses for this topic

Return ONLY valid JSON with this exact shape:
{
  "score": <number 0.0-1.0>,
  "flags": [{"phrase": "<exact phrase from answer>", "reason": "<why suspicious>"}],
  "summary": "<one sentence assessment>"
}

score 0.0 = clearly human, 0.5 = ambiguous, 1.0 = very likely AI-generated.
If the answer is too short to assess, return score 0.0 with empty flags.`;

export async function checkForAiGeneration(
  gemini: GeminiRotatingClient,
  question: string,
  answer: string,
): Promise<AiCheckReport> {
  const prompt = `${SYSTEM_PROMPT}

QUESTION: ${question}

STUDENT ANSWER: ${answer}`;

  try {
    const raw = await gemini.generateContent(prompt);
    // Strip markdown code fences if Gemini wraps in ```json
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned) as {
      score: number;
      flags: { phrase: string; reason: string }[];
      summary: string;
    };

    return {
      score: Math.min(1, Math.max(0, Number(parsed.score) || 0)),
      flags: Array.isArray(parsed.flags)
        ? parsed.flags.map((f) => ({ phrase: String(f.phrase), reason: String(f.reason) }))
        : [],
      summary: String(parsed.summary ?? 'No summary available.'),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      score: 0,
      flags: [],
      summary: `AI check unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
      checkedAt: new Date().toISOString(),
    };
  }
}

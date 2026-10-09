/**
 * Gemini API client with round-robin key rotation across multiple API keys.
 * Model: gemini-3.6-flash for generation, gemini-embedding-001 for embeddings.
 */

export interface GeminiConfig {
  readonly keys: readonly string[];
  readonly model: string;
  readonly embeddingModel: string;
  /** Tried in order when the primary is overloaded after retries or retired (404). */
  readonly fallbackModels?: readonly string[];
}

export interface GeminiPart {
  readonly text?: string;
  readonly inlineData?: {
    readonly mimeType: string;
    readonly data: string; // base64
  };
}

export interface GeminiContent {
  readonly role: 'user' | 'model';
  readonly parts: readonly GeminiPart[];
}

export interface GeminiGenerateRequest {
  readonly contents: readonly GeminiContent[];
  readonly generationConfig?: {
    readonly responseMimeType?: string;
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
  };
}

export interface GeminiEmbedRequest {
  readonly content: { readonly parts: readonly { readonly text: string }[] };
  readonly taskType?: string;
}

export interface GeminiGenerateResponse {
  readonly candidates: readonly {
    readonly content: { readonly parts: readonly { readonly text: string }[] };
    readonly finishReason: string;
  }[];
}

export interface GeminiEmbedResponse {
  readonly embedding: { readonly values: readonly number[] };
}

const RETRYABLE_STATUS = new Set([429, 500, 503]);
export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
const DEFAULT_FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.8-flash,gemini-3.5-flash'
)
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const SWITCH_MODEL = /Gemini API error (404|429|500|503)/u;

export class GeminiRotatingClient {
  private index = 0;

  constructor(private readonly config: GeminiConfig) {
    if (config.keys.length === 0) {
      throw new Error('At least one Gemini API key is required.');
    }
  }

  private nextKey(): string {
    const key = this.config.keys[this.index % this.config.keys.length];
    this.index = (this.index + 1) % this.config.keys.length;
    return key!;
  }

  private async fetchGemini(endpoint: string, body: unknown, retries = 3): Promise<unknown> {
    const url = `https://generativelanguage.googleapis.com/v1beta/${endpoint}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      // A fresh key per attempt, sent as a header so it never lands in URLs or logs.
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.nextKey() },
        body: JSON.stringify(body),
        // Thinking models can take well over 30s to generate a full exam.
        signal: AbortSignal.timeout(90_000),
      });

      if (response.ok) {
        return response.json() as unknown;
      }

      // Rate limits and transient overloads: back off, then retry on the next key.
      if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }

      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`Gemini API error ${response.status}: ${errorText.slice(0, 300)}`);
    }

    throw new Error('Gemini API: all retries exhausted.');
  }

  async generateContent(prompt: string, imageBase64?: string): Promise<string> {
    const parts: GeminiPart[] = imageBase64
      ? [{ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }, { text: prompt }]
      : [{ text: prompt }];

    const request: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        // Thinking models spend ~500+ tokens reasoning before the JSON answer, and a
        // 10-question exam needs several thousand more; this is a cap, not a cost.
        maxOutputTokens: 8192,
      },
    };

    const models = [
      this.config.model,
      ...(this.config.fallbackModels ?? DEFAULT_FALLBACK_MODELS).filter(
        (model) => model !== this.config.model,
      ),
    ];
    let response: GeminiGenerateResponse | null = null;
    let lastError: unknown = null;
    for (const model of models) {
      try {
        response = (await this.fetchGemini(
          `models/${model}:generateContent`,
          request,
        )) as GeminiGenerateResponse;
        break;
      } catch (error) {
        lastError = error;
        // Only overloads and retired models move on to the next model.
        if (!(error instanceof Error && SWITCH_MODEL.test(error.message))) throw error;
      }
    }
    if (response === null) throw lastError;

    const text = response.candidates[0]?.content?.parts[0]?.text;
    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
  }

  async embedText(text: string): Promise<readonly number[]> {
    const request: GeminiEmbedRequest = {
      content: { parts: [{ text }] },
      taskType: 'SEMANTIC_SIMILARITY',
    };

    const response = (await this.fetchGemini(
      `models/${this.config.embeddingModel}:embedContent`,
      request,
    )) as GeminiEmbedResponse;

    return response.embedding.values;
  }
}

export function loadGeminiConfig(): GeminiConfig {
  const raw = process.env.GEMINI_API_KEYS ?? '';
  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (keys.length === 0) {
    console.warn('[gemini] No GEMINI_API_KEYS set — AI checks will be disabled.');
  }

  return {
    keys,
    model: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
  };
}

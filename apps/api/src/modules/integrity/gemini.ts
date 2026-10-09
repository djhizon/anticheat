/**
 * Gemini API client with round-robin key rotation across multiple API keys.
 * Model: gemini-3.6-flash for generation, gemini-embedding-exp-03-07 for embeddings.
 */

export interface GeminiConfig {
  readonly keys: readonly string[];
  readonly model: string;
  readonly embeddingModel: string;
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

  private async fetchGemini(endpoint: string, body: unknown, retries = 2): Promise<unknown> {
    const key = this.nextKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/${endpoint}?key=${key}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        return response.json() as unknown;
      }

      // Rate limit — rotate to next key and retry
      if (response.status === 429 && attempt < retries) {
        this.index = (this.index + 1) % this.config.keys.length;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }

      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
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
        maxOutputTokens: 1024,
      },
    };

    const response = (await this.fetchGemini(
      `models/${this.config.model}:generateContent`,
      request,
    )) as GeminiGenerateResponse;

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
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-exp-03-07',
  };
}

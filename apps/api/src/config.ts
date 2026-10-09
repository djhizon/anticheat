export const DEFAULT_API_PORT = 3000;
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'] as const;
export const DEFAULT_FRESH_EXAM_GENERATION_ENABLED = true;

export interface ApiConfig {
  readonly port: number;
  readonly databasePath: string;
  readonly allowedOrigins: readonly string[];
  readonly sessionTtlSeconds: number;
  readonly secureCookies: boolean;
  readonly sessionCookieName: string;
  readonly csrfCookieName: string;
  readonly csrfHeaderName: string;
  readonly freshExamGenerationEnabled: boolean;
  readonly geminiKeys: readonly string[];
  readonly geminiModel: string;
  readonly geminiEmbeddingModel: string;
  readonly audioRetainDays: number;
  readonly livenessFlashThreshold: number;
  readonly livenessNoiseThreshold: number;
  readonly livenessJitterThreshold: number;
  readonly msTenantId: string | undefined;
  readonly msClientId: string | undefined;
  readonly msClientSecret: string | undefined;
  readonly msTargetEmail: string | undefined;
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be either true or false.`);
}

function normalizeOrigin(value: string, httpsOnly: boolean): string {
  const parsed = new URL(value);

  if (
    parsed.origin === 'null' ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    (httpsOnly && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`Invalid allowed origin: ${value}`);
  }

  return parsed.origin;
}

function parseAllowedOrigins(value: string | undefined, environment: string): readonly string[] {
  const httpsOnly = environment === 'production';
  if (httpsOnly && (value === undefined || value.trim() === '')) {
    throw new Error(
      'ALLOWED_ORIGINS must be explicitly configured with HTTPS origins in production.',
    );
  }

  const rawOrigins = (value === undefined ? DEFAULT_ALLOWED_ORIGINS.join(',') : value)
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  if (rawOrigins.length === 0) {
    throw new Error('At least one allowed origin is required.');
  }

  return rawOrigins.map((origin) => normalizeOrigin(origin, httpsOnly));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const environment = env.NODE_ENV ?? 'development';
  const secureCookies = parseBoolean(
    env.COOKIE_SECURE,
    environment === 'production',
    'COOKIE_SECURE',
  );

  if (environment === 'production' && !secureCookies) {
    throw new Error('COOKIE_SECURE must remain true in production.');
  }

  const freshExamGenerationEnabled = parseBoolean(
    env.ENABLE_FRESH_EXAM_GENERATION,
    environment === 'production' ? false : DEFAULT_FRESH_EXAM_GENERATION_ENABLED,
    'ENABLE_FRESH_EXAM_GENERATION',
  );
  if (environment === 'production' && freshExamGenerationEnabled) {
    throw new Error('ENABLE_FRESH_EXAM_GENERATION must remain false in production.');
  }

  return {
    port: parseInteger(env.PORT, DEFAULT_API_PORT, 'PORT'),
    databasePath: env.DATABASE_PATH?.trim() || './data/exam-anti-cheat.sqlite',
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS, environment),
    sessionTtlSeconds: parseInteger(
      env.SESSION_TTL_SECONDS,
      DEFAULT_SESSION_TTL_SECONDS,
      'SESSION_TTL_SECONDS',
    ),
    secureCookies,
    sessionCookieName: 'eac_session',
    csrfCookieName: 'eac_csrf',
    csrfHeaderName: 'x-csrf-token',
    freshExamGenerationEnabled,
    geminiKeys: env.GEMINI_API_KEYS ? env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(k => k !== '') : [],
    geminiModel: env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash',
    geminiEmbeddingModel: env.GEMINI_EMBEDDING_MODEL?.trim() || 'gemini-embedding-exp-03-07',
    audioRetainDays: env.AUDIO_RETAIN_DAYS ? parseInteger(env.AUDIO_RETAIN_DAYS, 30, 'AUDIO_RETAIN_DAYS') : 30,
    livenessFlashThreshold: env.LIVENESS_FLASH_THRESHOLD ? parseFloat(env.LIVENESS_FLASH_THRESHOLD) : 8.0,
    livenessNoiseThreshold: env.LIVENESS_NOISE_THRESHOLD ? parseFloat(env.LIVENESS_NOISE_THRESHOLD) : 3.0,
    livenessJitterThreshold: env.LIVENESS_JITTER_THRESHOLD ? parseFloat(env.LIVENESS_JITTER_THRESHOLD) : 0.15,
    msTenantId: env.MS_TENANT_ID,
    msClientId: env.MS_CLIENT_ID,
    msClientSecret: env.MS_CLIENT_SECRET,
    msTargetEmail: env.MS_RECORDING_TARGET_EMAIL,
  };
}

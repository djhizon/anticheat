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
  readonly backendVisionEnabled: boolean;
  readonly geminiKeys: readonly string[];
  readonly geminiModel: string;
  readonly geminiEmbeddingModel: string;
  readonly audioRetainDays: number;
  /** Days before evidence snapshots are deleted; 0 keeps them until the attempt is removed. */
  readonly evidenceRetainDays: number;
  /**
   * Default for exams without their own setting (`RECORDING_UPLOAD=on|off`): whether screen
   * recording segments may be uploaded to OneDrive or must stay on the student's computer.
   */
  readonly recordingUploadDefault: boolean;
  readonly livenessFlashThreshold: number;
  readonly livenessNoiseThreshold: number;
  readonly livenessJitterThreshold: number;
  readonly msTenantId: string | undefined;
  readonly msClientId: string | undefined;
  readonly msClientSecret: string | undefined;
  readonly msTargetEmail: string | undefined;
  readonly authProvider: 'local' | 'supabase';
  readonly supabaseUrl: string | undefined;
  readonly supabaseAnonKey: string | undefined;
  /** Public web origin used for links in Supabase emails (`/account/confirm`). */
  readonly siteUrl: string;
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

function parseRecordingUpload(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === '' || normalized === 'on') return true;
  if (normalized === 'off') return false;
  throw new Error('RECORDING_UPLOAD must be either on or off.');
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

/** Blank values and `<placeholder>` template values count as unset. */
function optionalSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' || trimmed.includes('<') ? undefined : trimmed;
}

function parseSupabaseUrl(value: string, httpsOnly: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL.');
  }
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && !httpsOnly)) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      httpsOnly
        ? 'SUPABASE_URL must be an https URL in production.'
        : 'SUPABASE_URL must be an http(s) URL without credentials.',
    );
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/u, '');
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

  const rawSupabaseUrl = optionalSecret(env.SUPABASE_URL);
  const supabaseAnonKey = optionalSecret(env.SUPABASE_ANON_KEY);
  if ((rawSupabaseUrl === undefined) !== (supabaseAnonKey === undefined)) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be configured together.');
  }
  const supabaseUrl =
    rawSupabaseUrl === undefined
      ? undefined
      : parseSupabaseUrl(rawSupabaseUrl, environment === 'production');
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS, environment);
  const rawSiteUrl = optionalSecret(env.SITE_URL);
  const siteUrl =
    rawSiteUrl === undefined
      ? (allowedOrigins[0] as string)
      : normalizeOrigin(rawSiteUrl, environment === 'production');

  return {
    port: parseInteger(env.PORT, DEFAULT_API_PORT, 'PORT'),
    databasePath: env.DATABASE_PATH?.trim() || './data/exam-anti-cheat.sqlite',
    allowedOrigins,
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
    backendVisionEnabled: parseBoolean(env.ENABLE_BACKEND_VISION, false, 'ENABLE_BACKEND_VISION'),
    geminiKeys: env.GEMINI_API_KEYS
      ? env.GEMINI_API_KEYS.split(',')
          .map((k) => k.trim())
          .filter((k) => k !== '')
      : [],
    geminiModel: env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash',
    geminiEmbeddingModel: env.GEMINI_EMBEDDING_MODEL?.trim() || 'gemini-embedding-001',
    audioRetainDays: env.AUDIO_RETAIN_DAYS
      ? parseInteger(env.AUDIO_RETAIN_DAYS, 30, 'AUDIO_RETAIN_DAYS')
      : 30,
    evidenceRetainDays: env.EVIDENCE_RETAIN_DAYS
      ? parseInteger(env.EVIDENCE_RETAIN_DAYS, 30, 'EVIDENCE_RETAIN_DAYS')
      : 30,
    recordingUploadDefault: parseRecordingUpload(env.RECORDING_UPLOAD),
    livenessFlashThreshold: env.LIVENESS_FLASH_THRESHOLD
      ? parseFloat(env.LIVENESS_FLASH_THRESHOLD)
      : 8.0,
    livenessNoiseThreshold: env.LIVENESS_NOISE_THRESHOLD
      ? parseFloat(env.LIVENESS_NOISE_THRESHOLD)
      : 3.0,
    livenessJitterThreshold: env.LIVENESS_JITTER_THRESHOLD
      ? parseFloat(env.LIVENESS_JITTER_THRESHOLD)
      : 0.15,
    msTenantId: env.MS_TENANT_ID,
    msClientId: env.MS_CLIENT_ID,
    msClientSecret: env.MS_CLIENT_SECRET,
    msTargetEmail: env.MS_RECORDING_TARGET_EMAIL,
    authProvider: supabaseUrl === undefined ? 'local' : 'supabase',
    supabaseUrl,
    supabaseAnonKey,
    siteUrl,
  };
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const apiRoot = fileURLToPath(new URL('../../../', import.meta.url));

export class TranscriptionError extends Error {}

const MAX_CLIP_BYTES = 1024 * 1024;
/** Same 6 s cap the ffmpeg path applies with `-t 6`. */
const MAX_CLIP_MS = 6000;

/**
 * Named models (WHISPER_MODEL) and their ggml files. Keep in sync with
 * scripts/whisper-models.sh, which downloads and checksums them.
 */
export const WHISPER_MODELS = {
  'large-v3-turbo': 'ggml-large-v3-turbo-q5_0.bin',
  'small.en': 'ggml-small.en-q5_1.bin',
  'large-v3': 'ggml-large-v3-q5_0.bin',
  base: 'ggml-base-q5_1.bin',
} as const;
export type WhisperModelName = keyof typeof WHISPER_MODELS;
export const DEFAULT_WHISPER_MODEL: WhisperModelName = 'small.en';
const DEFAULT_PROMPT = 'Exam room. English speech.';

function isModelName(value: string): value is WhisperModelName {
  return Object.prototype.hasOwnProperty.call(WHISPER_MODELS, value);
}

/** WHISPER_MODEL_PATH wins; otherwise the named model (unknown names fall back to the default). */
export function resolveWhisperModelPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WHISPER_MODEL_PATH) return env.WHISPER_MODEL_PATH;
  const requested = (env.WHISPER_MODEL ?? '').trim();
  const name = isModelName(requested) ? requested : DEFAULT_WHISPER_MODEL;
  return path.join(apiRoot, 'vendor/whisper.cpp/models', WHISPER_MODELS[name]);
}

/** Spoken language: English unless WHISPER_LANGUAGE names another code or `auto`. */
export function whisperLanguage(env: NodeJS.ProcessEnv = process.env): string {
  const value = (env.WHISPER_LANGUAGE ?? '').trim().toLowerCase();
  return /^(auto|[a-z]{2,3})$/.test(value) ? value : 'en';
}

/** Decoding prompt; WHISPER_PROMPT overrides it and an empty value turns it off. */
export function whisperPrompt(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.WHISPER_PROMPT ?? DEFAULT_PROMPT;
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** whisper-cli arguments for one clip (exported for tests). */
export function whisperArgs(
  modelPath: string,
  wav: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // Greedy decoding keeps CPU time bounded. The language is pinned (auto-detect
  // misread short or quiet clips as other languages), non-speech tokens such as
  // "[MUSIC]" are suppressed, and segments whisper itself rates as probably
  // silent are dropped (--no-speech-thold).
  const args = [
    '-m',
    modelPath,
    '-f',
    wav,
    '-d',
    String(MAX_CLIP_MS),
    '-nt',
    '-bo',
    '1',
    '-bs',
    '1',
    '-l',
    whisperLanguage(env),
    '-sns',
    '-nth',
    '0.6',
  ];
  const prompt = whisperPrompt(env);
  if (prompt) args.push('--prompt', prompt);
  // Opt-in speed-up: encode only the first N of 1500 frames (20 ms each) instead
  // of a 30 s window. 512 covers a 6 s clip and cuts encoder time two- to three-fold,
  // at some accuracy risk, so it is off by default. Must cover the clip (>= 320).
  const audioCtx = Number(env.WHISPER_AUDIO_CTX);
  if (Number.isInteger(audioCtx) && audioCtx >= 320 && audioCtx < 1500)
    args.push('-ac', String(audioCtx));
  if (!useWhisperGpu(env)) args.push('-ng');
  return args;
}

// Whole-clip outputs Whisper is known to invent for silence, room noise or music.
const HALLUCINATED_PHRASES = new Set([
  'you',
  'you know',
  'thank you',
  'thank you very much',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'bye',
  'the',
]);

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a transcript carries no speech: only bracketed tags ("[MUSIC]",
 * "(upbeat music)", "[BLANK_AUDIO]", "*sigh*", music notes), a known silence
 * hallucination ("you", "Thank you."), an echo of the decoding prompt, or one
 * token repeated ("the the the"). Such clips stay out of the timeline.
 */
export function isNonSpeechTranscript(text: string, prompt = whisperPrompt()): boolean {
  const spoken = text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g, ' ').trim();
  const words = normalise(spoken);
  if (!words) return true;
  if (HALLUCINATED_PHRASES.has(words)) return true;
  if (prompt) {
    const echoes = [prompt, ...prompt.split(/[.!?]+/)].map(normalise).filter(Boolean);
    if (echoes.includes(words)) return true;
  }
  const tokens = words.split(' ');
  return tokens.length >= 3 && new Set(tokens).size === 1;
}

/**
 * Strictly recognises a 16 kHz mono 16-bit PCM WAV that whisper-cli can read directly.
 * Anything else (including malformed headers) returns false and takes the ffmpeg path.
 */
export function isWhisperReadyWav(buffer: Buffer): boolean {
  if (buffer.length < 44 || buffer.length > MAX_CLIP_BYTES) return false;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE')
    return false;
  if (buffer.readUInt32LE(4) + 8 > buffer.length) return false;
  let formatOk = false;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) return false;
    if (id === 'fmt ') {
      if (formatOk || size < 16) return false;
      formatOk =
        buffer.readUInt16LE(body) === 1 && // PCM
        buffer.readUInt16LE(body + 2) === 1 && // mono
        buffer.readUInt32LE(body + 4) === 16000 &&
        buffer.readUInt32LE(body + 8) === 32000 &&
        buffer.readUInt16LE(body + 12) === 2 &&
        buffer.readUInt16LE(body + 14) === 16;
      if (!formatOk) return false;
    } else if (id === 'data') {
      return formatOk && size > 0 && size % 2 === 0;
    }
    offset = body + size + (size % 2);
  }
  return false;
}

// A small worker pool replaces the old global busy flag: a few clips run in
// parallel and a bounded queue absorbs bursts instead of failing every other
// student with 503. Only overflow beyond the queue is rejected.
let active = 0;
const waiting: Array<() => void> = [];

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function acquireSlot(): Promise<void> {
  if (active < limit('WHISPER_CONCURRENCY', 2)) {
    active += 1;
    return;
  }
  if (waiting.length >= limit('WHISPER_MAX_QUEUE', 8))
    throw new TranscriptionError('Local transcription is busy. Wait a moment and retry audio.');
  // The releasing request hands its slot straight to us, so `active` is unchanged.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

function failed(stage: string, error: unknown): TranscriptionError {
  const detail = error as { code?: string; killed?: boolean; signal?: string };
  if (detail?.killed || detail?.signal === 'SIGTERM')
    return new TranscriptionError(
      `${stage} timed out. On a slower computer set WHISPER_MODEL=small.en and retry.`,
    );
  if (detail?.code === 'ENOENT')
    return new TranscriptionError(
      `${stage} executable is missing. Check the local FFmpeg/Whisper installation.`,
    );
  return new TranscriptionError(
    `${stage} failed. Check the local tools; GPU use requires a working Metal device.`,
  );
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  if (!audioBuffer.length || audioBuffer.length > MAX_CLIP_BYTES)
    throw new Error('Invalid audio clip size.');
  await acquireSlot();
  let directory: string | undefined;
  try {
    const whisperBin =
      process.env.WHISPER_BIN ?? path.join(apiRoot, 'vendor/whisper.cpp/build/bin/whisper-cli');
    const modelPath = resolveWhisperModelPath();
    try {
      await Promise.all([fs.access(whisperBin), fs.access(modelPath)]);
    } catch {
      throw new TranscriptionError(
        'Whisper executable or speech model is missing. Run npm run setup:whisper before retrying audio.',
      );
    }
    directory = await fs.mkdtemp(path.join(tmpdir(), 'exam-audio-'));
    const input = path.join(directory, 'clip');
    const wav = path.join(directory, 'clip.wav');
    if (isWhisperReadyWav(audioBuffer)) {
      // App-recorded clips arrive as 16 kHz mono PCM: no ffmpeg needed.
      await fs.writeFile(wav, audioBuffer);
    } else {
      await fs.writeFile(input, audioBuffer);
      await execute(
        process.env.FFMPEG_BIN ?? 'ffmpeg',
        [
          '-nostdin',
          '-i',
          input,
          '-t',
          '6',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          wav,
          '-y',
        ],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
      ).catch((error) => {
        throw failed('Audio conversion', error);
      });
    }
    // Never send audio to a remote fallback.
    const { stdout } = await execute(whisperBin, whisperArgs(modelPath, wav), {
      timeout: limit('WHISPER_TIMEOUT_MS', 60000),
      maxBuffer: 1024 * 1024,
    }).catch((error) => {
      throw failed('Speech transcription', error);
    });
    const transcript = stdout.replace(/\s+/g, ' ').trim();
    // Tags and silence hallucinations are not speech; callers drop empty text.
    return isNonSpeechTranscript(transcript) ? '' : transcript;
  } finally {
    // Unique, request-owned temporary audio only; never touch source recordings.
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    releaseSlot();
  }
}

/**
 * GPU (Metal) only when asked for and on Apple Silicon. On Intel Macs the Metal
 * backend returns empty or garbage text (e.g. a lone quote), so CPU is forced.
 */
export function useWhisperGpu(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  if (env.WHISPER_USE_GPU !== '1') return false;
  return !(platform === 'darwin' && arch === 'x64');
}

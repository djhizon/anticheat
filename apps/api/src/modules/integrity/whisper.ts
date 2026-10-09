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
      `${stage} timed out. Use the smaller Whisper base model and retry.`,
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
    const modelPath =
      process.env.WHISPER_MODEL_PATH ??
      path.join(apiRoot, 'vendor/whisper.cpp/models/ggml-base.bin');
    try {
      await Promise.all([fs.access(whisperBin), fs.access(modelPath)]);
    } catch {
      throw new TranscriptionError(
        'Whisper executable or base model is missing. Install the local model before retrying audio.',
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
    // A small CPU model keeps the demo responsive and avoids unavailable Metal
    // devices. Never send audio to a remote fallback.
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
      'auto',
    ];
    if (process.env.WHISPER_USE_GPU !== '1') args.push('-ng');
    const { stdout } = await execute(whisperBin, args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }).catch((error) => {
      throw failed('Speech transcription', error);
    });
    return stdout.trim();
  } finally {
    // Unique, request-owned temporary audio only; never touch source recordings.
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    releaseSlot();
  }
}

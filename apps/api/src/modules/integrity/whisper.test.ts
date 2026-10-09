import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('node:util', () => ({ promisify: () => mocks.execute }));
vi.mock('node:fs/promises', () => ({
  default: { access: mocks.access, mkdtemp: mocks.mkdir, writeFile: mocks.write, rm: mocks.remove },
}));
import { isWhisperReadyWav, transcribeAudio } from './whisper.js';

function wavFile(
  options: {
    rate?: number;
    channels?: number;
    bits?: number;
    samples?: number;
    format?: number;
  } = {},
): Buffer {
  const { rate = 16000, channels = 1, bits = 16, samples = 1600, format = 1 } = options;
  const data = samples * 2;
  const out = Buffer.alloc(44 + data);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + data, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(format, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE((rate * channels * bits) / 8, 28);
  out.writeUInt16LE((channels * bits) / 8, 32);
  out.writeUInt16LE(bits, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(data, 40);
  return out;
}

describe('WAV detection', () => {
  it('accepts only well-formed 16 kHz mono 16-bit PCM', () => {
    expect(isWhisperReadyWav(wavFile())).toBe(true);
    expect(isWhisperReadyWav(wavFile({ rate: 44100 }))).toBe(false);
    expect(isWhisperReadyWav(wavFile({ channels: 2 }))).toBe(false);
    expect(isWhisperReadyWav(wavFile({ bits: 8 }))).toBe(false);
    expect(isWhisperReadyWav(wavFile({ format: 3 }))).toBe(false);
    expect(isWhisperReadyWav(wavFile({ samples: 0 }))).toBe(false);
    expect(isWhisperReadyWav(wavFile().subarray(0, 43))).toBe(false);
    expect(isWhisperReadyWav(wavFile().subarray(0, 1000))).toBe(false);
    expect(isWhisperReadyWav(Buffer.from('fixture'))).toBe(false);
    const bad = wavFile();
    bad.write('RIFX', 0, 'latin1');
    expect(isWhisperReadyWav(bad)).toBe(false);
    const oversize = wavFile();
    oversize.writeUInt32LE(0xffffffff, 40);
    expect(isWhisperReadyWav(oversize)).toBe(false);
  });
});
describe('bounded local transcription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue('/tmp/exam-audio-fixture');
    mocks.write.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue({ stdout: ' Test speech ' });
  });
  it('converts an independent clip then transcribes and deletes only its temporary directory', async () => {
    expect(await transcribeAudio(Buffer.from('fixture'))).toBe('Test speech');
    expect(mocks.execute.mock.calls[0]?.[1]).toContain('16000');
    expect(mocks.execute.mock.calls[1]?.[0]).toContain('/apps/api/vendor/whisper.cpp/');
    expect(mocks.execute.mock.calls[1]?.[2]).toMatchObject({ timeout: 30000 });
    expect(mocks.execute.mock.calls[1]?.[1]).toContain('-ng');
    expect(mocks.execute.mock.calls[1]?.[1].join(' ')).toContain('ggml-base.bin');
    expect(mocks.remove).toHaveBeenCalledWith('/tmp/exam-audio-fixture', {
      recursive: true,
      force: true,
    });
  });
  it('passes a 16 kHz mono WAV straight to whisper without ffmpeg', async () => {
    const wav = wavFile();
    expect(await transcribeAudio(wav)).toBe('Test speech');
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledWith('/tmp/exam-audio-fixture/clip.wav', wav);
    expect(mocks.execute.mock.calls[0]?.[1]).toContain('/tmp/exam-audio-fixture/clip.wav');
  });
  it('falls back to ffmpeg for other WAV formats', async () => {
    expect(await transcribeAudio(wavFile({ rate: 48000 }))).toBe('Test speech');
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[0]?.[1]).toContain('16000');
  });
  it('propagates decoder failure and still cleans up', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('decoder failed'));
    await expect(transcribeAudio(Buffer.from('fixture'))).rejects.toThrow(
      'Audio conversion failed',
    );
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it('rejects empty clips without launching tools', async () => {
    await expect(transcribeAudio(Buffer.alloc(0))).rejects.toThrow('size');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('reports a missing model without exposing paths or recording audio', async () => {
    mocks.access.mockRejectedValueOnce(new Error('/private/model/path'));
    await expect(transcribeAudio(Buffer.from('fixture'))).rejects.toThrow('base model is missing');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('reports timeouts and releases its worker slot for a retry', async () => {
    mocks.execute.mockResolvedValueOnce({ stdout: '' }).mockRejectedValueOnce({ killed: true });
    await expect(transcribeAudio(Buffer.from('fixture'))).rejects.toThrow('timed out');
    expect(await transcribeAudio(Buffer.from('fixture'))).toBe('Test speech');
  });
  it('runs clips in parallel up to the pool size and queues the rest', async () => {
    vi.stubEnv('WHISPER_CONCURRENCY', '1');
    vi.stubEnv('WHISPER_MAX_QUEUE', '1');
    let finishFirst!: () => void;
    mocks.execute
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () => resolve({ stdout: '' });
          }),
      )
      .mockResolvedValue({ stdout: ' queued ' });
    const first = transcribeAudio(Buffer.from('one'));
    const second = transcribeAudio(Buffer.from('two'));
    await expect(transcribeAudio(Buffer.from('three'))).rejects.toThrow('busy');
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    finishFirst();
    await expect(first).resolves.toBe('queued');
    await expect(second).resolves.toBe('queued');
    vi.unstubAllEnvs();
  });
});

it('uses the GPU only when asked for and never on Intel Macs', async () => {
  const { useWhisperGpu } = await import('./whisper.js');
  expect(useWhisperGpu({}, 'darwin', 'arm64')).toBe(false);
  expect(useWhisperGpu({ WHISPER_USE_GPU: '1' }, 'darwin', 'arm64')).toBe(true);
  expect(useWhisperGpu({ WHISPER_USE_GPU: '1' }, 'darwin', 'x64')).toBe(false);
  expect(useWhisperGpu({ WHISPER_USE_GPU: '1' }, 'linux', 'x64')).toBe(true);
});

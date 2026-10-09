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
import { transcribeAudio } from './whisper.js';
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
  it('reports timeouts and releases the busy flag for a retry', async () => {
    mocks.execute.mockResolvedValueOnce({ stdout: '' }).mockRejectedValueOnce({ killed: true });
    await expect(transcribeAudio(Buffer.from('fixture'))).rejects.toThrow('timed out');
    expect(await transcribeAudio(Buffer.from('fixture'))).toBe('Test speech');
  });
});

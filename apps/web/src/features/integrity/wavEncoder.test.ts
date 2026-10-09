import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WHISPER_SAMPLE_RATE,
  bytesToBase64,
  decodeToMono16k,
  encodePcm16Wav,
  recordingToWavBase64,
} from './wavEncoder.js';

describe('wav encoder', () => {
  it('writes a 16 kHz mono 16-bit PCM header and the right length', () => {
    const samples = new Float32Array([0, 1, -1, 0.5, 2, -2]);
    const wav = encodePcm16Wav(samples);
    const view = new DataView(wav.buffer);
    const tag = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(tag(36)).toBe('data');
    expect(wav.length).toBe(44 + samples.length * 2);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(WHISPER_SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 16384, 32767, -32768,
    ]);
  });

  it('encodes large clips to base64 without stack overflow', () => {
    const wav = encodePcm16Wav(new Float32Array(96000));
    expect(Buffer.from(bytesToBase64(wav), 'base64').equals(Buffer.from(wav))).toBe(true);
  });

  describe('Web Audio path', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('falls back to the raw container without Web Audio', async () => {
      expect(await decodeToMono16k(new Blob(['x']))).toBeNull();
      const fallback = vi.fn(async () => 'raw');
      expect(await recordingToWavBase64(new Blob(['x']), fallback)).toBe('raw');
    });

    it('decodes, resamples to 16 kHz mono and uploads a WAV', async () => {
      const rendered = new Float32Array(48000).fill(0.25);
      const offlineArgs: number[][] = [];
      vi.stubGlobal(
        'AudioContext',
        class {
          decodeAudioData = async () => ({ duration: 3 });
          close = async () => {};
        },
      );
      vi.stubGlobal(
        'OfflineAudioContext',
        class {
          destination = {};
          constructor(...args: number[]) {
            offlineArgs.push(args);
          }
          createBufferSource() {
            return { connect: () => {}, start: () => {}, buffer: null };
          }
          startRendering = async () => ({ getChannelData: () => rendered });
        },
      );
      const base64 = await recordingToWavBase64(new Blob(['x']), async () => 'raw');
      expect(offlineArgs).toEqual([[1, 48000, 16000]]);
      const wav = Buffer.from(base64, 'base64');
      expect(wav.length).toBe(44 + 96000);
      expect(wav.readUInt32LE(24)).toBe(16000);
      expect(wav.readUInt16LE(22)).toBe(1);
    });

    it('falls back when decoding fails', async () => {
      vi.stubGlobal(
        'AudioContext',
        class {
          decodeAudioData = async () => {
            throw new Error('bad');
          };
          close = async () => {};
        },
      );
      vi.stubGlobal('OfflineAudioContext', class {});
      expect(await recordingToWavBase64(new Blob(['x']), async () => 'raw')).toBe('raw');
    });
  });
});

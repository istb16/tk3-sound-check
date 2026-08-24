import { describe, expect, it } from 'vitest';
import { encodeWavFloat32, wavFileName } from './wav.ts';

const SR = 48000;

function tone(n: number): Float32Array {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.3;
  return d;
}

/** WAVのヘッダを読む。ブラウザの復号を通すとリサンプルされるのでバイト列を直接見る */
function parseHeader(bytes: ArrayBuffer) {
  const v = new DataView(bytes);
  const ascii = (offset: number, len: number): string =>
    String.fromCharCode(...Array.from({ length: len }, (_, i) => v.getUint8(offset + i)));
  return {
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    formatTag: v.getUint16(20, true),
    channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true),
    bytesPerSec: v.getUint32(28, true),
    blockAlign: v.getUint16(32, true),
    bitsPerSample: v.getUint16(34, true),
    data: ascii(36, 4),
    dataBytes: v.getUint32(40, true),
    riffSize: v.getUint32(4, true),
  };
}

describe('encodeWavFloat32', () => {
  it('32bit float / モノラル / 指定のサンプルレートで書ける', async () => {
    const samples = tone(1000);
    const h = parseHeader(await encodeWavFloat32(samples, SR).arrayBuffer());

    expect(h.riff).toBe('RIFF');
    expect(h.wave).toBe('WAVE');
    expect(h.fmt).toBe('fmt ');
    expect(h.formatTag).toBe(3);        // 3 = IEEE float
    expect(h.channels).toBe(1);
    expect(h.sampleRate).toBe(SR);
    expect(h.bitsPerSample).toBe(32);
    expect(h.blockAlign).toBe(4);
    expect(h.bytesPerSec).toBe(SR * 4);
  });

  it('ヘッダの長さがデータ長と整合する', async () => {
    const samples = tone(1000);
    const blob = encodeWavFloat32(samples, SR);
    const h = parseHeader(await blob.arrayBuffer());

    expect(blob.size).toBe(44 + samples.length * 4);
    expect(h.dataBytes).toBe(samples.length * 4);
    expect(h.riffSize).toBe(36 + samples.length * 4);
  });

  it('サンプル値が1ビットも変わらない（量子化しない）', async () => {
    // 無音区間のノイズフロアを測る道具なので、保存で値が変わってはいけない。
    // 16bitに落とすとフロアが書き換わり、保存したファイルを測り直したときに
    // 元の判定と合わなくなる。
    const samples = new Float32Array([0, 1e-6, -1e-6, 0.5, -0.5, 0.999999, -0.999999]);
    const bytes = await encodeWavFloat32(samples, SR).arrayBuffer();
    const v = new DataView(bytes);

    for (let i = 0; i < samples.length; i++) {
      expect(v.getFloat32(44 + i * 4, true), `sample ${i}`).toBe(samples[i]);
    }
  });

  it('ブラウザが復号できる', async () => {
    // 復号は 48kHz の文脈で行う。44.1kHz の OfflineAudioContext を使うと
    // 復号時にリサンプルされ、レートも値も変わってしまう（decodeFile が
    // 元ファイルの帯域情報を失うのと同じ理由）。
    const samples = tone(SR);
    const blob = encodeWavFloat32(samples, SR);
    const ctx = new OfflineAudioContext(1, 1, SR);
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());

    expect(decoded.numberOfChannels).toBe(1);
    expect(decoded.sampleRate).toBe(SR);
    expect(decoded.length).toBe(samples.length);

    const out = decoded.getChannelData(0);
    for (const i of [0, 100, 4321, samples.length - 1]) {
      expect(out[i], `sample ${i}`).toBeCloseTo(samples[i], 6);
    }
  });
});

describe('wavFileName', () => {
  it('秒まで含むので同じ録音を並べても区別できる', () => {
    expect(wavFileName(new Date(2026, 7, 24, 9, 5, 3))).toBe('recording-20260824-090503.wav');
  });
});

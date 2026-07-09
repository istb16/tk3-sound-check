import { describe, expect, it } from 'vitest';
import { analyzeAudio } from './AudioAnalyzer.ts';

// 合成 AudioBuffer を作るヘルパー
function makeBuffer(
  fillFn: (data: Float32Array, sampleRate: number) => void,
  duration = 2,
  sampleRate = 16000,
): AudioBuffer {
  const ctx = new OfflineAudioContext(1, Math.floor(duration * sampleRate), sampleRate);
  const buf = ctx.createBuffer(1, Math.floor(duration * sampleRate), sampleRate);
  fillFn(buf.getChannelData(0), sampleRate);
  return buf;
}

// 無音区間 + サイン波：SNR推定が機能するリアルな構造
function cleanSpeechBuffer(freq = 1000, amp = 0.5, duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    const silenceSamples = Math.floor(sampleRate * 0.3);
    for (let i = 0; i < data.length; i++) {
      data[i] = i < silenceSamples
        ? 0.003 * (Math.random() * 2 - 1)  // 超低レベルの背景雑音（-50dB 相当）
        : amp * Math.sin(2 * Math.PI * freq * i / sampleRate);
    }
  }, duration, sr);
}

// 完全クリッピングのスクエア波
function clippedBuffer(duration = 2): AudioBuffer {
  return makeBuffer((data) => {
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 80 < 40 ? 1.0 : -1.0;
    }
  }, duration);
}

// 音声帯域外の高周波（7.5kHz）
function highFreqBuffer(duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    const silenceSamples = Math.floor(sampleRate * 0.3);
    for (let i = 0; i < data.length; i++) {
      data[i] = i < silenceSamples
        ? 0.003 * (Math.random() * 2 - 1)
        : 0.5 * Math.sin(2 * Math.PI * 7500 * i / sampleRate);
    }
  }, duration, sr);
}

// 高レベルノイズ（信号なし）
function pureNoiseBuffer(noiseAmp = 0.7, duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data) => {
    for (let i = 0; i < data.length; i++) {
      data[i] = noiseAmp * (Math.random() * 2 - 1);
    }
  }, duration, sr);
}

// ---- テストスイート ----

describe('analyzeAudio — 戻り値の型と範囲', () => {
  it('全スコアが 0〜100 の整数で返る', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    for (const k of ['overall', 'noise', 'distortion', 'reverb', 'echo', 'clarity'] as const) {
      expect(result[k], `${k} should be a number`).toBeTypeOf('number');
      expect(result[k], `${k} >= 0`).toBeGreaterThanOrEqual(0);
      expect(result[k], `${k} <= 100`).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result[k]), `${k} is integer`).toBe(true);
    }
  });

  it('overall は各スコアの重み付き合計と一致する', async () => {
    const result   = await analyzeAudio(cleanSpeechBuffer());
    const expected = Math.round(
      result.noise       * 0.25 +
      result.distortion  * 0.20 +
      result.reverb      * 0.20 +
      result.echo        * 0.15 +
      result.clarity     * 0.20,
    );
    expect(result.overall).toBe(expected);
  });
});

describe('analyzeAudio — 歪み検出', () => {
  it('スクエア波（完全クリッピング）は distortion が 30 未満', async () => {
    const result = await analyzeAudio(clippedBuffer());
    expect(result.distortion).toBeLessThan(30);
  });

  it('適度な振幅のサイン波は distortion が 70 以上', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer(440, 0.5));
    expect(result.distortion).toBeGreaterThan(70);
  });
});

describe('analyzeAudio — 明瞭度', () => {
  it('音声帯域（1kHz）は高周波ノイズより clarity が高い', async () => {
    const voiceResult   = await analyzeAudio(cleanSpeechBuffer(1000, 0.5));
    const highFreqResult = await analyzeAudio(highFreqBuffer());
    expect(voiceResult.clarity).toBeGreaterThan(highFreqResult.clarity);
  });
});

describe('analyzeAudio — ノイズ', () => {
  it('無音区間のあるクリーン音声はホワイトノイズより noise スコアが高い', async () => {
    const cleanResult = await analyzeAudio(cleanSpeechBuffer(1000, 0.5));
    const noisyResult = await analyzeAudio(pureNoiseBuffer(0.7));
    expect(cleanResult.noise).toBeGreaterThan(noisyResult.noise);
  });
});

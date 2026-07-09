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

// 無音区間 + サイン波：SNR推定・音量推定が機能するリアルな構造
// amp=0.15 のサイン波は RMS ≒ 0.106 (dBFS ≒ -19.5dB) で理想帯域(-20〜-14dB)に収まる
function cleanSpeechBuffer(freq = 1000, amp = 0.15, duration = 2, sr = 16000): AudioBuffer {
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

// 音声帯域外の高周波（7.5kHz、サ行の刺さりを模した帯域）
function highFreqBuffer(duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    const silenceSamples = Math.floor(sampleRate * 0.3);
    for (let i = 0; i < data.length; i++) {
      data[i] = i < silenceSamples
        ? 0.003 * (Math.random() * 2 - 1)
        : 0.15 * Math.sin(2 * Math.PI * 7500 * i / sampleRate);
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

// 極端に音量が小さい（ボソボソ声）音声
function quietBuffer(duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    for (let i = 0; i < data.length; i++) {
      data[i] = 0.005 * Math.sin(2 * Math.PI * 300 * i / sampleRate);
    }
  }, duration, sr);
}

// 低音域(100Hz)が支配的な、こもった音声
function mudBuffer(duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    const silenceSamples = Math.floor(sampleRate * 0.3);
    for (let i = 0; i < data.length; i++) {
      data[i] = i < silenceSamples
        ? 0.003 * (Math.random() * 2 - 1)
        : 0.15 * Math.sin(2 * Math.PI * 100 * i / sampleRate);
    }
  }, duration, sr);
}

// ---- テストスイート ----

describe('analyzeAudio — 戻り値の型と範囲', () => {
  it('全スコアが 0〜100 の整数で返る', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    for (const k of ['overall', 'volume', 'frequency', 'clip', 'noise'] as const) {
      expect(result[k], `${k} should be a number`).toBeTypeOf('number');
      expect(result[k], `${k} >= 0`).toBeGreaterThanOrEqual(0);
      expect(result[k], `${k} <= 100`).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result[k]), `${k} is integer`).toBe(true);
    }
  });

  it('各詳細スコアはそれぞれの満点を超えない', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    expect(result.volume).toBeLessThanOrEqual(30);
    expect(result.frequency).toBeLessThanOrEqual(30);
    expect(result.clip).toBeLessThanOrEqual(20);
    expect(result.noise).toBeLessThanOrEqual(20);
  });

  it('overall は各詳細スコアの合計と一致する', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    expect(result.overall).toBe(result.volume + result.frequency + result.clip + result.noise);
  });

  it('advice は文字列の配列で返る', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    expect(Array.isArray(result.advice)).toBe(true);
    for (const tip of result.advice) expect(tip).toBeTypeOf('string');
  });
});

describe('analyzeAudio — 音量評価', () => {
  it('理想帯域(-20〜-14dB)の音声は volume スコアが高い', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    expect(result.volume).toBeGreaterThan(20);
  });

  it('極端に音量が小さい音声は volume スコアが低く、アドバイスが出る', async () => {
    const result = await analyzeAudio(quietBuffer());
    expect(result.volume).toBeLessThan(15);
    expect(result.advice.some((a) => a.includes('小さめ'))).toBe(true);
  });
});

describe('analyzeAudio — 周波数バランス評価', () => {
  it('音声帯域（1kHz）は高周波ノイズより frequency が高い', async () => {
    const voiceResult    = await analyzeAudio(cleanSpeechBuffer(1000));
    const highFreqResult = await analyzeAudio(highFreqBuffer());
    expect(voiceResult.frequency).toBeGreaterThan(highFreqResult.frequency);
  });

  it('低音(100Hz)が支配的な音声は frequency スコアが低く、こもりのアドバイスが出る', async () => {
    const result = await analyzeAudio(mudBuffer());
    expect(result.advice.some((a) => a.includes('こもって'))).toBe(true);
  });
});

describe('analyzeAudio — 音割れ（クリッピング）検出', () => {
  it('スクエア波（完全クリッピング）は clip が 5 未満', async () => {
    const result = await analyzeAudio(clippedBuffer());
    expect(result.clip).toBeLessThan(5);
    expect(result.advice.some((a) => a.includes('音割れ'))).toBe(true);
  });

  it('適度な振幅のサイン波は clip が満点(20)に近い', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer(440, 0.15));
    expect(result.clip).toBeGreaterThan(18);
  });
});

describe('analyzeAudio — ノイズ・無音評価', () => {
  it('無音区間のあるクリーン音声はホワイトノイズより noise スコアが高い', async () => {
    const cleanResult = await analyzeAudio(cleanSpeechBuffer(1000));
    const noisyResult  = await analyzeAudio(pureNoiseBuffer(0.7));
    expect(cleanResult.noise).toBeGreaterThan(noisyResult.noise);
  });
});

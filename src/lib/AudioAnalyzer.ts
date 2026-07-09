/**
 * WebAudio API ベースの音質分析
 * 評価軸: ノイズ / 歪み / 残響 / エコー / 明瞭度
 * スコアは全て 0〜100 (高いほど良い)
 */

export interface AudioScores {
  overall: number;
  noise: number;
  distortion: number;
  reverb: number;
  echo: number;
  clarity: number;
}

export async function analyzeAudio(audioBuffer: AudioBuffer): Promise<AudioScores> {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);

  const noiseScore      = calcNoiseScore(channelData, sampleRate);
  const distortionScore = calcDistortionScore(channelData);
  const reverbScore     = calcReverbScore(channelData, sampleRate);
  const echoScore       = calcEchoScore(channelData, sampleRate);
  const clarityScore    = calcClarityScore(channelData, sampleRate);

  const overall = Math.round(
    noiseScore      * 0.25 +
    distortionScore * 0.20 +
    reverbScore     * 0.20 +
    echoScore       * 0.15 +
    clarityScore    * 0.20,
  );

  return {
    overall,
    noise:      Math.round(noiseScore),
    distortion: Math.round(distortionScore),
    reverb:     Math.round(reverbScore),
    echo:       Math.round(echoScore),
    clarity:    Math.round(clarityScore),
  };
}

// ---- ノイズスコア ----
// 静音フレームと有音フレームのRMSからSNRを推定
function calcNoiseScore(data: Float32Array, sampleRate: number): number {
  const frameSize = Math.floor(sampleRate * 0.02);
  const frames: number[] = [];

  for (let i = 0; i + frameSize <= data.length; i += frameSize) {
    frames.push(rms(data, i, frameSize));
  }
  if (frames.length < 4) return 50;

  const sorted = [...frames].sort((a, b) => a - b);
  const noiseFloor  = sorted[Math.floor(sorted.length * 0.10)] + 1e-9;
  const signalLevel = sorted[Math.floor(sorted.length * 0.85)] + 1e-9;
  const snrDb = 20 * Math.log10(signalLevel / noiseFloor);

  // SNR 0dB→0点, 40dB以上→100点
  return clamp((snrDb / 40) * 100, 0, 100);
}

// ---- 歪みスコア ----
// クリッピング率を検出
function calcDistortionScore(data: Float32Array): number {
  const threshold = 0.98;
  let clipped = 0;
  let active   = 0;

  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > 0.01) {
      active++;
      if (abs >= threshold) clipped++;
    }
  }

  if (active === 0) return 100;
  const rate = clipped / active;
  // クリッピング率 0%→100点, 5%以上→0点
  return clamp((1 - rate / 0.05) * 100, 0, 100);
}

// ---- 残響スコア ----
// ノイズフロアを考慮した-20dB減衰時間(T20)からRT60を推定
// 旧実装は-60dBを目標にしていたが実環境ではノイズフロアに阻まれ未達 → 常に0になるバグを修正
function calcReverbScore(data: Float32Array, sampleRate: number): number {
  const frameSize = Math.floor(sampleRate * 0.01);
  const env: number[] = [];

  for (let i = 0; i + frameSize <= data.length; i += frameSize) {
    env.push(rms(data, i, frameSize));
  }
  if (env.length < 10) return 70;

  // ノイズフロア推定: 下位15%のフレームの中央値
  const sortedEnv = [...env].sort((a, b) => a - b);
  const noiseFloor = sortedEnv[Math.floor(sortedEnv.length * 0.15)] + 1e-9;

  let peakVal = 0;
  let peakIdx = 0;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > peakVal) { peakVal = env[i]; peakIdx = i; }
  }
  const tail = env.slice(peakIdx);

  // 信号がノイズフロアを十分に超えていない場合は計測不能
  if (peakVal < noiseFloor * 4) return 70;

  // -20dB目標 or ノイズフロアの2倍のどちらか高い方（現実的な到達点）
  const target = Math.max(peakVal * 0.1, noiseFloor * 2);

  let t20Frames = tail.length;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] <= target) { t20Frames = i; break; }
  }

  // T20 × 3 ≈ RT60（Sabine則に基づく近似）
  const rt60Sec = t20Frames * 0.01 * 3;

  // 現実基準: ≤0.4s(処理済み部屋)→100点, ≥2.0s(反響室)→0点
  return clamp((1 - (rt60Sec - 0.4) / 1.6) * 100, 0, 100);
}

// ---- エコースコア ----
// 自己相関で50ms〜500msの遅延ピークを検出
// ダウンサンプリングして計算量を削減
function calcEchoScore(data: Float32Array, sampleRate: number): number {
  // 8kHzに間引き（エコー検出には十分）
  const ratio  = Math.max(1, Math.floor(sampleRate / 8000));
  const maxLen = Math.min(Math.floor(data.length / ratio), 8000 * 5);
  const ds     = new Float32Array(maxLen);
  for (let i = 0; i < maxLen; i++) ds[i] = data[i * ratio];

  const ds8k     = 8000;
  const minDelay = Math.floor(ds8k * 0.05);
  const maxDelay = Math.floor(ds8k * 0.5);
  const N        = ds.length;

  // 正規化自己相関
  let power = 0;
  for (let i = 0; i < N; i++) power += ds[i] * ds[i];
  if (power < 1e-12) return 100;

  let maxCorr = 0;
  for (let d = minDelay; d <= Math.min(maxDelay, N - 1); d += 2) {
    let c = 0;
    const lim = N - d;
    for (let i = 0; i < lim; i++) c += ds[i] * ds[i + d];
    const normalized = Math.abs(c) / power;
    if (normalized > maxCorr) maxCorr = normalized;
  }

  // 自然なスピーチ自己相関(〜0.35)は正常、0.60以上を強いエコーと判定
  return clamp((1 - maxCorr / 0.60) * 100, 0, 100);
}

// ---- 明瞭度スコア ----
// 音声帯域(300Hz〜3400Hz)の平均エネルギー密度 vs 全体平均エネルギー密度の比を使用
// 旧実装は絶対比率で判定していたため44kHz録音(音声帯域14%しかない)では常に0になるバグを修正
// 正規化比率はサンプルレートに依存しない
function calcClarityScore(data: Float32Array, sampleRate: number): number {
  const N      = FFT_SIZE;
  const hop    = N;
  const chunks = Math.floor(data.length / hop);
  if (chunks === 0) return 50;

  const freqPerBin = sampleRate / N;
  const halfN      = N / 2;

  // 音声帯域のビン数（サンプルレートに依存）
  let speechBins = 0;
  for (let k = 1; k < halfN; k++) {
    const freq = k * freqPerBin;
    if (freq >= 300 && freq <= 3400) speechBins++;
  }
  const totalBins = halfN - 1;

  let speechEnergy = 0;
  let totalEnergy  = 0;

  for (let c = 0; c < chunks; c++) {
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = data[c * hop + i] * HAMMING_WIN[i];
    fft(re, im);

    for (let k = 1; k < halfN; k++) {
      const freq  = k * freqPerBin;
      const power = re[k] * re[k] + im[k] * im[k];
      totalEnergy += power;
      if (freq >= 300 && freq <= 3400) speechEnergy += power;
    }
  }

  if (totalEnergy < 1e-12 || speechBins === 0) return 50;

  // 正規化比率: 音声帯域の平均エネルギー密度 ÷ 全体の平均エネルギー密度
  // 平坦スペクトル→1.0、音声優位→>1.0、音声帯域が弱い→<1.0
  const normalizedRatio = (speechEnergy / speechBins) / (totalEnergy / totalBins);

  // ≤0.5 → 0点(音声帯域が全体平均の半分以下), ≥2.0 → 100点(音声帯域が全体平均の2倍以上)
  return clamp(((normalizedRatio - 0.5) / 1.5) * 100, 0, 100);
}

// ---- Cooley-Tukey Radix-2 FFT ----
// N は2の冪乗であること
function fft(re: Float32Array, im: Float32Array): void {
  const N = re.length;

  // ビット反転並べ替え
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  // バタフライ演算
  for (let len = 2; len <= N; len <<= 1) {
    const half    = len >> 1;
    const ang     = (2 * Math.PI) / len;
    const wBaseRe = Math.cos(ang);
    const wBaseIm = -Math.sin(ang);

    for (let i = 0; i < N; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j]        = uRe + vRe;
        im[i + j]        = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const tmp = wRe * wBaseRe - wIm * wBaseIm;
        wIm = wRe * wBaseIm + wIm * wBaseRe;
        wRe = tmp;
      }
    }
  }
}

// ---- ハミング窓 (N=2048 固定) ----
const FFT_SIZE = 2048;
const HAMMING_WIN = (() => {
  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    win[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  return win;
})();

// ---- ユーティリティ ----
function rms(data: Float32Array, offset: number, len: number): number {
  let sum = 0;
  const end = offset + len;
  for (let i = offset; i < end; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / len);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

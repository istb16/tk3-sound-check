/**
 * WebAudio API ベースの音質分析
 * 評価軸: 音量バランス / 周波数バランス / 音割れ(クリッピング) / 背景ノイズ・無音
 * スコアは 100点満点（各項目の内訳を合算）。人間の聴感に近づけるため、
 * 単純なRMSやFFTの絶対値ではなく、聴感上の許容範囲・相対比率をベースに評価する。
 */

export interface AudioScores {
  overall: number;
  volume: number;
  frequency: number;
  clip: number;
  noise: number;
  advice: string[];
}

export async function analyzeAudio(audioBuffer: AudioBuffer): Promise<AudioScores> {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);

  const advice: string[] = [];

  const volumeScore    = calcVolumeScore(channelData, sampleRate, advice);
  const frequencyScore = calcFrequencyScore(channelData, sampleRate, advice);
  const clipScore      = calcClipScore(channelData, advice);
  const noiseScore     = calcNoiseScore(channelData, sampleRate, advice);

  const volume    = Math.round(volumeScore);
  const frequency = Math.round(frequencyScore);
  const clip      = Math.round(clipScore);
  const noise     = Math.round(noiseScore);

  // overall は内訳の単純合計（各詳細スコアの満点合計が100になるよう設計している）
  const overall = clamp(volume + frequency + clip + noise, 0, 100);

  return { overall, volume, frequency, clip, noise, advice };
}

// ==========================================================================
// 1. 音量バランスとダイナミクス評価 [30点満点]
// ==========================================================================
// - 全体RMSレベル(dBFS)が理想帯域(-20dB〜-14dB)に収まっているかを評価(最大22点)
// - 有音区間ごとのRMSレベルのばらつき(ラウドネスレンジ)を評価(最大8点)
function calcVolumeScore(data: Float32Array, sampleRate: number, advice: string[]): number {
  const IDEAL_LO = -20;
  const IDEAL_HI = -14;

  const overallRms = rms(data, 0, data.length);
  const overallDb   = dbfs(overallRms);

  // ---- レベルスコア (22点) ----
  let levelScore: number;
  if (overallDb >= IDEAL_LO && overallDb <= IDEAL_HI) {
    levelScore = 22;
  } else {
    const deviation = overallDb < IDEAL_LO ? IDEAL_LO - overallDb : overallDb - IDEAL_HI;
    // 1dB逸脱ごとに約1.8点減点、12dB以上逸脱でほぼ0点
    levelScore = clamp(22 - deviation * 1.8, 0, 22);
  }

  // ---- ダイナミクス(ラウドネスレンジ)スコア (8点) ----
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.02)); // 20msフレーム
  const frames = frameRmsList(data, frameSize);
  const activeFrames = frames.filter((f) => f > 1e-4);

  let dynamicsScore = 8;
  if (activeFrames.length >= 5) {
    const dbList = activeFrames.map(dbfs).sort((a, b) => a - b);
    const p10 = dbList[Math.floor(dbList.length * 0.1)];
    const p90 = dbList[Math.floor(dbList.length * 0.9)];
    const loudnessRange = p90 - p10;
    // 15dB以内は自然な抑揚として満点、そこから広がるほど減点(ボソボソ声と大声の混在)
    dynamicsScore = clamp(8 - Math.max(0, loudnessRange - 15) * 0.6, 0, 8);
  }

  const score = clamp(levelScore + dynamicsScore, 0, 30);

  if (overallDb < IDEAL_LO - 3) {
    advice.push('全体的に音が小さめです。マイクに近づくか、入力ゲインを上げてください。');
  } else if (overallDb > IDEAL_HI + 3) {
    advice.push('全体的に音が大きすぎます。入力ゲインを下げるか、マイクから少し離れてください。');
  }
  if (dynamicsScore < 5) {
    advice.push('声の大きさに大きなムラがあります。ボソボソ声と大声が混在しないよう、一定の声量で話しましょう。');
  }

  return score;
}

// ==========================================================================
// 2. 周波数バランス（イコライジング）評価 [30点満点]
// ==========================================================================
// - 500Hz〜3kHz(声の明瞭度帯域)のエネルギー比率 → 最大16点
// - 200Hz以下(こもり音)のエネルギー比率が高い場合に減点 → 最大8点
// - 5kHz〜10kHz(キンキン音/サ行の刺さり)のエネルギー比率が高い場合に減点 → 最大6点
function calcFrequencyScore(data: Float32Array, sampleRate: number, advice: string[]): number {
  const N = FFT_SIZE;
  const hop = N;
  const chunks = Math.floor(data.length / hop);
  if (chunks === 0) return 15;

  const freqPerBin = sampleRate / N;
  const halfN = N / 2;

  let lowEnergy = 0;       // 〜200Hz (こもり)
  let presenceEnergy = 0;  // 500Hz〜3000Hz (明瞭度)
  let highEnergy = 0;      // 5000Hz〜10000Hz (キンキン)
  let totalEnergy = 0;

  for (let c = 0; c < chunks; c++) {
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = data[c * hop + i] * HAMMING_WIN[i];
    fft(re, im);

    for (let k = 1; k < halfN; k++) {
      const freq = k * freqPerBin;
      const power = re[k] * re[k] + im[k] * im[k];
      totalEnergy += power;
      if (freq <= 200) lowEnergy += power;
      if (freq >= 500 && freq <= 3000) presenceEnergy += power;
      if (freq >= 5000 && freq <= 10000) highEnergy += power;
    }
  }

  if (totalEnergy < 1e-12) return 15;

  const lowRatio      = lowEnergy / totalEnergy;
  const presenceRatio = presenceEnergy / totalEnergy;
  const highRatio     = highEnergy / totalEnergy;

  // 明瞭度: 比率0.4以上でほぼ満点(16点)、0に近いほど減点
  const presenceFactor = clamp(presenceRatio / 0.4, 0, 1);
  const presenceScore = 16 * presenceFactor;

  // こもり: 低音比率が0.30を超えたあたりから減点し始め、0.70以上でフル減点
  const lowPenaltyFactor = clamp((lowRatio - 0.30) / 0.40, 0, 1);
  const lowScore = 8 * (1 - lowPenaltyFactor);

  // キンキン: 高音比率が0.12を超えたあたりから減点し始め、0.42以上でフル減点
  const highPenaltyFactor = clamp((highRatio - 0.12) / 0.30, 0, 1);
  const highScore = 6 * (1 - highPenaltyFactor);

  const score = clamp(presenceScore + lowScore + highScore, 0, 30);

  if (presenceFactor < 0.5) {
    advice.push('声の明瞭度がやや低めです。マイクを口元に向け、はっきりと発声してください。');
  }
  if (lowPenaltyFactor > 0.3) {
    advice.push('低音が少しこもっています。部屋の反響を抑えるか、マイクの位置・向きを調整してください。');
  }
  if (highPenaltyFactor > 0.3) {
    advice.push('高音域（サ行など）が刺さって聞こえます。マイクとの距離を少し離すか、ポップフィルターの使用を検討してください。');
  }

  return score;
}

// ==========================================================================
// 3. 音割れ（クリッピング）検出 [20点満点]
// ==========================================================================
// - 絶対値0.98以上のサンプルをクリップとしてカウント
// - 連続クリップ(バースト)は波形の歪みが顕著なため、追加で重く減点
function calcClipScore(data: Float32Array, advice: string[]): number {
  const threshold = 0.98;
  let clippedCount = 0;
  let active = 0;
  let currentRun = 0;
  let longestRun = 0;

  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > 0.01) active++;

    if (abs >= threshold) {
      clippedCount++;
      currentRun++;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }

  if (active === 0) return 20;

  const clipRate = clippedCount / active;
  // クリッピング率 0%→20点、0.5%以上でほぼ0点（重い減点）
  let score = clamp((1 - clipRate / 0.005) * 20, 0, 20);

  // 連続クリップ(バースト歪み)は追加減点
  if (longestRun > 5) {
    score = clamp(score - Math.min(10, longestRun * 0.3), 0, 20);
  }

  if (clippedCount > 0) {
    advice.push('音割れ（クリッピング）が検出されました。マイクの入力音量を下げるか、発声音量を少し抑えてください。');
  }

  return score;
}

// ==========================================================================
// 4. 背景ノイズと無音の割合 [20点満点]
// ==========================================================================
// - 有音区間と無音(ノイズフロア)区間のRMS比からSNRを推定 → 最大14点
// - 無音区間の割合が極端(長すぎる/短すぎる)でないかを評価 → 最大6点
function calcNoiseScore(data: Float32Array, sampleRate: number, advice: string[]): number {
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.02));
  const frames = frameRmsList(data, frameSize);

  if (frames.length < 4) return 10;

  const sorted = [...frames].sort((a, b) => a - b);
  const noiseFloor  = sorted[Math.floor(sorted.length * 0.10)] + 1e-9;
  const signalLevel = sorted[Math.floor(sorted.length * 0.85)] + 1e-9;
  const snrDb = 20 * Math.log10(signalLevel / noiseFloor);

  // SNR 0dB→0点、40dB以上→14点
  const snrScore = clamp((snrDb / 40) * 14, 0, 14);

  // ---- 無音区間の割合評価 (6点) ----
  const silenceThreshold = noiseFloor * 3;
  const silenceFrames = frames.filter((f) => f <= silenceThreshold).length;
  const silenceRatio = silenceFrames / frames.length;

  let pauseScore = 6;
  if (silenceRatio > 0.6) {
    // 無言の時間が長すぎる
    pauseScore = clamp(6 - (silenceRatio - 0.6) * 20, 0, 6);
  } else if (silenceRatio < 0.02) {
    // 息継ぎなしの喋りっぱなし
    pauseScore = clamp(6 - (0.02 - silenceRatio) * 150, 0, 6);
  }

  const score = clamp(snrScore + pauseScore, 0, 20);

  if (snrDb < 15) {
    advice.push('背景ノイズが目立ちます。静かな環境で録音するか、ノイズの少ないマイクの使用を検討してください。');
  }
  if (silenceRatio > 0.6) {
    advice.push('無音区間が長すぎます。不要な間を編集でカットするか、テンポよく話してください。');
  } else if (silenceRatio < 0.02) {
    advice.push('息継ぎの間がなく喋り続けています。自然な間を意識すると聞き取りやすくなります。');
  }

  return score;
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

// 20msフレームごとのRMSリストを算出
function frameRmsList(data: Float32Array, frameSize: number): number[] {
  const frames: number[] = [];
  for (let i = 0; i + frameSize <= data.length; i += frameSize) {
    frames.push(rms(data, i, frameSize));
  }
  return frames;
}

// RMS(振幅) → dBFS変換
function dbfs(amplitude: number): number {
  return 20 * Math.log10(amplitude + 1e-9);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

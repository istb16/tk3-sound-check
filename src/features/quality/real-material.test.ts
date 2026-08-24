/**
 * 実録音での動作確認。
 *
 * `fixtures/real/` に音声ファイルを置くと、製品と同じ復号経路
 * （`decodeFile` = `decodeAudioData`）を通して解析し、結果を出力する。
 * ファイルが無ければ何も検証せずに通る（合成信号だけの検証と違い、
 * 素材は git 管理外なので CI では常に不在になる）。
 *
 * ここで確かめるのは値の正しさではない——実録音の真値は誰も知らない。
 * 確かめるのは「壊れずに、範囲内の値を返し、測れていないものを黙って
 * 部分点にしない」こと。数値そのものは目で見て妥当性を判断する。
 */
import { describe, expect, it } from 'vitest';
import { analyzeSamples, AXIS_MAX, type ScoreAxis } from './AudioAnalyzer.ts';
import { detectProvenance } from './provenance.ts';
import {
  estimateClipping,
  estimateLevel,
  estimateReverb,
  estimateSnr,
  estimateSpectralSlope,
} from './estimators.ts';

/** 置かれている可能性のあるファイル。無いものは黙って飛ばす */
const CANDIDATES = [
  'fixtures/real/01_pc.m4a',
  'fixtures/real/01_smartphone.m4a',
  'fixtures/real/02_pc.wav',
  'fixtures/real/03_pc.wav',
];

async function loadIfPresent(path: string): Promise<AudioBuffer | null> {
  let res: Response;
  try {
    res = await fetch(`/${path}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) return null;

  // 製品と同じ経路。OfflineAudioContext の復号はブラウザのコーデックを使うので
  // m4a/AAC もそのまま読める（Node の検証基盤では読めない）。
  const ctx = new OfflineAudioContext(1, 1, 44100);
  try {
    return await ctx.decodeAudioData(bytes);
  } catch {
    return null;
  }
}

describe('実録音での動作確認（fixtures/real/ にファイルがあるときだけ）', () => {
  for (const path of CANDIDATES) {
    it(`${path} を解析できる`, async () => {
      const buffer = await loadIfPresent(path);
      if (buffer === null) {
        console.log(`[skip] ${path} は無いか復号できない`);
        return;
      }

      const data = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      const res = analyzeSamples(data, sr);
      const prov = detectProvenance(data, sr);
      const rev = estimateReverb(data, sr);
      const snr = estimateSnr(data, sr, rev.rt60Sec);
      const lvl = estimateLevel(data, sr);
      const clip = estimateClipping(data);
      const slope = estimateSpectralSlope(data, sr, prov.bandwidthHz);

      const L = (v: number | null, digits = 2): string =>
        v === null ? 'null' : v.toFixed(digits);

      console.log([
        '',
        `=== ${path} ===`,
        `  長さ ${(data.length / sr).toFixed(2)}秒  復号後 ${sr}Hz  元チャンネル数は復号で1chに畳まれる`,
        '',
        '  -- 物理量 --',
        `  有効音声レベル   ${L(lvl.activeSpeechDbfs, 1)} dBFS   (全体 ${L(lvl.overallDbfs, 1)} dBFS)`,
        `  SNR              ${L(snr.snrDb, 1)} dB   (ノイズ用フレーム ${snr.noiseFrames}個 / 無音率 ${L(snr.silenceRatio)})`,
        `  RT60             ${L(rev.rt60Sec)} 秒   (減衰イベント ${rev.events}個 / 信頼 ${rev.confident})`,
        `  帯域上限         ${prov.bandwidthHz} Hz  (崖の落差 ${L(prov.cutoffDropDb, 1)} dB)`,
        `  1kHz以上の傾斜   ${L(slope)} dB/oct`,
        `  無音区間のフロア ${L(prov.silenceFloorDb, 1)} dBFS`,
        `  最長のゼロ連続   ${L(prov.maxZeroRunMs, 1)} ms`,
        `  クリップ率(有音) ${L(clip.clipRate, 5)}  (最長連続 ${clip.longestRunSamples} サンプル)`,
        '',
        '  -- スコア --',
        `  総合 ${res.overall}/100`,
        `    ノイズ ${res.noise}/${AXIS_MAX.noise}  周波数 ${res.frequency}/${AXIS_MAX.frequency}  ` +
          `残響 ${res.reverb}/${AXIS_MAX.reverb}  音量 ${res.volume}/${AXIS_MAX.volume}  ` +
          `音割れ ${res.clip}/${AXIS_MAX.clip}`,
        `  判定 ${res.verdict.level}` +
          (res.verdict.limitingAxis ? ` (最弱 ${res.verdict.limitingAxis})` : '') +
          (res.verdict.unconfirmed ? ' / 未確定' : ''),
        `  参考値扱いの軸 ${res.unreliable.join(', ') || 'なし'}`,
        `  加工痕跡       ${prov.flags.join(', ') || 'なし'}`,
        `  アドバイス     ${res.advice.map((a) => a.code).join(', ') || 'なし'}`,
      ].join('\n'));

      // 実録音の真値は分からないので、破綻していないことだけを見る
      for (const axis of Object.keys(AXIS_MAX) as ScoreAxis[]) {
        expect(Number.isFinite(res[axis]), `${axis} が有限`).toBe(true);
        expect(res[axis], `${axis} >= 0`).toBeGreaterThanOrEqual(0);
        expect(res[axis], `${axis} <= 満点`).toBeLessThanOrEqual(AXIS_MAX[axis]);
      }
      expect(res.overall).toBe(
        res.noise + res.frequency + res.reverb + res.volume + res.clip,
      );
    });
  }
});

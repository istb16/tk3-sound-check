/** 音質チェックの文言。他の機能はそれぞれ自分の i18n.ts を持つ。 */
import type { Lang } from '../../shell/i18n.ts';
import type { AdviceCode } from './AudioAnalyzer.ts';
import { MIC_DENIED } from '../common-text.ts';

export type CategoryKey = 'volume' | 'frequency' | 'reverb' | 'clip' | 'noise';
export type GradeKey = 'good' | 'ok' | 'warn' | 'bad';
export type VerdictKey = 'good' | 'usable' | 'poor';

export type QualityText = {
  /** 機能名。アプリ全体の名前（サウンドチェック）とは別物 */
  name: string;
  /** メニューのタイルに出す一行説明 */
  summary: string;
  dropMain: string;
  dropSub: string;
  dropAriaLabel: string;
  or: string;
  micBtn: (sec: number) => string;
  errorInvalidFile: string;
  errorAnalysis: (msg: string) => string;
  errorMicDenied: string;
  errorRecording: (msg: string) => string;
  vuAriaLabel: (score: number) => string;
  grades: Record<GradeKey, string>;
  categoryNames: Record<CategoryKey, string>;
  categoryDescs: Record<CategoryKey, string>;
  resetBtn: string;
  radarLabels: string[];
  adviceLabel: string;
  /**
   * アドバイス文面。数値を埋めるものだけ関数にする。
   * value の意味はコードごと（AudioAnalyzer.AdviceItem 参照）。
   */
  adviceTexts: Record<AdviceCode, string | ((value: number) => string)>;
  /** 加工済み音声の警告パネル */
  provenanceLabel: string;
  /**
   * この録音に見られる加工の説明。
   *
   * 加工そのものを欠点として扱わないので、対処を促す文面にはしない。
   * スコアがどう出ているかを理解するための情報として出す。
   */
  provenanceIntro: string;
  provenanceBandLimited: (hz: number) => string;
  provenanceDigitalSilence: string;
  provenanceZeroRun: string;
  provenanceRawFallback: string;
  /** 信用できない軸に付けるバッジ */
  provenanceUnreliable: string;
  provenanceUnreliableTitle: string;
  /** 判定パネル */
  verdictLabel: string;
  verdicts: Record<VerdictKey, string>;
  verdictLimitedBy: (axis: string) => string;
  /** スコアは良好だが、測定できなかった軸があるため断定できない場合 */
  verdictUnconfirmed: (axis: string) => string;
  factsLabel: string;
  factSnr: (db: number) => string;
  /**
   * 残響時間の表示。**小数1桁より細かく出してはいけない。**
   * 推定誤差は確定値でも MAE 0.05秒、参考値を含めると 0.17秒あり、
   * 2桁で出すと持っていない精度を主張することになる（実際に2桁で出していた）。
   */
  factRt60: (sec: number) => string;
  factRt60Unknown: string;
  factBandwidth: (hz: number) => string;
  factLevel: (dbfs: number) => string;
  factClipNone: string;
  factClip: (percent: number) => string;
  /** 録音前の案内 */
  micHint: string;
  /** 録音をWAVで保存するリンクの文面 */
  saveWav: string;
  saveWavHint: string;
  micScriptLabel: string;
  micScript: string[];
};

export const T: Record<Lang, QualityText> = {
  ja: {
    name:          '音質チェック',
    summary:       '録音した音声が会議に使えるかを5軸で採点します。',
    dropMain:      'WAV / MP3 をドロップ',
    dropSub:       'クリックしてファイルを選択',
    dropAriaLabel: 'ファイルをドロップするか、クリックして選択',
    or:            'または',
    micBtn:        (sec) => `マイクで録音（${sec}秒）`,
    errorInvalidFile: 'WAV または MP3 ファイルを選択してください。',
    errorAnalysis:    (msg) => `解析に失敗しました: ${msg}`,
    // 拒否したのはブラウザであって、こちらが何を測ろうとしていたかは関係が無い。
    // 3機能で同じ文を出す（features/common-text.ts）
    errorMicDenied:   MIC_DENIED.ja,
    errorRecording:   (msg) => `録音に失敗しました: ${msg}`,
    vuAriaLabel:      (score) => `総合スコア ${score}点`,
    grades: { good: '優秀', ok: '良好', warn: '普通', bad: '要改善' },
    categoryNames: {
      noise:     'ノイズ',
      reverb:    '残響',
      frequency: '周波数バランス',
      volume:    '音量',
      clip:      '音割れ',
    },
    categoryDescs: {
      noise:     '声に対する背景雑音の小ささ (SNR)',
      reverb:    '部屋の反響の少なさ (残響時間)',
      frequency: '必要な帯域と高音域のこもりのなさ',
      volume:    '発話区間の音量レベルの適切さ',
      clip:      'クリッピングのなさ',
    },
    resetBtn:    'もう一度チェックする',
    radarLabels: ['ノイズ', '残響', '周波数バランス', '音量', '音割れ'],
    adviceLabel: 'アドバイス',
    adviceTexts: {
      'level-low':  '全体的に音が小さめです。マイクに近づくか、入力ゲインを上げてください。',
      'level-high': '全体的に音が大きすぎます。入力ゲインを下げるか、マイクから少し離れてください。',
      'bandwidth-narrow': (hz) =>
        `高音域が不足しています（帯域上限 約${Math.round(hz / 100) / 10}kHz）。子音が聞き取りにくくなります。` +
        '圧縮率の低い形式で録音するか、このツールのマイク録音を使ってください。',
      muffled: (dbPerOct) =>
        `高音域が緩やかに落ちています（1kHz以上の傾斜 約${dbPerOct.toFixed(0)}dB/oct）。子音が聞き取りにくくなります。` +
        'マイクが服や机で覆われていないか、口元から遠すぎないかを確認してください。',
      'reverb-strong': (sec) =>
        `反響が強い部屋です（残響時間 約${sec.toFixed(1)}秒）。` +
        'カーテンやカーペットで反射を抑えるか、マイクを口元に近づけてください。',
      'reverb-unmeasurable':
        '残響を測定できませんでした。発話の切れ目が足りない可能性があります。' +
        '文の区切りで一拍おいて録音すると測定できます。',
      clipping: '音割れ（クリッピング）が検出されました。マイクの入力音量を下げるか、発声音量を少し抑えてください。',
      'noise-high': '背景ノイズが目立ちます。静かな環境で録音するか、ノイズの少ないマイクの使用を検討してください。',
    },
    provenanceLabel: 'この録音について',
    provenanceIntro:
      'この音声には次の加工が見られます。スコアはこの音声そのものに対する評価です。',
    provenanceBandLimited: (hz) =>
      `高音域が約 ${Math.round(hz / 100) / 10} kHz で切られています（圧縮・電話品質の痕跡）。` +
      '子音が聞き取りにくくなるぶんは周波数バランスの点数に含まれています。',
    provenanceDigitalSilence:
      '無音区間が不自然に静かです（ノイズ抑制の痕跡）。' +
      '背景ノイズは録音時に除去されています。部屋が静かだったことを意味するものではありません。',
    provenanceZeroRun:
      '完全な無音が長く連続しています（ノイズゲートまたはDTXの痕跡）。' +
      '話していない区間が切り落とされています。',
    provenanceRawFallback:
      'このブラウザでは生の音声を取得できず、圧縮された録音を分析しました。' +
      'ノイズのスコアは参考値です。',
    provenanceUnreliable: '参考値',
    provenanceUnreliableTitle: '加工の痕跡があるため、この軸のスコアは信用できません',
    verdictLabel: '判定',
    verdicts: {
      good:   'この環境は会議の録音に十分です。',
      usable: 'この環境でも会議はできますが、改善の余地があります。',
      poor:   'この環境は会議の録音に適していません。',
    },
    verdictLimitedBy: (axis) => `いちばん足を引っ張っているのは「${axis}」です。`,
    verdictUnconfirmed: (axis) =>
      `他の項目は良好ですが、「${axis}」を測定できなかったため、` +
      'この環境が会議に十分かどうかは確認できていません。',
    factsLabel: '実測値',
    factSnr:       (db) => `背景ノイズ: 声より ${db.toFixed(0)}dB 小さい`,
    factRt60:      (sec) => `残響時間: 約 ${sec.toFixed(1)} 秒`,
    factRt60Unknown: '残響時間: 測定できませんでした',
    factBandwidth: (hz) => `帯域上限: 約 ${(Math.round(hz / 100) / 10).toFixed(1)} kHz`,
    factLevel:     (dbfs) => `発話レベル: ${dbfs.toFixed(1)} dBFS`,
    factClipNone:  'クリッピング: なし',
    factClip:      (percent) => `クリッピング: 有音区間の ${percent.toFixed(2)}%`,
    micHint: '10秒間、いつも通りの声で話してください。文の区切りで一拍おくと、残響も測定できます。',
    saveWav: '録音をWAVで保存',
    saveWavHint: '解析したままの音声（32bit float・無圧縮）を保存します。',
    micScriptLabel: '読み上げ文の例',
    micScript: [
      'これはマイクのテストです。',
      'いま、静かな環境で録音しています。',
      'この部屋は会議に使えるでしょうか。',
    ],
  },
  en: {
    name:          'Audio Quality Check',
    summary:       'Scores a recording on five axes to say whether it is good enough for meetings.',
    dropMain:      'Drop WAV / MP3',
    dropSub:       'Click to select a file',
    dropAriaLabel: 'Drop a file or click to select',
    or:            'or',
    micBtn:        (sec) => `Record with mic (${sec}s)`,
    errorInvalidFile: 'Please select a WAV or MP3 file.',
    errorAnalysis:    (msg) => `Analysis failed: ${msg}`,
    errorMicDenied:   MIC_DENIED.en,
    errorRecording:   (msg) => `Recording failed: ${msg}`,
    vuAriaLabel:      (score) => `Overall score: ${score}`,
    grades: { good: 'Excellent', ok: 'Good', warn: 'Fair', bad: 'Poor' },
    categoryNames: {
      noise:     'Noise',
      reverb:    'Reverberation',
      frequency: 'Frequency Balance',
      volume:    'Volume',
      clip:      'Clipping',
    },
    categoryDescs: {
      noise:     'Background noise relative to speech (SNR)',
      reverb:    'Absence of room reverberation (RT60)',
      frequency: 'Sufficient bandwidth, no muffling of high frequencies',
      volume:    'Appropriate level during active speech',
      clip:      'Absence of clipping/distortion',
    },
    resetBtn:    'Check again',
    radarLabels: ['Noise', 'Reverberation', 'Frequency Balance', 'Volume', 'Clipping'],
    adviceLabel: 'Advice',
    adviceTexts: {
      'level-low':  'The audio is a little quiet overall. Move closer to the microphone or raise the input gain.',
      'level-high': 'The audio is too loud overall. Lower the input gain or move away from the microphone a little.',
      'bandwidth-narrow': (hz) =>
        `High frequencies are missing (bandwidth about ${Math.round(hz / 100) / 10} kHz), which makes consonants hard to hear. ` +
        'Record in a less compressed format, or use this tool\u2019s microphone recording.',
      muffled: (dbPerOct) =>
        `High frequencies roll off gradually (slope about ${dbPerOct.toFixed(0)} dB/oct above 1 kHz), ` +
        'which makes consonants hard to hear. Check that the microphone is not covered by clothing or a desk, and that it is not too far from your mouth.',
      'reverb-strong': (sec) =>
        `This room is quite reverberant (reverberation time about ${sec.toFixed(1)} s). ` +
        'Add curtains or a rug to absorb reflections, or bring the microphone closer to your mouth.',
      'reverb-unmeasurable':
        'Reverberation could not be measured \u2014 there may not be enough gaps between phrases. ' +
        'Pausing briefly between sentences makes it measurable.',
      clipping: 'Clipping (distortion) was detected. Lower the microphone input level, or speak a little more softly.',
      'noise-high': 'Background noise is noticeable. Record in a quieter place, or consider a microphone with a lower noise floor.',
    },
    provenanceLabel: 'About this recording',
    provenanceIntro:
      'The following processing is present in this audio. The scores describe this audio as it is.',
    provenanceBandLimited: (hz) =>
      `High frequencies are cut off at about ${Math.round(hz / 100) / 10} kHz (a sign of compression or telephone-grade audio). ` +
      'The resulting loss of consonant clarity is already reflected in the frequency balance score.',
    provenanceDigitalSilence:
      'The silent passages are unnaturally quiet (a sign of noise suppression). ' +
      'Background noise was removed during recording, which does not mean the room itself was quiet.',
    provenanceZeroRun:
      'There are long runs of absolute silence (a sign of a noise gate or DTX). ' +
      'The passages where nobody spoke have been cut away.',
    provenanceRawFallback:
      'This browser could not provide raw audio, so a compressed recording was analysed. ' +
      'The noise score is indicative only.',
    provenanceUnreliable: 'indicative',
    provenanceUnreliableTitle: 'Signs of processing were found — this score is not trustworthy',
    verdictLabel: 'Verdict',
    verdicts: {
      good:   'This environment is good enough for recording meetings.',
      usable: 'Meetings will work here, but there is room for improvement.',
      poor:   'This environment is not suitable for recording meetings.',
    },
    verdictLimitedBy: (axis) => `The limiting factor is ${axis}.`,
    verdictUnconfirmed: (axis) =>
      `Everything else looks good, but ${axis} could not be measured, ` +
      'so we cannot confirm this environment is good enough for meetings.',
    factsLabel: 'Measurements',
    factSnr:       (db) => `Background noise: ${db.toFixed(0)} dB below speech`,
    factRt60:      (sec) => `Reverberation time: about ${sec.toFixed(1)} s`,
    factRt60Unknown: 'Reverberation time: could not be measured',
    factBandwidth: (hz) => `Bandwidth: about ${(Math.round(hz / 100) / 10).toFixed(1)} kHz`,
    factLevel:     (dbfs) => `Speech level: ${dbfs.toFixed(1)} dBFS`,
    factClipNone:  'Clipping: none',
    factClip:      (percent) => `Clipping: ${percent.toFixed(2)}% of active audio`,
    micHint: 'Speak normally for 10 seconds. Pausing between sentences lets us measure reverberation too.',
    saveWav: 'Save recording as WAV',
    saveWavHint: 'Saves exactly what was analysed (32-bit float, uncompressed).',
    micScriptLabel: 'Example script',
    micScript: [
      'This is a microphone test.',
      'I am recording in a quiet room.',
      'Would this room work for a meeting?',
    ],
  },
};


/**
 * WAVの書き出し。
 *
 * 解析したそのものの音声を保存できるようにするために持つ。マイク録音の経路は
 * AudioWorklet で生PCMを取っているので、32bit float で書き出せばコーデックを
 * 一度も通らないファイルになる。
 *
 * 16bit ではなく float を使うのは、解析した値と保存した値を一致させるため。
 * 量子化すると無音区間のノイズフロアが書き換わり、保存したファイルを測り直した
 * ときに元の判定と合わなくなる（このツールが測っているのはまさにそこ）。
 */

const WAV_HEADER_BYTES = 44;
/** WAVEフォーマットタグ: 3 = IEEE float */
const FORMAT_IEEE_FLOAT = 3;
const BITS_PER_SAMPLE = 32;

/**
 * モノラルの Float32Array を 32bit float の WAV にする。
 * サンプル値は変換せずそのまま書く。
 */
export function encodeWavFloat32(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 4;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  const channels = 1;
  const bytesPerSample = BITS_PER_SAMPLE / 8;

  writeAscii(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(8, 'WAVE');

  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);                                   // fmt チャンクの長さ
  view.setUint16(20, FORMAT_IEEE_FLOAT, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // バイト/秒
  view.setUint16(32, channels * bytesPerSample, true);              // ブロックサイズ
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(WAV_HEADER_BYTES + i * 4, samples[i], true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/** 保存用のファイル名。同じ録音を並べても区別できるよう秒まで入れる */
export function wavFileName(now: Date): string {
  const p = (v: number): string => String(v).padStart(2, '0');
  return `recording-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.wav`;
}

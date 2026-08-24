/**
 * 最小構成の WAV 読み書き。
 *
 * ffmpeg などの外部依存を持たずにコーパスを扱えるようにするための実装。
 * 読み込みは PCM 8/16/24/32bit 整数と 32bit float、複数チャンネルはモノラルへ
 * ダウンミックスする。書き出しは 16bit PCM モノラル固定。
 */

export interface WavAudio {
  samples: Float32Array;
  sampleRate: number;
  /** 元ファイルのチャンネル数（ダウンミックス前） */
  sourceChannels: number;
  /** 元ファイルのビット深度 */
  sourceBitDepth: number;
}

const FORMAT_PCM   = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXT   = 0xfffe;

export function decodeWav(buf: ArrayBuffer): WavAudio {
  const view = new DataView(buf);
  const tag = (off: number): string =>
    String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAVファイルではありません');

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataLength = 0;

  // チャンクを走査する（LIST や fact などの未知チャンクは読み飛ばす）
  let pos = 12;
  while (pos + 8 <= view.byteLength) {
    const id   = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;

    if (id === 'fmt ') {
      format     = view.getUint16(body, true);
      channels   = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth   = view.getUint16(body + 14, true);
      if (format === FORMAT_EXT && size >= 40) {
        // 拡張フォーマットは SubFormat の先頭2バイトが実フォーマット
        format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
    }

    pos = body + size + (size % 2); // チャンクは偶数境界
  }

  if (dataOffset < 0 || channels === 0) throw new Error('WAVのチャンクが不正です');

  const bytesPerSample = bitDepth / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const out = new Float32Array(frameCount);

  const readSample = (off: number): number => {
    if (format === FORMAT_FLOAT) {
      return bitDepth === 64 ? view.getFloat64(off, true) : view.getFloat32(off, true);
    }
    if (format !== FORMAT_PCM) throw new Error(`未対応のWAVフォーマット: ${format}`);
    switch (bitDepth) {
      case 8:  return (view.getUint8(off) - 128) / 128;
      case 16: return view.getInt16(off, true) / 32768;
      case 24: {
        const b0 = view.getUint8(off), b1 = view.getUint8(off + 1), b2 = view.getUint8(off + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v -= 0x1000000;
        return v / 8388608;
      }
      case 32: return view.getInt32(off, true) / 2147483648;
      default: throw new Error(`未対応のビット深度: ${bitDepth}`);
    }
  };

  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const base = dataOffset + f * bytesPerSample * channels;
    for (let c = 0; c < channels; c++) sum += readSample(base + c * bytesPerSample);
    out[f] = sum / channels;
  }

  return { samples: out, sampleRate, sourceChannels: channels, sourceBitDepth: bitDepth };
}

/** 16bit PCM モノラルの WAV を組み立てる */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(FORMAT_PCM, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * bytesPerSample);
  }
  return buf;
}

/**
 * 32bit float モノラルの WAV を組み立てる。
 *
 * 生成した検証用音声にはこちらを使う。16bit だと量子化ノイズフロア(約-96dBFS)が
 * 混入し、ノイズフロアの推定誤差を測るときの交絡要因になるため。
 */
export function encodeWavFloat32(samples: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 4;
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(FORMAT_FLOAT, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) buf.writeFloatLE(samples[i], 44 + i * bytesPerSample);
  return buf;
}

/**
 * 公開コーパスの実音声を読む。**テスト専用**（製品コードからは import しない）。
 *
 * 合成信号だけでは測れないものが1つある——**実際の声が「発振ではない」と
 * 言われ続けること**である。倍音列を合成した信号は倍音の強さが規則正しいので、
 * 倍音判定にとって都合が良すぎる。本物の声は母音・声道・声門の都合で倍音の強さが
 * フレームごとに大きく揺れ、そこで判定が外れる。合成の陰性12件を全部通しても、
 * 実音声では空振りする——実際にした。
 *
 * 素材は `fixtures/corpus/`（git管理外・`npm run fetch-corpus` で取得）。
 * **無いときは黙って null を返す。** CI には素材が無いので、あるときだけ効く
 * 追加の柵として置く。
 */

/** 素材の置き場。vite が開発サーバのルートから配る */
const CORPUS_URL = '/fixtures/corpus';

/**
 * コーパスの1本を、製品と同じサンプルレートの波形として読む。
 * 無い・復号できない場合は null。
 *
 * 復号は `decodeAudioData` に任せる。コーパスは16kHzなので変換が要るが、
 * ここで自前の補間を書くと**その補間の癖を検証してしまう**ので、製品が使うのと
 * 同じブラウザの経路に通す。
 */
export async function loadCorpusFile(
  name: string, sampleRate = 48000,
): Promise<Float32Array | null> {
  let res: Response;
  try {
    res = await fetch(`${CORPUS_URL}/${name}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) return null;

  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  try {
    const buf = await ctx.decodeAudioData(bytes);
    return buf.getChannelData(0).slice();
  } catch {
    return null;
  }
}

/** 実効値を target に揃えた複製を返す */
export function atRms(data: Float32Array, target: number): Float32Array {
  let sum = 0;
  for (const v of data) sum += v * v;
  const cur = Math.sqrt(sum / data.length);
  const g = cur === 0 ? 0 : target / cur;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * g;
  return out;
}

/** 2つの波形を足す（短いほうに合わせる） */
export function mix(a: Float32Array, b: Float32Array): Float32Array {
  const n = Math.min(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] + b[i];
  return out;
}

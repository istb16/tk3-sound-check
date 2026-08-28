/**
 * 音声の取り込み。
 *
 * 測定経路の原則: 分析にかけるサンプルには、ブラウザやコーデックの加工を
 * 一切通さない。
 *
 * - `getUserMedia` の DSP(echoCancellation / noiseSuppression / autoGainControl)
 *   は Chrome ではデフォルトで全てONになる。ONのままでは「静かな環境か」を
 *   測るのにブラウザが先にノイズを消し、「音量が適正か」を測るのに Chrome の
 *   自動ゲインの出力を測ってしまう。明示的に false を指定する。
 * - `MediaRecorder` の出力(WebM/Opus)は非可逆で、ノイズシェーピングにより
 *   無音区間のノイズフロア——まさに測りたいもの——を書き換える。さらに Opus の
 *   DTX は無音を完全な0にしうるため、provenance.ts の「処理済み音声」検出が
 *   自分自身の録音を誤検出する。したがって分析用には AudioWorklet で生PCMを
 *   直接取得し、MediaRecorder の出力は再生用にのみ使う。
 */

/** 分析を汚さないための録音時制約 */
const RAW_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl:  false,
};

/** ワークレットが main thread へ送るチャンクのサンプル数 */
const CHUNK_SIZE = 4096;

/**
 * 生PCM取り出し用のワークレット。
 * Vite のビルド構成に依存したくないので Blob URL から動的に読み込む。
 */
const PCM_WORKLET_SRC = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${CHUNK_SIZE});
    this.filled = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        if (this.filled > 0) this.port.postMessage(this.buf.slice(0, this.filled));
        this.filled = 0;
        this.port.postMessage('flushed');
      }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.filled++] = ch[i];
        if (this.filled === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export interface Recording {
  /** 分析対象のサンプル */
  buffer: AudioBuffer;
  /** 再生用（コーデック経由でよい） */
  blob: Blob;
  /**
   * 生PCMを直接取得できたか。false の場合はコーデック経由の復号に
   * フォールバックしており、ノイズフロアの測定値は信用できない。
   */
  rawCapture: boolean;
}

export async function decodeFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  // 注意: ここで指定したサンプルレートに強制リサンプルされるため、
  // 復号後の audioBuffer.sampleRate は元ファイルの帯域を一切反映しない。
  // 帯域上限は provenance.ts でスペクトルから実測する。
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(arrayBuffer);
}

/** 録音を途中で打ち切ったときの拒否理由。呼び出し側はこれをエラー表示しない */
export const RECORDING_ABORTED = 'RecordingAborted';

function abortedError(): Error {
  return Object.assign(new Error('recording aborted'), { name: RECORDING_ABORTED });
}

/**
 * 一定時間だけ録音する。
 *
 * `signal` を渡すと途中で打ち切れる。**画面を離れられたときに必ず渡すこと**——
 * 打ち切らないと、録音が終わるまでマイクが開いたまま（ブラウザの録音インジケータが
 * 点いたまま）になり、さらに解決後の `createObjectURL` が後片付けの後に走って
 * 解放されないURLが残る。
 */
export async function recordMicrophone(
  durationMs: number,
  onTick?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<Recording> {
  if (signal?.aborted) throw abortedError();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: RAW_AUDIO_CONSTRAINTS,
    video: false,
  });

  // 許可ダイアログが出ている間に離脱された場合。ここで閉じないと開きっぱなしになる
  if (signal?.aborted) {
    stream.getTracks().forEach((t) => t.stop());
    throw abortedError();
  }

  const ctx = new AudioContext();
  const capture = await setupRawCapture(ctx, stream);

  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];

  let onAbort: (() => void) | null = null;

  try {
    return await new Promise<Recording>((resolve, reject) => {
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType });
        try {
          const raw = capture ? await capture.finish() : null;
          if (raw && raw.length > 0) {
            const buffer = ctx.createBuffer(1, raw.length, ctx.sampleRate);
            buffer.copyToChannel(raw, 0);
            resolve({ buffer, blob, rawCapture: true });
          } else {
            // 生PCMが取れなかった場合のみコーデック経由にフォールバックする
            const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
            resolve({ buffer, blob, rawCapture: false });
          }
        } catch (err) {
          reject(err);
        }
      };

      recorder.onerror = (e) => reject(e);
      recorder.start();

      let elapsed = 0;
      const interval = setInterval(() => {
        elapsed += 100;
        onTick?.(elapsed / durationMs);
        if (elapsed >= durationMs) clearInterval(interval);
      }, 100);

      const timer = setTimeout(() => {
        clearInterval(interval);
        recorder.stop();
      }, durationMs);

      onAbort = () => {
        clearInterval(interval);
        clearTimeout(timer);
        // onstop を無効にしてから止める。中断した録音を解析に回さない
        recorder.onstop = null;
        if (recorder.state !== 'inactive') recorder.stop();
        reject(abortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  }
}

interface RawCapture {
  // copyToChannel は SharedArrayBuffer 由来の Float32Array を受け付けないため、
  // ArrayBuffer 裏付けであることを型で明示する
  finish: () => Promise<Float32Array<ArrayBuffer>>;
}

interface PcmWorklet {
  /** 溜まっている端数を吐き出させる */
  flush: () => Promise<void>;
  detach: () => void;
}

/**
 * ワークレットをつないで、PCMチャンクが届くたびに onChunk を呼ぶ。
 * ワークレットが使えない環境では null を返す。
 */
async function attachPcmWorklet(
  ctx: AudioContext,
  stream: MediaStream,
  onChunk: (samples: Float32Array) => void,
): Promise<PcmWorklet | null> {
  if (!ctx.audioWorklet) return null;

  const url = URL.createObjectURL(new Blob([PCM_WORKLET_SRC], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }

  const source = ctx.createMediaStreamSource(stream);
  const node   = new AudioWorkletNode(ctx, 'pcm-capture');

  // AudioWorkletNode は出力が引かれないと process() が呼ばれない。
  // ゲイン0で destination に繋いでスピーカーには出さずに駆動する。
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  let onFlushed: (() => void) | null = null;

  node.port.onmessage = (e) => {
    if (e.data === 'flushed') { onFlushed?.(); return; }
    onChunk(e.data as Float32Array);
  };

  return {
    flush: () => new Promise<void>((res) => {
      onFlushed = res;
      node.port.postMessage('flush');
      setTimeout(res, 200); // ワークレットが応答しない場合の保険
    }),
    detach: () => {
      source.disconnect();
      node.disconnect();
      mute.disconnect();
    },
  };
}

/**
 * AudioWorklet で生PCMを溜める。ワークレットが使えない環境では null を返し、
 * 呼び出し側はコーデック経由にフォールバックする。
 */
async function setupRawCapture(
  ctx: AudioContext,
  stream: MediaStream,
): Promise<RawCapture | null> {
  const parts: Float32Array[] = [];
  const worklet = await attachPcmWorklet(ctx, stream, (chunk) => { parts.push(chunk); });
  if (!worklet) return null;

  return {
    finish: async () => {
      // 溜まっている端数を吐き出させてから切断する
      await worklet.flush();
      worklet.detach();

      const total = parts.reduce((n, p) => n + p.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const p of parts) { merged.set(p, offset); offset += p.length; }
      return merged;
    },
  };
}

// ==========================================================================
// 連続監視（リアルタイム機能用）
// ==========================================================================

export interface Monitor {
  /** マイクを閉じ、AudioContext を破棄する。二度呼んでも安全 */
  stop: () => void;
  /** 解析側が周波数を扱うために必要 */
  sampleRate: number;
  /**
   * 実際に開いたマイクの名前。
   * 測定対象を取り違えたまま自信のある数字を出すのが診断ツールの最悪の壊れ方なので、
   * 何を測っているかは呼び出し側が表示できるようにしておく。
   */
  deviceLabel: string;
  /**
   * 端末側の自動ゲイン調整を切れなかったか。
   *
   * `getUserMedia` には `autoGainControl: false` を渡しているが、Android では
   * プラットフォーム層のAGCが取り込み経路に入っていて無効化できない機種がある。
   * 仕様上、切れない機器は `getSettings().autoGainControl` に true を報告する。
   *
   * **AGCがONだとレベル比較そのものが成立しない**（下げたぶんを端末が戻す）ので、
   * 制約を出しただけで済ませず、通ったかどうかを呼び出し側が表示できるようにする。
   * 報告が無い（undefined）ときは false——分からないことを警告に変えない。
   */
  autoGainControl: boolean;
}

/**
 * マイクを開き、チャンクが届くたびに onChunk を呼び続ける。止めるまで終わらない。
 *
 * `recordMicrophone` との違いは、溜めずに流すことと、再生用の MediaRecorder を
 * 持たないこと。リアルタイムに見るだけの機能は録音を残さない。
 */
export async function startMonitor(
  onChunk: (samples: Float32Array) => void,
): Promise<Monitor> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: RAW_AUDIO_CONSTRAINTS,
    video: false,
  });

  const ctx = new AudioContext();
  let worklet: PcmWorklet | null = null;
  try {
    // 自動再生ポリシーで suspended から始まることがある。動かないと process() が来ない
    if (ctx.state === 'suspended') await ctx.resume();
    worklet = await attachPcmWorklet(ctx, stream, onChunk);
  } catch {
    worklet = null;
  }

  if (!worklet) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    throw new Error('AudioWorklet is not available in this browser');
  }

  const attached = worklet;
  let stopped = false;

  const track = stream.getAudioTracks()[0];

  return {
    sampleRate:  ctx.sampleRate,
    deviceLabel: track?.label ?? '',
    autoGainControl: track?.getSettings?.().autoGainControl === true,
    stop: () => {
      if (stopped) return;
      stopped = true;
      attached.detach();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}

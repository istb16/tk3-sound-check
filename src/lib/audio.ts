export async function decodeFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(arrayBuffer);
}

export async function recordMicrophone(
  durationMs: number,
  onTick?: (progress: number) => void,
): Promise<{ buffer: AudioBuffer; blob: Blob }> {
  const stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];

  return new Promise<{ buffer: AudioBuffer; blob: Blob }>((resolve, reject) => {
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob        = new Blob(chunks, { type: recorder.mimeType });
      const arrayBuffer = await blob.arrayBuffer();
      try {
        const ctx         = new AudioContext();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        ctx.close();
        resolve({ buffer: audioBuffer, blob });
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

    setTimeout(() => {
      clearInterval(interval);
      recorder.stop();
    }, durationMs);
  });
}

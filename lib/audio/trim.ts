// Browser-side sample trimming for voice cloning. ai33 rejects samples
// over 30s, and telling the user to go edit an audio file is a dead end —
// take the first N seconds instead.
//
// Trimmed output is mono 16-bit WAV: half the bytes of stereo, and a
// container every provider accepts (a MediaRecorder webm/mp4 is the risky
// input, not this).

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);          // PCM header size
  view.setUint16(20, 1, true);           // format: PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** Returns the original file untouched when it's already short enough, so
 *  a valid mp3 is never needlessly re-encoded. `trimmed` says which. */
export async function trimAudioFile(
  file: File,
  maxSeconds: number,
): Promise<{ file: File; duration: number; trimmed: boolean }> {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("No AudioContext");
  const ctx = new Ctor();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    if (decoded.duration <= maxSeconds) {
      return { file, duration: decoded.duration, trimmed: false };
    }

    const frames = Math.floor(maxSeconds * decoded.sampleRate);
    const mono = new Float32Array(frames);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < frames; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }

    const wav = encodeWav(mono, decoded.sampleRate);
    const base = file.name.replace(/\.[^.]+$/, "") || "sample";
    return {
      file: new File([wav], `${base}-30s.wav`, { type: "audio/wav" }),
      duration: maxSeconds,
      trimmed: true,
    };
  } finally {
    void ctx.close();
  }
}

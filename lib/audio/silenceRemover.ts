import { Mp3Encoder } from "@breezystack/lamejs";

const SILENCE_THRESHOLD = 0.008; // RMS amplitude below which a chunk is considered silent
const CHUNK_MS = 30;             // analysis window in ms

export interface RemovePausesOptions {
  maxPauseMs?: number;    // pauses longer than this get trimmed (default 800ms)
  targetPauseMs?: number; // trimmed pauses become this long (default 300ms)
  threshold?: number;     // RMS silence cutoff (default 0.008)
}

export interface PauseRemovalResult {
  channels: Float32Array[];
  sampleRate: number;
  length: number;
  originalDuration: number;
  newDuration: number;
}

function chunkRms(data: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / (end - start));
}

export function removeLongPauses(
  buffer: AudioBuffer,
  options: RemovePausesOptions = {}
): PauseRemovalResult {
  const maxPauseMs = options.maxPauseMs ?? 800;
  const targetPauseMs = options.targetPauseMs ?? 300;
  const threshold = options.threshold ?? SILENCE_THRESHOLD;

  const { sampleRate, numberOfChannels, length: totalSamples } = buffer;
  const chunkSize = Math.round((CHUNK_MS / 1000) * sampleRate);
  const maxPauseSamples = Math.round((maxPauseMs / 1000) * sampleRate);
  const targetPauseSamples = Math.round((targetPauseMs / 1000) * sampleRate);

  const ch0 = buffer.getChannelData(0);
  const numChunks = Math.ceil(totalSamples / chunkSize);

  // Classify each chunk as silent or not using channel 0
  const silent = new Uint8Array(numChunks);
  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalSamples);
    silent[i] = chunkRms(ch0, start, end) < threshold ? 1 : 0;
  }

  // Build output regions, capping long silence runs
  type Region = { srcStart: number; srcEnd: number };
  const regions: Region[] = [];
  let i = 0;
  while (i < numChunks) {
    if (!silent[i]) {
      const start = i * chunkSize;
      while (i < numChunks && !silent[i]) i++;
      regions.push({ srcStart: start, srcEnd: Math.min(i * chunkSize, totalSamples) });
    } else {
      const start = i * chunkSize;
      while (i < numChunks && silent[i]) i++;
      const end = Math.min(i * chunkSize, totalSamples);
      const len = end - start;
      // Preserve short pauses; only trim ones longer than maxPauseMs
      const keepSamples = len > maxPauseSamples ? Math.min(targetPauseSamples, len) : len;
      regions.push({ srcStart: start, srcEnd: start + keepSamples });
    }
  }

  // Allocate output channels
  const outLength = regions.reduce((s, r) => s + (r.srcEnd - r.srcStart), 0);
  const channels: Float32Array[] = Array.from({ length: numberOfChannels }, () => new Float32Array(outLength));

  let offset = 0;
  for (const { srcStart, srcEnd } of regions) {
    const len = srcEnd - srcStart;
    for (let c = 0; c < numberOfChannels; c++) {
      channels[c].set(buffer.getChannelData(c).subarray(srcStart, srcEnd), offset);
    }
    offset += len;
  }

  return {
    channels,
    sampleRate,
    length: outLength,
    originalDuration: totalSamples / sampleRate,
    newDuration: outLength / sampleRate,
  };
}

function toInt16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, data[i])) * 32767);
  }
  return out;
}

export function encodeMp3(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numChannels = channels.length;
  const encoder = new Mp3Encoder(numChannels, sampleRate, 128);
  const BLOCK = 1152; // samples per MP3 frame

  const left = toInt16(channels[0]);
  const right = numChannels > 1 ? toInt16(channels[1]) : undefined;
  const numSamples = channels[0].length;

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < numSamples; i += BLOCK) {
    const l = left.subarray(i, i + BLOCK);
    const chunk = right
      ? encoder.encodeBuffer(l, right.subarray(i, i + BLOCK))
      : encoder.encodeBuffer(l);
    if (chunk.length > 0) chunks.push(chunk);
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}

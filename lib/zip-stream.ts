import "server-only";

// A ZIP file written as it is read, never held whole.
//
// JSZip is already a dependency and would be less code, but it keeps every
// entry's bytes in memory until the archive is generated. A project here can
// carry 200+ images and as many clips, which is hundreds of megabytes, and the
// function would be killed long before the download started.
//
// So this writes the archive format directly, one entry at a time, and yields
// the bytes as they are produced. Memory stays flat whatever the archive
// weighs: one file's chunk at a time, plus a small record per entry for the
// central directory at the end.
//
// Stored, not deflated. Images and video are already compressed, so deflate
// would spend CPU to save nothing, and storing lets each entry be copied
// straight through.

/** Local file headers are written before the size and CRC of the entry are
 *  known, so both are declared in a data descriptor after the data instead.
 *  Bit 3 is what tells a reader to expect that. */
const FLAG_DATA_DESCRIPTOR = 0x08;

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is what the format stores. Seconds have
 *  two-second resolution in ZIP; that is the format's limitation, not a bug. */
function dosDateTime(d: Date): { date: number; time: number } {
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

export interface ZipEntry {
  /** Path inside the archive. Slashes make folders. */
  name: string;
  /** Opened only when this entry's turn comes, so an export of two hundred
   *  files holds one connection at a time rather than two hundred. */
  open: () => Promise<ReadableStream<Uint8Array> | null>;
}

/**
 * Stream a ZIP archive of `entries`.
 *
 * An entry whose `open` returns null or throws is skipped rather than failing
 * the archive: one unreachable image should not cost the user the other two
 * hundred. `onSkip` reports those so the caller can log or count them.
 */
export function zipStream(
  entries: ZipEntry[],
  opts?: { onSkip?: (name: string, reason: string) => void },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const now = dosDateTime(new Date());

  type Central = {
    name: Uint8Array; crc: number; size: number; offset: number;
  };
  const central: Central[] = [];
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (bytes: Uint8Array) => {
        controller.enqueue(bytes);
        offset += bytes.length;
      };

      for (const entry of entries) {
        let body: ReadableStream<Uint8Array> | null = null;
        try { body = await entry.open(); }
        catch (e) { opts?.onSkip?.(entry.name, e instanceof Error ? e.message : "could not open"); continue; }
        if (!body) { opts?.onSkip?.(entry.name, "not available"); continue; }

        const nameBytes = encoder.encode(entry.name);
        const localOffset = offset;

        const header = new DataView(new ArrayBuffer(30));
        header.setUint32(0, SIG_LOCAL, true);
        header.setUint16(4, 20, true);                    // version needed
        header.setUint16(6, FLAG_DATA_DESCRIPTOR, true);
        header.setUint16(8, 0, true);                     // stored
        header.setUint16(10, now.time, true);
        header.setUint16(12, now.date, true);
        header.setUint32(14, 0, true);                    // crc, in the descriptor
        header.setUint32(18, 0, true);                    // compressed size, ditto
        header.setUint32(22, 0, true);                    // uncompressed size, ditto
        header.setUint16(26, nameBytes.length, true);
        header.setUint16(28, 0, true);                    // no extra field
        push(new Uint8Array(header.buffer));
        push(nameBytes);

        let crc = 0;
        let size = 0;
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.length) continue;
            crc = crc32(crc, value);
            size += value.length;
            push(value);
          }
        } finally {
          reader.releaseLock();
        }

        const descriptor = new DataView(new ArrayBuffer(16));
        descriptor.setUint32(0, SIG_DESCRIPTOR, true);
        descriptor.setUint32(4, crc, true);
        descriptor.setUint32(8, size, true);
        descriptor.setUint32(12, size, true);
        push(new Uint8Array(descriptor.buffer));

        central.push({ name: nameBytes, crc, size, offset: localOffset });
      }

      const dirStart = offset;
      for (const e of central) {
        const rec = new DataView(new ArrayBuffer(46));
        rec.setUint32(0, SIG_CENTRAL, true);
        rec.setUint16(4, 20, true);                       // version made by
        rec.setUint16(6, 20, true);                       // version needed
        rec.setUint16(8, FLAG_DATA_DESCRIPTOR, true);
        rec.setUint16(10, 0, true);                       // stored
        rec.setUint16(12, now.time, true);
        rec.setUint16(14, now.date, true);
        rec.setUint32(16, e.crc, true);
        rec.setUint32(20, e.size, true);
        rec.setUint32(24, e.size, true);
        rec.setUint16(28, e.name.length, true);
        rec.setUint16(30, 0, true);                       // extra
        rec.setUint16(32, 0, true);                       // comment
        rec.setUint16(34, 0, true);                       // disk
        rec.setUint16(36, 0, true);                       // internal attrs
        rec.setUint32(38, 0, true);                       // external attrs
        rec.setUint32(42, e.offset, true);
        push(new Uint8Array(rec.buffer));
        push(e.name);
      }

      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, SIG_END, true);
      end.setUint16(4, 0, true);
      end.setUint16(6, 0, true);
      end.setUint16(8, central.length, true);
      end.setUint16(10, central.length, true);
      end.setUint32(12, offset - dirStart, true);
      end.setUint32(16, dirStart, true);
      end.setUint16(20, 0, true);                         // no comment
      push(new Uint8Array(end.buffer));

      controller.close();
    },
  });
}

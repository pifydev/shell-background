/**
 * Read the tail of a growing log without loading the whole file.
 *
 * A background command writes its stdout and stderr straight into a file (see
 * spawn.ts), so the status tool must read it back cheaply — a chatty job can
 * produce megabytes, and `readFileSync` on that just to show the last screen is
 * how a poll turns into an OOM. So seek to the end and read a bounded window.
 *
 * The window can begin mid-character: a multibyte UTF-8 sequence split at the
 * cut would decode to a replacement char, so when we did not start at byte 0 we
 * drop the leading continuation bytes (0b10xxxxxx) until a real character
 * boundary. Zero dependencies — node:fs only.
 */
import { openSync, fstatSync, readSync, closeSync } from "node:fs";

export interface Tail {
  /** The decoded trailing text. */
  text: string;
  /** True if bytes before the window were dropped. */
  truncated: boolean;
  /** Total size of the file in bytes. */
  bytes: number;
}

export const DEFAULT_TAIL_BYTES = 64 * 1024;

export function readTail(path: string, maxBytes: number = DEFAULT_TAIL_BYTES): Tail {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { text: "", truncated: false, bytes: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { text: "", truncated: false, bytes: 0 };
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    let slice = buf.subarray(0, read);
    if (start > 0) {
      // Drop a leading partial UTF-8 char left by cutting mid-sequence.
      let i = 0;
      while (i < slice.length && (slice[i]! & 0xc0) === 0x80) i++;
      slice = slice.subarray(i);
    }
    return { text: slice.toString("utf8"), truncated: start > 0, bytes: size };
  } catch {
    return { text: "", truncated: false, bytes: 0 };
  } finally {
    closeSync(fd);
  }
}

/** Non-empty line count of a chunk of text. */
export function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

const CR = 0x0d;
const LF = 0x0a;
const BOM = [0xef, 0xbb, 0xbf];

function hasBom(raw: Buffer): boolean {
  return raw.length >= 3 && BOM.every((byte, index) => raw[index] === byte);
}

/**
 * The line-ending normalisation the stamp depends on, without decoding the bytes first — the
 * stamp hashes whatever is in a source tree, including files that are not text at all.
 */
export function normaliseEolBytes(input: Buffer): Buffer {
  const raw = hasBom(input) ? input.subarray(3) : input;
  if (!raw.includes(CR)) return raw;
  const out = Buffer.allocUnsafe(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    // Runs once per byte of every file the stamp hashes.
    // biome-ignore lint/style/noNonNullAssertion: hot path — `.entries()` allocates per iteration
    const byte = raw[i]!;
    if (byte === CR) {
      if (raw[i + 1] === LF) continue;
      out[n++] = LF;
      continue;
    }
    out[n++] = byte;
  }
  return out.subarray(0, n);
}

/**
 * A UTF-8 BOM is invisible to the author who introduced it — a Windows editor or a PowerShell
 * redirect writes it silently — but it makes the first line `﻿---`, which is not a fence.
 * Stripping it beats rejecting it: the file the author sees is the file the compiler reads.
 *
 * Defined over the byte form rather than beside it, because the compiler reads the text and the
 * stamp hashes the bytes: two implementations that agree today would decide staleness on
 * different content the day they stop agreeing, and nothing would report it.
 *
 * That round trip costs one precondition: pass text that came from a UTF-8 decode, not an
 * arbitrary JS string. Encoding back to UTF-8 replaces a lone surrogate with U+FFFD, so this is
 * identity only for strings that already survived a decode. Every call site reads its text with
 * `fs.readFileSync(..., "utf8")`, which has made that same substitution before this sees it.
 */
export function normaliseEol(text: string): string {
  return normaliseEolBytes(Buffer.from(text, "utf8")).toString("utf8");
}

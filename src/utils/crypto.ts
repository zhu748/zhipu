/**
 * Timing-safe string comparison.
 *
 * Delegates to Node's native `crypto.timingSafeEqual` for constant-time
 * comparison of equal-length Buffers. We pad to the longer string's length
 * first (with a fixed byte) so length differences don't short-circuit the
 * native call — this avoids leaking length information via early returns.
 *
 * @returns true iff both strings are byte-equal AND have the same length.
 */
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

export function timingSafeEqual(a: string, b: string): boolean {
  // Encode both to UTF-8 Buffers once. UTF-8 is the right encoding here
  // because API keys are ASCII / UTF-8 strings; encoding mismatches with
  // charCodeAt (which returns UTF-16 code units) could let two distinct
  // strings compare equal in edge cases involving surrogate pairs.
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  // If lengths differ, we still want to do a constant-amount of work so the
  // caller can't infer the expected length from the response time. Pad the
  // shorter buffer with zeros to match the longer one's length, then run the
  // native constant-time comparison. The XOR of differing lengths guarantees
  // the result is false even if the padded bytes happen to match.
  if (aBuf.length !== bBuf.length) {
    const maxLen = Math.max(aBuf.length, bBuf.length);
    const aPad = Buffer.alloc(maxLen);
    const bPad = Buffer.alloc(maxLen);
    aBuf.copy(aPad);
    bBuf.copy(bPad);
    // Run the comparison for its timing side-effect, but ignore the result —
    // length mismatch already decides the outcome.
    nodeTimingSafeEqual(aPad, bPad);
    return false;
  }
  return nodeTimingSafeEqual(aBuf, bBuf);
}

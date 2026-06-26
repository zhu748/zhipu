/**
 * Identity header builder — emits the headers ZCode actually sends upstream.
 *
 * Based on reverse-engineered ZCode Electron client traffic (2026-06):
 * ZCode uses the Vercel AI SDK's anthropic provider, NOT a custom UA. The
 * real User-Agent is `ai-sdk/anthropic/{version}` (e.g. `ai-sdk/anthropic/3.0.81`).
 *
 * The previous implementation injected four "ZCode desktop" headers
 * (X-ZCode-App-Version / X-Title / X-ZCode-Agent / HTTP-Referer) that the
 * real client NEVER sends. These were strong WAF fingerprint signals —
 *.aliyun WAF scored them as "claiming to be ZCode but missing real client
 * signals" and started blocking.
 *
 * @see _reverse/NOTEPAD.md "Real ZCode Request Headers (2026-06)"
 */
import type { ProxyIdentity } from "../config/types.js";

export interface IdentityHeaders {
  "User-Agent": string;
}

/** AI SDK anthropic provider version — matches the bundled ZCode client. */
const AI_SDK_VERSION = "3.0.81";

/**
 * Build the identity headers injected upstream.
 *
 * Only User-Agent is injected — matching the real ZCode client which uses
 * the Vercel AI SDK and sends NO custom identity headers. The previous
 * implementation's four fake headers (X-ZCode-App-Version etc.) were a
 * primary WAF fingerprint and have been removed.
 *
 * The `id` parameter is kept for backwards compatibility (config still
 * loads identity block) but its fields are no longer used to build headers.
 */
export function buildIdentityHeaders(_id: ProxyIdentity): IdentityHeaders {
  return {
    "User-Agent": `ai-sdk/anthropic/${AI_SDK_VERSION}`,
  };
}

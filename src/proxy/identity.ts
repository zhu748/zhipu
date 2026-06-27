/**
 * Identity header builder — emits the headers ZCode actually sends upstream.
 *
 * Based on reverse-engineering the ZCode Electron client's app.asar
 * (buildZCodeSourceHeaders / withZCodeEndpointHeaders, 2026-06):
 *
 *   User-Agent:           ZCode/{appVersion}        (e.g. ZCode/3.1.8)
 *   X-ZCode-App-Version:  {appVersion}
 *   HTTP-Referer:         https://zcode.z.ai
 *   X-Title:              Z Code@electron
 *   X-Platform:           {platform}-{arch}         (e.g. win32-x64)
 *   X-Release-Channel:    {channel}                 (only when set)
 *   X-Client-Language:    {Intl locale}             (e.g. zh-CN)
 *   X-Client-Timezone:    {Intl timeZone}           (e.g. Asia/Shanghai)
 *   X-Os-Category:        macos | windows | linux
 *   X-Os-Version:         {os.release()}            (only when set)
 *
 * IMPORTANT: the real client sends `ZCode/{appVersion}` as the User-Agent,
 * NOT the Vercel AI SDK's `ai-sdk/anthropic/{version}`. A previous revision
 * (see git history) shipped `ai-sdk/anthropic/3.0.81` and stripped all the
 * X-ZCode-* / X-Title / HTTP-Referer headers — that was based on a flawed
 * reverse-engineering note and is the OPPOSITE of what the real client does.
 * The client proves it IS ZCode precisely via these identity headers; a
 * request that claims to be ZCode but omits them is itself a fingerprint.
 */
import os from "node:os";
import type { ProxyIdentity } from "../config/types.js";

export interface IdentityHeaders {
  "User-Agent": string;
  "X-ZCode-App-Version": string;
  "HTTP-Referer": string;
  "X-Title": string;
  "X-Platform": string;
  "X-Client-Language": string;
  "X-Client-Timezone": string;
  "X-Os-Category": string;
  "X-Os-Version": string;
}

/**
 * Map process.platform → the value the real client puts in X-Os-Category.
 * Matches buildZCodeSourceHeaders' R5() switch.
 */
function osCategory(platform: NodeJS.Platform | string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

/**
 * Build the identity headers injected upstream — matching the real ZCode
 * client's buildZCodeSourceHeaders() output.
 *
 * Environmental headers (X-Platform / X-Client-* / X-Os-*) are taken from the
 * proxy's runtime environment, the closest faithful reproduction of what the
 * client emits on its own host.
 */
export function buildIdentityHeaders(id: ProxyIdentity): IdentityHeaders {
  const appVersion = id.appVersion || "unknown";
  const platform = os.platform();
  const arch = os.arch();

  let clientLanguage = "unknown";
  let clientTimezone = "unknown";
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions();
    if (opts.locale) clientLanguage = opts.locale;
    if (opts.timeZone) clientTimezone = opts.timeZone;
  } catch {
    /* keep defaults */
  }

  let osVersion = "";
  try {
    osVersion = os.release() || "";
  } catch {
    /* keep empty */
  }

  const headers: IdentityHeaders = {
    "User-Agent": `ZCode/${appVersion}`,
    "X-ZCode-App-Version": appVersion,
    "HTTP-Referer": id.refererOrigin || "https://zcode.z.ai",
    "X-Title": id.sourceTitle || "Z Code@electron",
    "X-Platform": `${platform}-${arch}`,
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    "X-Os-Category": osCategory(platform),
    "X-Os-Version": osVersion,
  };
  return headers;
}

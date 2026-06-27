/**
 * Tests for identity header builder.
 *
 * Verified against the ZCode Electron client's app.asar
 * (buildZCodeSourceHeaders / withZCodeEndpointHeaders, 2026-06). The real
 * client sends `ZCode/{appVersion}` as User-Agent plus the full X-ZCode-* /
 * X-Title / HTTP-Referer identity set.
 */
import { describe, it, expect } from "bun:test";
import { buildIdentityHeaders } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const BASE: ProxyIdentity = {
  appVersion: "3.1.8",
  sourceTitle: "Z Code@electron",
  refererOrigin: "https://zcode.z.ai",
};

describe("buildIdentityHeaders", () => {
  it("emits User-Agent as ZCode/{appVersion} (matches real ZCode client)", () => {
    const h = buildIdentityHeaders(BASE);
    // Real ZCode client UA, captured from app.asar buildZCodeSourceHeaders().
    expect(h["User-Agent"]).toBe("ZCode/3.1.8");
  });

  it("emits X-ZCode-App-Version (real ZCode client sends it)", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "9.9.9" });
    expect(h["X-ZCode-App-Version"]).toBe("9.9.9");
    expect(h["User-Agent"]).toBe("ZCode/9.9.9");
  });

  it("emits X-Title from sourceTitle (real ZCode client sends it)", () => {
    const h = buildIdentityHeaders({ ...BASE, sourceTitle: "Z Code@electron" });
    expect(h["X-Title"]).toBe("Z Code@electron");
  });

  it("emits HTTP-Referer from refererOrigin (real ZCode client sends it)", () => {
    const h = buildIdentityHeaders({ ...BASE, refererOrigin: "https://zcode.z.ai" });
    expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai");
  });

  it("emits X-Platform as {platform}-{arch}", () => {
    const h = buildIdentityHeaders(BASE) as unknown as Record<string, string>;
    // Format: <process.platform>-<os.arch>, e.g. win32-x64 / linux-x64.
    expect(h["X-Platform"]).toMatch(/^[a-z0-9]+-[a-z0-9]+$/i);
  });

  it("emits X-Os-Category mapped from platform (windows|macos|linux)", () => {
    const h = buildIdentityHeaders(BASE) as unknown as Record<string, string>;
    expect(["windows", "macos", "linux"]).toContain(h["X-Os-Category"]);
  });

  it("emits X-Client-Language and X-Client-Timezone", () => {
    const h = buildIdentityHeaders(BASE) as unknown as Record<string, string>;
    expect(h["X-Client-Language"]).toBeTruthy();
    expect(h["X-Client-Timezone"]).toBeTruthy();
  });

  it("falls back gracefully when appVersion is empty", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "" });
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-ZCode-App-Version"]).toBe("unknown");
  });
});

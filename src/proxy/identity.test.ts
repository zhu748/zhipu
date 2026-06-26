/**
 * Tests for identity header builder.
 *
 * Updated 2026-06: real ZCode client uses Vercel AI SDK's anthropic provider,
 * sending ONLY `User-Agent: ai-sdk/anthropic/{version}`. The four "ZCode
 * desktop" headers (X-ZCode-App-Version / X-Title / X-ZCode-Agent /
 * HTTP-Referer) were removed — they were WAF fingerprint signals.
 *
 * @see _reverse/NOTEPAD.md "Real ZCode Request Headers (2026-06)"
 */
import { describe, it, expect } from "bun:test";
import { buildIdentityHeaders } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const BASE: ProxyIdentity = {
  appVersion: "1.2.3",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

describe("buildIdentityHeaders", () => {
  it("emits User-Agent as ai-sdk/anthropic/{version} (matches real ZCode client)", () => {
    const h = buildIdentityHeaders(BASE);
    // Real ZCode client UA, captured from reverse-engineered traffic.
    expect(h["User-Agent"]).toBe("ai-sdk/anthropic/3.0.81");
  });

  it("does NOT emit X-ZCode-App-Version (real ZCode client doesn't send it)", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "9.9.9" }) as unknown as Record<string, string | undefined>;
    expect(h["X-ZCode-App-Version"]).toBeUndefined();
  });

  it("does NOT emit X-Title (real ZCode client doesn't send it)", () => {
    const h = buildIdentityHeaders({ ...BASE, sourceTitle: "electron" }) as unknown as Record<string, string | undefined>;
    expect(h["X-Title"]).toBeUndefined();
  });

  it("does NOT emit X-ZCode-Agent (real ZCode client doesn't send it)", () => {
    const h = buildIdentityHeaders(BASE) as unknown as Record<string, string | undefined>;
    expect(h["X-ZCode-Agent"]).toBeUndefined();
  });

  it("does NOT emit HTTP-Referer (real ZCode client doesn't send it)", () => {
    const h = buildIdentityHeaders({ ...BASE, refererOrigin: "https://example.com" }) as unknown as Record<string, string | undefined>;
    expect(h["HTTP-Referer"]).toBeUndefined();
  });

  it("User-Agent is independent of identity config (real ZCode uses fixed SDK version)", () => {
    // Different identity configs should NOT change the UA — the real client
    // always sends `ai-sdk/anthropic/3.0.81` regardless of its app version.
    const h1 = buildIdentityHeaders({ ...BASE, appVersion: "1.0.0" });
    const h2 = buildIdentityHeaders({ ...BASE, appVersion: "9.9.9" });
    expect(h1["User-Agent"]).toBe(h2["User-Agent"]);
  });
});

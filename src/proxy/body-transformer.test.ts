/**
 * Tests for body transformer.
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import { describe, it, expect } from "bun:test";
import { transformRequestBody } from "./body-transformer.js";

describe("transformRequestBody — general", () => {
  it("returns undefined unchanged", () => {
    expect(transformRequestBody(undefined, { format: "openai" })).toBeUndefined();
  });

  it("returns empty string unchanged", () => {
    expect(transformRequestBody("", { format: "openai" })).toBe("");
  });

  it("returns original body on JSON parse failure", () => {
    const broken = "{not valid json";
    expect(transformRequestBody(broken, { format: "openai" })).toBe(broken);
  });

  it("returns original body when JSON is not an object", () => {
    expect(transformRequestBody("[1,2,3]", { format: "openai" })).toBe("[1,2,3]");
    expect(transformRequestBody("\"hello\"", { format: "openai" })).toBe("\"hello\"");
  });

  it("returns original body when no transformation applies", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });
});

describe("transformRequestBody — stream_options.include_usage (OpenAI)", () => {
  it("injects stream_options.include_usage when stream:true and missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: true });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });

  it("preserves existing stream_options fields, only adds include_usage", () => {
    const body = JSON.stringify({ stream: true, stream_options: { some_other: "x" } });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ some_other: "x", include_usage: true });
  });

  it("does NOT touch body when stream_options.include_usage already true", () => {
    const body = JSON.stringify({ stream: true, stream_options: { include_usage: true } });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is false", () => {
    const body = JSON.stringify({ stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [] });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject for anthropic format (Anthropic API has no stream_options)", () => {
    const body = JSON.stringify({ stream: true });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });
});

describe("transformRequestBody — cache_control (Anthropic)", () => {
  it("adds cache_control to last user message with string content", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second question" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Last user msg content converted to array with cache_control on the block
    expect(parsed.messages[2].content).toEqual([
      { type: "text", text: "second question", cache_control: { type: "ephemeral" } },
    ]);
    // Earlier messages untouched
    expect(parsed.messages[0].content).toBe("first question");
    expect(parsed.messages[1].content).toBe("answer");
  });

  it("adds cache_control to last content block when content is already array", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT overwrite existing cache_control on last block", () => {
    const existing = { type: "ephemeral", ttl: "1h" };
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: existing }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual(existing);
  });

  it("skips system messages — relocates them to system field and finds last non-system", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q1" },
        { role: "system", content: "sys-prompt" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // The user msg (index 0) is the last non-system; gets cache_control
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    // System message relocated from messages to top-level system field
    expect(parsed.messages.length).toBe(1);
    expect(parsed.system).toEqual([{ type: "text", text: "sys-prompt" }]);
  });

  it("does nothing when messages array is empty", () => {
    const body = JSON.stringify({ messages: [] });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });

  it("relocates system-only messages to system field", () => {
    const body = JSON.stringify({ messages: [{ role: "system", content: "sys" }] });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // System message moved out of messages array
    expect(parsed.messages).toEqual([]);
    expect(parsed.system).toEqual([{ type: "text", text: "sys" }]);
  });

  it("does NOT apply cache_control for openai format", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    expect(out).toBe(body);
  });

  it("handles missing messages field gracefully", () => {
    const body = JSON.stringify({ model: "glm-4.6" });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });
});

describe("transformRequestBody — combined behavior", () => {
  it("OpenAI streaming body is only stream_options-modified (no cache_control)", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
    expect(parsed.messages[0].content).toBe("hi");
  });
});

describe("transformRequestBody — transform unsupported fields (Anthropic)", () => {
  it("converts thinking type 'adaptive' to 'enabled' for GLM", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.model).toBe("glm-4.6");
  });

  it("converts thinking type 'enabled' with budget_tokens to simple 'enabled' for GLM", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 10000 },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.thinking.budget_tokens).toBeUndefined();
  });

  it("passes thinking type 'disabled' through unchanged", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "disabled" });
  });

  it("removes context_management field", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.context_management).toBeUndefined();
  });

  it("removes output_config field", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.output_config).toBeUndefined();
  });

  it("handles all transformations at once", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "test" }],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "low" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.context_management).toBeUndefined();
    expect(parsed.output_config).toBeUndefined();
    expect(parsed.model).toBe("glm-5.2");
  });

  it("does NOT transform fields for openai format", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
      stream: true,
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    // thinking is not transformed for openai format
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });
});

describe("transformRequestBody — relocate system messages (Anthropic)", () => {
  it("moves role:system messages from messages to system field", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages.length).toBe(1);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.system).toEqual([{ type: "text", text: "you are helpful" }]);
  });

  it("appends to existing system array", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: "existing sys" }],
      messages: [
        { role: "system", content: "injected sys" },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system.length).toBe(2);
    expect(parsed.system[0].text).toBe("existing sys");
    expect(parsed.system[1].text).toBe("injected sys");
  });

  it("converts existing string system to array and appends", () => {
    const body = JSON.stringify({
      system: "string system",
      messages: [
        { role: "system", content: "array system" },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system.length).toBe(2);
    expect(parsed.system[0]).toEqual({ type: "text", text: "string system" });
    expect(parsed.system[1]).toEqual({ type: "text", text: "array system" });
  });

  it("handles system message with array content", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: [{ type: "text", text: "block1" }, { type: "text", text: "block2" }] },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system).toEqual([
      { type: "text", text: "block1" },
      { type: "text", text: "block2" },
    ]);
  });

  it("does NOT relocate for openai format", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    // For openai format, system messages stay in messages array
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[0].role).toBe("system");
  });
});

describe("transformRequestBody — strip thinking blocks from messages (Anthropic)", () => {
  it("removes thinking content blocks from assistant messages", () => {
    // Reproduces the exact Claude Code round-2 request that triggers 3001:
    // assistant history contains a thinking block (with empty signature)
    // echoed back from the previous turn's thinking_delta SSE events.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: "你好啊" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "用户用中文打招呼...", signature: "" },
            { type: "text", text: "你好!👋..." },
          ],
        },
        { role: "user", content: "帮我看看这个项目是干嘛的" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[1].role).toBe("assistant");
    expect(parsed.messages[1].content).toEqual([
      { type: "text", text: "你好!👋..." },
    ]);
  });

  it("also strips redacted_thinking blocks", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "opaque-base64==" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "next" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // redacted_thinking stripped; text block kept
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("drops an assistant message entirely if it contained ONLY thinking blocks", () => {
    // An empty-content assistant turn would itself trigger 3001, so the
    // whole message must be removed.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal", signature: "x" }],
        },
        { role: "user", content: "follow-up" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Assistant message gone; only the two user messages remain.
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[1].role).toBe("user");
    expect(parsed.messages.find((m: any) => m.role === "assistant")).toBeUndefined();
  });

  it("preserves tool_use blocks alongside thinking blocks", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan", signature: "" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // thinking block gone, tool_use preserved
    expect(parsed.messages[0].content).toEqual([
      { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
    ]);
    // tool_result preserved (cache_control may be attached — that's a separate transform)
    expect(parsed.messages[1].content[0].type).toBe("tool_result");
    expect(parsed.messages[1].content[0].tool_use_id).toBe("t1");
  });

  it("does NOT touch string content (no thinking blocks possible)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "next" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // string content on assistant untouched (cache_control lands on last user msg, not assistant)
    expect(parsed.messages[1].content).toBe("hi there");
  });

  it("leaves messages without thinking blocks unchanged (apart from other transformations)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content.length).toBe(1);
    expect(parsed.messages[0].content[0].type).toBe("text");
  });

  it("does NOT strip thinking blocks for openai format", () => {
    // openai format is forwarded to /chat/completions which has its own
    // schema; thinking-block stripping is Anthropic-specific.
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "x", signature: "" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content.length).toBe(2);
    expect(parsed.messages[0].content[0].type).toBe("thinking");
  });

  it("handles missing messages field gracefully", () => {
    const body = JSON.stringify({ model: "glm-5.2" });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });

  it("strips thinking from multi-turn conversation (Claude Code regression case)", () => {
    // End-to-end shape: round-2 request from Claude Code with full history.
    // Verifies the fix unblocks multi-turn Claude Code sessions.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: [{ type: "text", text: "你好啊" }] },
        { role: "system", content: "agent types and skills..." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "用户用中文打招呼...", signature: "" },
            { type: "text", text: "你好!👋 我是 ZCode..." },
          ],
        },
        { role: "user", content: [{ type: "text", text: "帮我看看这个项目是干嘛的" }] },
      ],
      thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    // Top-level Claude-Code-only fields are stripped/normalized
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.context_management).toBeUndefined();
    expect(parsed.output_config).toBeUndefined();

    // System message relocated
    expect(parsed.system).toEqual([{ type: "text", text: "agent types and skills..." }]);
    expect(parsed.messages.find((m: any) => m.role === "system")).toBeUndefined();

    // Thinking block stripped from assistant history
    const assistant = parsed.messages.find((m: any) => m.role === "assistant");
    expect(assistant.content).toEqual([{ type: "text", text: "你好!👋 我是 ZCode..." }]);
  });
});

describe("transformRequestBody — metadata.user_id (Anthropic)", () => {
  it("injects metadata.user_id when ctx.userId is set", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ user_id: "u_42" });
  });

  it("preserves existing metadata fields when adding user_id", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { existing_field: "keep" },
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "u_99" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ existing_field: "keep", user_id: "u_99" });
  });

  it("does NOT touch body when metadata.user_id already equals ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "u_x" },
    });
    expect(transformRequestBody(body, { format: "anthropic", userId: "u_x" })).toBe(body);
  });

  it("overwrites metadata.user_id when value differs from ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "client_set" },
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "oauth_resolved" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata.user_id).toBe("oauth_resolved");
  });

  it("does NOT inject metadata when ctx.userId is absent (apikey mode)", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });

  it("does NOT inject metadata for OpenAI format even if userId is set", () => {
    const body = JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai", userId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });
});

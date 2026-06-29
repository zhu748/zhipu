/**
 * Tests for OpenAI ↔ Anthropic translators.
 * @see .omo/plans/zcode-proxy.md Task 11
 *
 * v0.2.2+: the reverse-direction translators
 * (`translateRequestAnthropicToOpenAI`, `translateResponseOpenAIToAnthropic`)
 * were removed as dead code (never used in production, marked @deprecated).
 * Their test sections were removed alongside.
 */
import { describe, it, expect } from "bun:test";
import {
  translateRequestOpenAIToAnthropic,
  translateResponseAnthropicToOpenAI,
} from "./openai-to-anthropic.js";
import type {
  OpenAIChatRequest,
  AnthropicMessagesResponse,
} from "./types.js";

describe("translateRequestOpenAIToAnthropic", () => {
  it("extracts system message to top-level system field", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.system).toBe("You are helpful");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("joins multiple system messages", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [
        { role: "system", content: "Rule 1" },
        { role: "system", content: "Rule 2" },
        { role: "user", content: "Hi" },
      ],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.system).toBe("Rule 1\n\nRule 2");
  });

  it("sets max_tokens default when not provided", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.max_tokens).toBe(4096);
  });

  it("preserves max_tokens when provided", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 2048,
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.max_tokens).toBe(2048);
  });

  it("translates stop to stop_sequences", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      stop: ["END", "STOP"],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.stop_sequences).toEqual(["END", "STOP"]);
  });

  it("translates tool definitions", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Search for cats" }],
      tools: [{
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      }],
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].name).toBe("search");
    expect(result.tools![0].description).toBe("Search the web");
    expect(result.tools![0].input_schema).toBeDefined();
  });

  it("drops tools and tool_choice when tool_choice is 'none'", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object" },
        },
      }],
      tool_choice: "none",
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
  });

  it("translates tool_choice 'required' to { type: 'any' }", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{
        type: "function",
        function: { name: "search", parameters: { type: "object" } },
      }],
      tool_choice: "required",
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toEqual({ type: "any" });
    expect(result.tools).toHaveLength(1);
  });

  it("translates tool_choice 'auto' to { type: 'auto' }", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{
        type: "function",
        function: { name: "search", parameters: { type: "object" } },
      }],
      tool_choice: "auto",
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toEqual({ type: "auto" });
  });

  it("translates object-form tool_choice to { type: 'tool', name }", () => {
    const req: OpenAIChatRequest = {
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{
        type: "function",
        function: { name: "search", parameters: { type: "object" } },
      }],
      tool_choice: { type: "function", function: { name: "search" } },
    };
    const result = translateRequestOpenAIToAnthropic(req);
    expect(result.tool_choice).toEqual({ type: "tool", name: "search" });
  });
});

describe("translateResponseAnthropicToOpenAI", () => {
  it("extracts text content from response", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = translateResponseAnthropicToOpenAI(resp, "glm-4.6");
    expect(result.choices[0].message.content).toBe("Hello world");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("maps stop_reason to finish_reason", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      model: "glm-4.6",
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = translateResponseAnthropicToOpenAI(resp, "glm-4.6");
    expect(result.choices[0].finish_reason).toBe("length");
  });

  it("translates tool_use blocks to tool_calls", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Let me search" },
        { type: "tool_use", id: "tu_1", name: "search", input: { query: "cats" } },
      ],
      model: "glm-4.6",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const result = translateResponseAnthropicToOpenAI(resp, "glm-4.6");
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls![0].function.name).toBe("search");
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("maps usage tokens correctly", () => {
    const resp: AnthropicMessagesResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const result = translateResponseAnthropicToOpenAI(resp, "glm-4.6");
    expect(result.usage!.prompt_tokens).toBe(100);
    expect(result.usage!.completion_tokens).toBe(50);
    expect(result.usage!.total_tokens).toBe(150);
  });
});

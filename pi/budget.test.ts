import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { requestBudget } from "./budget.ts";

const model: Model<Api> = { id: "physical", name: "Physical", api: "google-generative-ai", provider: "fixture", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text", "image"], contextWindow: 32_768, maxTokens: 32_768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

const ctx = { model, modelRegistry: { getAll: () => [model] } };

test("provider budget includes nested Google and Bedrock prompts, tools, and effective output limits", () => {
  const large = "instructions ".repeat(12_000);

  for (const payload of [
    { model: "physical", contents: [{ role: "user", parts: [{ text: "short" }] }], config: { systemInstruction: large, tools: [], maxOutputTokens: 8000, abortSignal: new AbortController().signal } },
    { modelId: "physical", messages: [{ role: "user", content: [{ text: "short" }] }], toolConfig: { tools: [{ toolSpec: { description: large } }] }, inferenceConfig: { maxTokens: 8000 } },
  ]) {
    const result = requestBudget(payload, ctx)!;
    assert.ok(result.tokens > result.budget);
    assert.equal(result.budget, model.contextWindow - 8000);
  }
});

test("budget counts image allowances instead of encoded bytes and refuses unknown payloads or routes", () => {
  for (const image of [
    { type: "image_url", image_url: { url: "x".repeat(100_000) } },
    { type: "image", source: { type: "base64", data: "x".repeat(100_000) } },
    { inlineData: { mimeType: "image/png", data: "x".repeat(100_000) } },
  ]) {
    const result = requestBudget({ model: "physical", messages: [{ content: [image] }] }, ctx)!;
    assert.ok(result.tokens >= 1200 && result.tokens < 1250);
  }

  assert.equal(requestBudget({ opaque: true }, ctx), undefined);
  assert.equal(requestBudget({ model: "unknown", messages: [] }, ctx), undefined);
  assert.equal(requestBudget({ model: "physical", messages: [], max_tokens: "invalid" }, ctx), undefined);
  const virtual = { ...ctx, model: { ...model, api: "pi-virtual", id: "auto", contextWindow: 0 } };
  const small = { ...model, provider: "other", contextWindow: 16_384 };
  const result = requestBudget({ model: "physical", messages: [], max_tokens: 8192 }, { ...virtual, modelRegistry: { getAll: () => [model, small] } });
  assert.equal(result?.budget, 8192, "ambiguous routed IDs use the smallest known window");
});

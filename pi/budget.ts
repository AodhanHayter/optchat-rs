import type { BeforeProviderRequestEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Predicate, Result, Schema } from "effect";

const Request = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  modelId: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(Schema.Struct({
    systemInstruction: Schema.optionalKey(Schema.MutableJson),
    tools: Schema.optionalKey(Schema.MutableJson),
    maxOutputTokens: Schema.optionalKey(Schema.Number),
  })),
  inferenceConfig: Schema.optionalKey(Schema.Struct({ maxTokens: Schema.optionalKey(Schema.Number) })),
  toolConfig: Schema.optionalKey(Schema.MutableJson),
  messages: Schema.optionalKey(Schema.MutableJson),
  input: Schema.optionalKey(Schema.MutableJson),
  contents: Schema.optionalKey(Schema.MutableJson),
  system: Schema.optionalKey(Schema.MutableJson),
  systemInstruction: Schema.optionalKey(Schema.MutableJson),
  instructions: Schema.optionalKey(Schema.MutableJson),
  tools: Schema.optionalKey(Schema.MutableJson),
  max_tokens: Schema.optionalKey(Schema.Number),
  max_completion_tokens: Schema.optionalKey(Schema.Number),
  max_output_tokens: Schema.optionalKey(Schema.Number),
});

interface BudgetContext extends Pick<ExtensionContext, "model"> {
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAll">;
}

/** Provider requests have already passed routing, context transforms, and output clamping. */
export function requestBudget(payload: BeforeProviderRequestEvent["payload"], ctx: BudgetContext) {
  const parsed = Schema.decodeUnknownResult(Request)(payload);

  if (Result.isFailure(parsed)) return undefined;
  const request = parsed.success;
  const selected = ctx.model;
  const id = request.model ?? request.modelId;
  const models = selected?.api !== "pi-virtual" && selected && (!id || id === selected.id) ? [selected] : ctx.modelRegistry.getAll().filter(m => m.api !== "pi-virtual" && m.id === id);
  // A wire model ID has no provider name. If ambiguous, use the smallest known window.
  const model = models.filter(m => m.contextWindow > 0).sort((a, b) => a.contextWindow - b.contextWindow)[0];

  if (!model) return undefined;
  const input = [request.messages, request.input, request.contents, request.system, request.systemInstruction, request.instructions, request.tools, request.config?.systemInstruction, request.config?.tools, request.toolConfig];

  if (!input.some(value => value !== undefined)) return undefined;
  const output = request.max_tokens ?? request.max_completion_tokens ?? request.max_output_tokens ?? request.config?.maxOutputTokens ?? request.inferenceConfig?.maxTokens ?? 0;
  const tokens = Math.ceil(input.reduce<number>((total, value) => total + chars(value), 0) / 4);
  const budget = Math.max(0, model.contextWindow - Math.max(4096, output));

  return { tokens, budget, model };
}

/** Same image allowance as Pi; never count base64 bytes as text tokens. */
function chars(value: Schema.MutableJson | undefined): number {
  if (Predicate.isString(value)) return value.length;

  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + chars(item), 0);

  if (value == null || Predicate.isNumber(value) || Predicate.isBoolean(value)) return 0;

  if (["image", "image_url", "input_image"].includes(String(value.type)) || "inlineData" in value) return 4800;

  return Object.entries(value).reduce((total, [key, item]) => total + key.length + chars(item), 0);
}

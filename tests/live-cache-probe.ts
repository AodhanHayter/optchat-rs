// Live Anthropic probe for the spec §8 cache layout. Costs money; run on purpose:
//   node tests/live-cache-probe.ts [provider/model-id]
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { cachePayload, type Block } from "../pi/memory.ts";

const [provider, id] = (process.argv[2] ?? "anthropic/claude-sonnet-4-5").split("/");

const runtime = await ModelRuntime.create();

const model = runtime.getModel(provider, id);

if (!model) throw new Error(`model ${provider}/${id} not configured in pi`);

const line = "user: keep the parser small and name the file in every error. talk: traced the crash to an empty index.\n";

const view = `<chat>\n${line.repeat(Math.ceil(52_000 / line.length))}</chat>`;

const blocks: Block[] = [{ type: "text", text: view, cache_control: { type: "ephemeral" } }];

async function call(step: string) {
  const reply = await runtime.streamSimple(model!, {
    systemPrompt: "Reply with the single word OK.",
    messages: [{ role: "user", content: [...blocks.map(b => ({ type: "text" as const, text: b.text })), { type: "text", text: step }], timestamp: Date.now() }],
  }, { maxTokens: 16, cacheRetention: "short", onPayload: payload => cachePayload(payload, blocks, model!) }).result();

  if (reply.stopReason === "error") throw new Error(reply.errorMessage);

  return reply.usage;
}

const first = await call("Step one: say OK.");

const second = await call("Step two, different text: say OK.");

console.log(JSON.stringify({ first, second }, null, 1));

const viewTokens = view.length / 5;

if (second.cacheRead < viewTokens * 0.8) throw new Error(`second call read only ${second.cacheRead} cached tokens for a ~${viewTokens}-token view`);

console.log(`PASS: second call read ${second.cacheRead} cached tokens; first wrote ${first.cacheWrite}`);

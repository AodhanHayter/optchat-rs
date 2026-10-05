import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { cachePayload, MemoryDriver, type Block, type DriverContext } from "./memory.ts";
import { capText, OptChatClient, CAP } from "./transport.ts";
import optchat from "./index.ts";

const binary = resolve("target/debug/optchat");

test("UTF-8 cap matches Rust and failed process requests reject", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-client-"));
  const client = new OptChatClient(binary, ["--dir", dir, "serve"]);

  try {
    const input = "HEAD" + "🦀".repeat(CAP) + "TAIL";
    const text = capText(input);
    assert.ok([...text].length <= CAP);
    assert.ok(text.startsWith("HEAD") && text.endsWith("TAIL"));
    assert.equal((await client.call("append", { kind: "echo", text: input })).text, text);
    await assert.rejects(client.call("append", { kind: "thought", text: "private" }));
    assert.equal((await client.call("status")).messages, 1);
  } finally { await client.dispose(); await rm(dir, { recursive: true, force: true }); }

  await assert.rejects(client.call("status"));
  const missing = new OptChatClient("/optchat-test-does-not-exist", []);
  await assert.rejects(missing.call("status"));
  await missing.dispose();
});

test("missing model releases the Rust job and reports the configuration error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-missing-model-"));
  let reported!: () => void;
  const notice = new Promise<void>(resolve => { reported = resolve; });
  const ctx: DriverContext = { ui: { notify: () => reported() }, modelRegistry: { find: () => undefined, streamSimple: () => assert.fail("missing model must not stream") } };
  const driver = new MemoryDriver(ctx, binary, dir, "missing/model", assert.fail);

  try {
    await driver.append("user", "long".repeat(200));
    await notice;
    const status = await driver.client.call("status");
    assert.equal(status.busy, 0);
    assert.equal(status.settled, false);
  } finally { await driver.close(); await rm(dir, { recursive: true, force: true }); }
});

test("pi-subagents children do not register a competing memory writer", () => {
  const original = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";

  try {
    // SAFETY: a subagent child returns before touching the API; any call fails the test.
    optchat({ on: assert.fail, registerTool: assert.fail, registerCommand: assert.fail } as any);
  }
  finally {
    if (original === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = original;
  }
});

test("unavailable memory aborts instead of returning old conversation", async () => {
  const hooks = new Map<string, Function>();
  // SAFETY: optchat only calls on, registerTool, and registerCommand at load.
  optchat({ on: (name: string, handler: Function) => hooks.set(name, handler), registerTool: () => {}, registerCommand: () => {} } as any);
  let aborted = false;
  const ctx = { ui: { notify: () => {}, setStatus: () => {} }, abort: () => { aborted = true; } };
  const messages = [{ role: "system", content: "instructions", timestamp: 0 }, { role: "user", content: "old conversation", timestamp: 1 }];
  const result = await hooks.get("context_with_system")!({ messages }, ctx);
  assert.equal(aborted, true);
  assert.deepEqual(result.messages, [messages[0]]);
});

test("off bypasses every memory hook and refuses direct or nested memory tools", async () => {
  const hooks = new Map<string, Function>();
  const tools = new Map<string, any>();
  let command!: any;
  // SAFETY: optchat only calls on, registerTool, and registerCommand at load.
  optchat({
    on: (name: string, handler: Function) => hooks.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (_name: string, options: any) => { command = options.handler; },
  } as any);
  const notices: string[] = [];
  let pending = true;

  const ctx = {
    ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
    abort: assert.fail, isIdle: () => true, hasPendingMessages: () => pending,
  };

  await command("off", ctx);
  assert.match(notices.at(-1)!, /queue is empty/);
  pending = false;
  await command("off", ctx);
  assert.match(notices.at(-1)!, /OptChat: off/);
  assert.deepEqual(await hooks.get("input")!({ text: "PRIVATE", streamingBehavior: "steer" }, ctx), { action: "continue" });
  assert.equal(await hooks.get("before_agent_start")!({ systemPrompt: "Native prompt" }, ctx), undefined);
  assert.equal(await hooks.get("context_with_system")!({ messages: [] }, ctx), undefined);
  assert.equal(await hooks.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "PRIVATE" }] } }, ctx), undefined);
  const result = { role: "toolResult", toolName: "other", content: [{ type: "text", text: "PRIVATE".repeat(5000) }] };
  assert.equal(await hooks.get("message_end")!({ message: result }, ctx), undefined, "off must not cap native tool results");
  await hooks.get("tool_execution_start")!({ parentToolCallId: "parent", toolName: "nested", args: { secret: "PRIVATE" } }, ctx);
  await hooks.get("tool_execution_end")!({ parentToolCallId: "parent", result }, ctx);
  assert.equal(hooks.get("session_before_compact")!(), undefined);
  assert.equal(hooks.get("cache_warming_decision")!(), undefined);
  assert.equal(hooks.get("before_provider_request")!({ payload: {} }, ctx), undefined);

  for (const name of ["zoom", "date"]) await assert.rejects(tools.get(name).execute("call", { id: 0, n: 1 }), /OptChat is off/);
  assert.ok(!notices.some(n => n.includes("stopped")));
  await hooks.get("session_shutdown")!({}, ctx);
});

test("Anthropic gets three stable marks plus automatic end, without altering tool input", () => {
  const blocks: Block[] = ["first", "second", "third", "last"].map(text => ({ type: "text", text, cache_control: { type: "ephemeral" } }));

  const payload = {
    system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
    tools: [{ name: "tool", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: blocks.map(b => ({ ...b })) },
      { role: "assistant", content: [{ type: "tool_use", input: { cache_control: "user data" }, cache_control: { type: "ephemeral" } }] },
    ],
  };

  const result = cachePayload(payload, blocks, { api: "anthropic-messages" });
  assert.deepEqual(result.cache_control, { type: "ephemeral" });
  assert.equal(result.messages[0].content.filter((b: Block) => b.cache_control).length, 3);
  assert.equal(result.system[0].cache_control, undefined);
  assert.equal(result.tools[0].cache_control, undefined);
  assert.equal(result.messages[1].content[0].cache_control, undefined);
  assert.equal(result.messages[1].content[0].input.cache_control, "user data");
  const openai = () => ({ store: false, reasoning: { effort: "medium" }, input: [{ role: "user", content: blocks.map(b => ({ type: "input_text", text: b.text })) }, { type: "reasoning", encrypted_content: "native" }] });
  const legacy = cachePayload(openai(), blocks, { api: "openai-responses", compat: {} });
  assert.equal(JSON.stringify(legacy), JSON.stringify(openai()));
  const explicit = cachePayload(openai(), blocks, { api: "openai-responses", compat: { supportsExplicitPromptCacheMode: true } });
  assert.equal(explicit.reasoning.context, "all_turns");
  assert.deepEqual(explicit.input[0].content.map((b: any) => b.prompt_cache_breakpoint?.mode), ["explicit", "explicit", "explicit", "explicit"]);
  assert.equal(explicit.input[1].encrypted_content, "native");
});

test("compactor retries after ten seconds, once per failure, without a new user turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-retry-"));
  const notices: string[] = [];
  const fatal: Error[] = [];
  let calls = 0;
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });

  const ctx: DriverContext = {
    ui: { notify: (message: string) => { notices.push(message); } },
    modelRegistry: {
      // SAFETY: the driver only hands this model back to the stub streamSimple below.
      find: () => ({ id: "compact", api: "openai-completions", provider: "test" }) as Model<Api>,
      // SAFETY: the driver only awaits result() and reads content and stopReason.
      streamSimple: () => ({ result: async () => {
        calls++;
        notifyStarted();

        if (calls === 1) throw new Error("temporary provider failure");

        return { content: [{ type: "text", text: "user: a compressed message" }], stopReason: "stop" };
      } }) as AssistantMessageEventStream,
    },
  };

  const driver = new MemoryDriver(ctx, binary, dir, "test/compact", error => fatal.push(error));

  try {
    await driver.append("user", "long ".repeat(150));
    await started; // append starts background work; wait() is not what starts the first call.
    const cancel = new AbortController(); cancel.abort();
    assert.equal(await driver.wait(cancel.signal), false);
    const before = Date.now();
    assert.equal(await driver.wait(AbortSignal.timeout(20_000)), true);
    assert.ok(Date.now() - before >= 9_500);
    assert.equal(calls, 2);
    assert.equal(notices.length, 1);
    assert.deepEqual(fatal, []);
    assert.equal((await driver.client.call("status")).busy, 0);
  } finally { await driver.close(); await rm(dir, { recursive: true, force: true }); }
});

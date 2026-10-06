import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import type { Api, AssistantMessage, AssistantMessageEventStream, Message, Model } from "@earendil-works/pi-ai";
import { cachePayload, imageNotice, MemoryDriver, recordedText, textOf, type Block, type DriverContext } from "./memory.ts";
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

test("invalid configuration aborts startup and blocks stale context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-invalid-config-"));
  const oldModel = process.env.OPTCHAT_MODEL;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const hooks = new Map<string, Function>();
  // SAFETY: optchat only calls on, registerTool, and registerCommand at load.
  optchat({ on: (name: string, handler: Function) => hooks.set(name, handler), registerTool: () => {}, registerCommand: () => {} } as any);
  const notices: string[] = [];
  let aborted = false;

  const ctx = {
    cwd: dir, isProjectTrusted: () => false,
    ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
    abort: () => { aborted = true; },
  };

  process.env.OPTCHAT_MODEL = "invalid-model";
  process.env.PI_CODING_AGENT_DIR = dir;

  try {
    await hooks.get("session_start")!({}, ctx);
    assert.equal(aborted, true);
    assert.match(notices[0], /OptChat stopped: environment: invalid optchat.model/);
    const messages = [{ role: "system", content: "instructions", timestamp: 0 }, { role: "user", content: "old conversation", timestamp: 1 }];
    const result = await hooks.get("context_with_system")!({ messages }, ctx);
    assert.deepEqual(result.messages, [messages[0]]);
  } finally {
    await hooks.get("session_shutdown")!({}, ctx);

    if (oldModel === undefined) delete process.env.OPTCHAT_MODEL; else process.env.OPTCHAT_MODEL = oldModel;

    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
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

test("recordedText notes each image without changing textOf or the content it reads", () => {
  const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
  const plain = [{ type: "text" as const, text: "a" }, { type: "text" as const, text: "b" }];
  assert.equal(recordedText(plain), textOf(plain));
  assert.equal(recordedText("plain string"), "plain string");
  assert.equal(recordedText([]), "");
  const content = [{ type: "text" as const, text: "look" }, image, { type: "text" as const, text: " here" }, image];
  const before = structuredClone(content);
  assert.equal(recordedText(content), `look here\n${imageNotice}\n${imageNotice}`);
  assert.equal(textOf(content), "look here", "textOf still ignores images");
  assert.deepEqual(content, before);
  assert.equal(recordedText([image]), imageNotice);
  assert.ok(!recordedText([image]).includes(image.data), "image bytes are never recorded");
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

for (const failure of ["rejection", "malformed reply"]) {
  test(`compactor retries after ${failure} without a new user turn`, async () => {
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

          if (calls === 1) {
            if (failure === "rejection") throw new Error("temporary provider failure");

            return { stopReason: "stop" };
          }

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
}

test("a failed job immediately frees its slot for unrelated queued work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-queue-"));
  let calls = 0;
  let rejectFirst!: (error: Error) => void;
  let batchStarted!: () => void;
  let nextStarted!: () => void;
  const batch = new Promise<void>(resolve => { batchStarted = resolve; });
  const next = new Promise<void>(resolve => { nextStarted = resolve; });

  const ctx: DriverContext = {
    ui: { notify: () => {} },
    modelRegistry: {
      // SAFETY: the driver only hands this model back to the stub streamSimple below.
      find: () => ({ id: "compact", api: "openai-completions", provider: "test" }) as Model<Api>,
      streamSimple: () => {
        calls++;

        const result = new Promise<AssistantMessage>((_resolve, reject) => {
          if (calls === 1) rejectFirst = reject;
        });

        if (calls === 8) batchStarted();

        if (calls === 9) nextStarted();

        // SAFETY: the driver only awaits result(); remaining attempts end by interruption.
        return { result: () => result } as AssistantMessageEventStream;
      },
    },
  };

  const driver = new MemoryDriver(ctx, binary, dir, "test/compact", assert.fail);

  try {
    // Populate Rust's queue before polling so eight jobs start with more work still queued.
    for (let i = 0; i < 32; i++) await driver.client.call("append", { kind: "user", text: `marker-${i} ${"a".repeat(450)}` });
    driver.kick();
    await Effect.runPromise(Effect.promise(() => batch).pipe(Effect.timeout("2 seconds")));
    rejectFirst(new Error("first job failed"));
    await Effect.runPromise(Effect.promise(() => next).pipe(Effect.timeout("2 seconds")));
    assert.equal(calls, 9, "unrelated work starts without waiting for the ten-second retry");
  } finally { await driver.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an over-long summary takes the corrective retry turn instead of the failure cooldown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-corrective-"));
  const turns: Message[][] = [];
  const replies = ["x".repeat(600), "user: a compressed message"];

  const ctx: DriverContext = {
    ui: { notify: () => assert.fail("a corrective turn is not a reported failure") },
    modelRegistry: {
      // SAFETY: the driver only hands this model back to the stub streamSimple below.
      find: () => ({ id: "compact", api: "openai-completions", provider: "test" }) as Model<Api>,
      streamSimple: (_model, context) => {
        const text = replies[turns.length] ?? assert.fail("the corrective turn must settle the job");
        // The driver keeps appending to one array, so the turn is only comparable as a snapshot.
        turns.push([...context.messages]);

        // SAFETY: the driver only awaits result() and reads content and stopReason.
        return { result: async () => ({ content: [{ type: "text", text }], stopReason: "stop" }) } as AssistantMessageEventStream;
      },
    },
  };

  const driver = new MemoryDriver(ctx, binary, dir, "test/compact", assert.fail);

  try {
    await driver.append("user", "long ".repeat(150));
    assert.equal(await driver.wait(AbortSignal.timeout(20_000)), true);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].length, 1, "the first attempt sees only the job's own cache blocks");
    assert.equal(turns[1].length, 3, "the retry keeps the attempt and adds Rust's correction");
    assert.match(JSON.stringify(turns[1][2]), /LIMIT/);
    assert.equal((await driver.client.call("status")).busy, 0);
  } finally { await driver.close(); await rm(dir, { recursive: true, force: true }); }
});

test("close interrupts the in-flight provider call and runs only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-close-"));
  let streamSignal: AbortSignal | undefined;
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });

  const ctx: DriverContext = {
    ui: { notify: () => assert.fail("an interrupted attempt must not be reported") },
    modelRegistry: {
      // SAFETY: the driver only hands this model back to the stub streamSimple below.
      find: () => ({ id: "compact", api: "openai-completions", provider: "test" }) as Model<Api>,
      streamSimple: (_model, _context, options) => {
        streamSignal = options?.signal;
        notifyStarted();

        // SAFETY: the driver only awaits result(); this attempt ends by interruption alone.
        return { result: () => new Promise<AssistantMessage>(() => {}) } as AssistantMessageEventStream;
      },
    },
  };

  const driver = new MemoryDriver(ctx, binary, dir, "test/compact", assert.fail);

  try {
    await driver.append("user", "long ".repeat(150));
    await started;
    const first = driver.close();
    assert.equal(driver.close(), first, "close must not start a second shutdown");
    await first;
    assert.equal(streamSignal?.aborted, true, "close must abort the provider call");
    await assert.rejects(driver.wait(), /process is not running/);
    await assert.rejects(driver.append("user", "after close"), /process is not running/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a parked wait ends on the caller's abort, and ends again on close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-parked-"));
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });

  const ctx: DriverContext = {
    ui: { notify: () => assert.fail("a parked wait must not report a failure") },
    modelRegistry: {
      // SAFETY: the driver only hands this model back to the stub streamSimple below.
      find: () => ({ id: "compact", api: "openai-completions", provider: "test" }) as Model<Api>,
      streamSimple: () => {
        notifyStarted();

        // SAFETY: the driver only awaits result(); this attempt ends by interruption alone.
        return { result: () => new Promise<AssistantMessage>(() => {}) } as AssistantMessageEventStream;
      },
    },
  };

  const driver = new MemoryDriver(ctx, binary, dir, "test/compact", assert.fail);

  try {
    await driver.append("user", "long ".repeat(150));
    await started;
    const cancel = new AbortController();
    const cancelled = driver.wait(cancel.signal);
    // One Rust process answers in order, so this reply proves the wait already parked on its own.
    await driver.client.call("status");
    cancel.abort();
    assert.equal(await cancelled, false);
    const pending = driver.wait();
    await driver.client.call("status");
    const closed = driver.close();
    assert.equal(await pending, false, "close must release the waiting turn");
    await closed;
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("close flushes a write that is still in flight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-flush-"));

  const ctx: DriverContext = {
    ui: { notify: () => assert.fail("a short message has no summary to report") },
    modelRegistry: { find: () => assert.fail("a short message makes no job"), streamSimple: () => assert.fail("a short message makes no job") },
  };

  const driver = new MemoryDriver(ctx, binary, dir, "test/compact", assert.fail);
  const writing = driver.append("user", "durable even while closing");
  await driver.close();
  await writing;
  const reader = new OptChatClient(binary, ["--dir", dir, "serve"]);

  try {
    assert.equal((await reader.call("status")).messages, 1);
  } finally { await reader.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("a transport that never starts is fatal once and still closes cleanly", async () => {
  let reported!: (error: Error) => void;
  const fatal = new Promise<Error>(resolve => { reported = resolve; });

  const ctx: DriverContext = {
    ui: { notify: () => assert.fail("a dead transport is not a summary failure") },
    modelRegistry: { find: () => assert.fail("a dead transport must not reach the model"), streamSimple: () => assert.fail("a dead transport must not stream") },
  };

  const driver = new MemoryDriver(ctx, "/optchat-test-does-not-exist", "/optchat-test-does-not-exist", "test/compact", reported);
  const error = await fatal;
  assert.match(error.message, /ENOENT/);
  assert.equal(driver.error, error);
  await assert.rejects(driver.append("user", "lost"), /ENOENT/);
  await assert.rejects(driver.wait(), /ENOENT/);
  const first = driver.close();
  assert.equal(driver.close(), first, "close must not start a second shutdown");
  await first;
});

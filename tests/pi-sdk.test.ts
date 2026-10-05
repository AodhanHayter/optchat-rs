import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type Api, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import optchat from "../pi/index.ts";
import { textOf } from "../pi/memory.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("real pi SDK: file configuration, fresh turns, preserved tool loop, capped results, durable memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-sdk-"));
  const old = { bin: process.env.OPTCHAT_BIN, dir: process.env.OPTCHAT_DIR, model: process.env.OPTCHAT_MODEL, agentDir: process.env.PI_CODING_AGENT_DIR };
  await mkdir(join(dir, ".pi"));
  await writeFile(join(dir, ".pi/settings.json"), JSON.stringify({ optchat: { bin: resolve("target/debug/optchat"), dir: "../memory", model: "optchat-test/compact" } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.OPTCHAT_BIN;
  delete process.env.OPTCHAT_DIR;
  delete process.env.OPTCHAT_MODEL;
  const mainCalls: Message[][] = [];
  const compactCalls: Message[][] = [];
  const failures: unknown[] = [];
  let testPi!: Parameters<typeof optchat>[0];
  let stallCompactor = false;
  let cancelNext = false;
  let started!: () => void;
  const stalled = new Promise<void>(resolve => { started = resolve; });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "Stable test instructions.",
    extensionFactories: [
      (pi) => {
        testPi = pi;
        pi.on("context_with_system", (_event, ctx) => {
          if (cancelNext) { cancelNext = false; setImmediate(async () => { await session!.steer("Steered during wait."); ctx.abort(); }); }
        });
        pi.registerProvider("optchat-test", {
          baseUrl: "http://127.0.0.1:1", apiKey: "test-only", api: "openai-completions",
          models: ["master", "compact"].map(id => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
          streamSimple(model, context) {
            const stream = createAssistantMessageEventStream();
            const isCompact = model.id === "compact";

            if (isCompact && stallCompactor) {
              started();

              return stream;
            }

            (isCompact ? compactCalls : mainCalls).push(structuredClone(context.messages));
            const first = !isCompact && mainCalls.length === 1;

            const output: AssistantMessage = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id, usage,
              timestamp: Date.now(), stopReason: first ? "toolUse" : "stop",
              content: isCompact ? [{ type: "text", text: "user: retain RUST_MEMORY_TOKEN; echo: a long tool result" }] : first ? [
                { type: "thinking", thinking: "SECRET_THOUGHT_NOT_FOR_MEMORY", thinkingSignature: "native-signature" },
                { type: "toolCall", id: "large-1", name: "large_result", arguments: {} },
                { type: "toolCall", id: "zoom-1", name: "zoom", arguments: { id: 0, n: 1 } },
              ] : [{ type: "text", text: mainCalls.length === 2 ? "I learned RUST_MEMORY_TOKEN." : "I remember RUST_MEMORY_TOKEN." }],
            };

            stream.push({ type: "done", reason: first ? "toolUse" : "stop", message: output });
            stream.end();

            return stream;
          },
        });
        pi.registerTool({ name: "large_result", label: "Large result", description: "Test tool", parameters: Type.Object({}), execute: async (_id, _params, signal, _update, ctx) => {
          await ctx.executeTool("date", { id: 0 }, { signal });
          await session!.steer("Mid-run instruction: keep the token.");
          await session!.followUp("Queued follow-up question.");

          return { content: [{ type: "text", text: "HEAD" + "🦀".repeat(32_000) + "TAIL" }], details: undefined };
        } });
      },
      optchat,
    ],
  });

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    // Register model configuration on the runtime too, before selecting the main model.
    runtime.registerProvider("optchat-test", { baseUrl: "http://127.0.0.1:1", apiKey: "test-only", api: "openai-completions", models: ["master", "compact"].map(id => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
    const created = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("optchat-test", "master")!, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: ["large_result", "zoom", "date"] });
    session = created.session;
    await session.bindExtensions({ mode: "print", onError: error => failures.push(error), abortHandler: () => { void session?.abort(); } });
    await session.prompt("Remember RUST_MEMORY_TOKEN. " + "full user input ".repeat(2500));
    assert.equal(mainCalls.length, 3);
    assert.equal(mainCalls[2].filter(m => m.role === "assistant" || m.role === "toolResult").length, 0);
    assert.ok(JSON.stringify(mainCalls[2]).includes("Queued follow-up question."));
    await session.prompt("What did you learn?");
    assert.equal(mainCalls.length, 4);
    assert.deepEqual(failures, []);
    assert.ok(compactCalls.length > 0);
    const firstUser = mainCalls[0].find(m => m.role === "user")!;
    assert.ok(JSON.stringify(firstUser.content).includes("<chat>\\n</chat>"));
    const follow = mainCalls[1];
    assert.ok(JSON.stringify(follow).includes("native-signature"));
    assert.ok(JSON.stringify(follow).includes("Mid-run instruction"));
    const large = follow.find(m => m.role === "toolResult" && m.toolName === "large_result");
    assert.ok(large && large.role === "toolResult");
    const resultText = large.content.filter(c => c.type === "text").map(c => c.text).join("");
    assert.ok([...resultText].length <= 30_000);
    assert.ok(resultText.startsWith("HEAD"), resultText.slice(0, 500)); assert.ok(resultText.endsWith("TAIL"));
    const zoomed = follow.find(m => m.role === "toolResult" && m.toolName === "zoom");
    assert.ok(zoomed && zoomed.role === "toolResult");
    assert.ok(textOf(zoomed.content).length > 40_000, "zoom returns the whole message, uncapped");
    const next = mainCalls[3];
    assert.equal(next.filter(m => m.role === "assistant" || m.role === "toolResult").length, 0);
    assert.ok(JSON.stringify(next).includes("RUST_MEMORY_TOKEN"));
    assert.ok(!JSON.stringify(next).includes("SECRET_THOUGHT_NOT_FOR_MEMORY"));
    assert.equal(getCurrentSystemPrompt(mainCalls[0]), getCurrentSystemPrompt(next));
    testPi.sendMessage({ customType: "note", content: "IDLE_CUSTOM_NOTE", display: false });
    await session.prompt("After the idle note.");
    const noted = mainCalls.at(-1)!;
    assert.equal(noted.filter(m => m.role === "assistant" || m.role === "toolResult").length, 0);
    assert.ok(JSON.stringify(noted).includes("IDLE_CUSTOM_NOTE"));
    assert.deepEqual(failures, []);
    stallCompactor = true;
    await session.prompt("A long message: " + "uncached ".repeat(100));
    await stalled;
    const callsBeforeCancel = mainCalls.length;
    cancelNext = true;
    await session.prompt("Keep this unanswered cancelled message.");
    assert.equal(mainCalls.length, callsBeforeCancel, "cancelled settle must not call the main model");
    assert.deepEqual(failures, []);
    const files = await readdir(join(dir, "memory/main"));
    const rows = (await Promise.all(files.filter(f => f.endsWith(".jsonl")).sort().map(f => readFile(join(dir, "memory/main", f), "utf8")))).join("").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(!JSON.stringify(rows).includes("SECRET_THOUGHT_NOT_FOR_MEMORY"));
    assert.equal(rows.filter(m => m.kind === "user").length, 9, JSON.stringify(rows.filter(m => m.kind === "user").map(m => m.text.slice(0, 40))));
    assert.ok(rows.some(m => m.kind === "user" && m.text === "IDLE_CUSTOM_NOTE"));
    assert.ok(rows.some(m => m.kind === "tool" && m.text === 'date {"id":0}'), "nested tool call logged");
    assert.equal(rows.filter(m => m.kind === "tool").length, 3);
    assert.ok(rows.some(m => m.kind === "echo" && m.text.startsWith("0+0|user: Remember") && m.text.includes("omitted")), "zoom echo is capped in the log");
    assert.ok(rows.some(m => m.kind === "user" && m.text === "Keep this unanswered cancelled message."));
    assert.ok(rows.some(m => m.kind === "user" && m.text === "Steered during wait."), "undelivered steer is durable before any cancellation");
    assert.ok(rows.some(m => m.kind === "echo" && m.text.includes("omitted")));
    assert.ok(rows.some(m => m.kind === "talk" && m.text.includes("I remember")));
  } finally {
    if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();

    for (const [key, value] of Object.entries({ OPTCHAT_BIN: old.bin, OPTCHAT_DIR: old.dir, OPTCHAT_MODEL: old.model, PI_CODING_AGENT_DIR: old.agentDir })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

test("real pi SDK: OptChat toggle protects private turns and reports memory reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-toggle-"));
  const old = { bin: process.env.OPTCHAT_BIN, dir: process.env.OPTCHAT_DIR, model: process.env.OPTCHAT_MODEL, agentDir: process.env.PI_CODING_AGENT_DIR };
  process.env.OPTCHAT_BIN = resolve("target/debug/optchat");
  process.env.OPTCHAT_DIR = join(dir, "memory");
  process.env.OPTCHAT_MODEL = "optchat-toggle/compact";
  process.env.PI_CODING_AGENT_DIR = dir;
  const calls: Message[][] = [];
  const statuses: (string | undefined)[] = [];
  const notices: string[] = [];
  const failures: unknown[] = [];
  let testPi!: Parameters<typeof optchat>[0];
  let toolRequest = false;
  let attemptBusyToggle = false;
  let cancelNext = false;

  const provider = {
    baseUrl: "http://127.0.0.1:1", apiKey: "test-only", api: "openai-completions" as const,
    models: ["master", "compact"].map(id => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model: Model<Api>, context: { messages: Message[] }) {
      const stream = createAssistantMessageEventStream();
      const compact = model.id === "compact";

      if (!compact) calls.push(structuredClone(context.messages));
      const tools = !compact && toolRequest;

      if (!compact) toolRequest = false;

      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, usage,
        timestamp: Date.now(), stopReason: tools ? "toolUse" : "stop",
        content: tools ? [
          { type: "toolCall", id: `zoom-${calls.length}`, name: "zoom", arguments: { id: 0, n: 1 } },
          { type: "toolCall", id: `date-${calls.length}`, name: "date", arguments: { id: 0 } },
        ] : [{ type: "text", text: compact ? "A short summary." : "Reply to " + textOf(context.messages.filter(m => m.role === "user").at(-1)?.content ?? "").slice(-80) }],
      };

      stream.push({ type: "done", reason: tools ? "toolUse" : "stop", message });
      stream.end();

      return stream;
    },
  };

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
  runtime.registerProvider("optchat-toggle", provider);

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "Native test instructions.",
    extensionFactories: [pi => {
      testPi = pi;
      pi.registerProvider("optchat-toggle", provider);
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.setStatus = (key, text) => { if (key === "optchat") statuses.push(text); };

        ctx.ui.notify = message => { notices.push(message); };
      });
      pi.on("tool_execution_start", async () => {
        if (attemptBusyToggle) { attemptBusyToggle = false; await session!.prompt("/optchat off"); }
      });
      pi.on("context_with_system", (_event, ctx) => {
        if (cancelNext) { cancelNext = false; ctx.abort(); }
      });
    }, optchat],
  });

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  const rows = async () => {
    const files = (await readdir(join(dir, "memory/main"))).filter(f => f.endsWith(".jsonl")).sort();

    return (await Promise.all(files.map(f => readFile(join(dir, "memory/main", f), "utf8")))).join("").trim().split("\n").map(line => JSON.parse(line));
  };

  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("optchat-toggle", "master")!, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: ["zoom", "date"] }));
    await session.bindExtensions({ mode: "print", onError: error => failures.push(error), abortHandler: () => { void session?.abort(); } });
    assert.match(statuses.at(-1) ?? "", /OptChat: on/);
    await session.prompt("PUBLIC_BEFORE");
    assert.ok(statuses.some(s => s?.includes("reading memory")));
    assert.match(statuses.at(-1) ?? "", /last: context/);
    toolRequest = true;
    await session.prompt("Open the public message and its date.");
    assert.ok(statuses.some(s => s?.includes("reading memory · zoom 0+1")));
    assert.ok(statuses.some(s => s?.includes("reading memory · date 0")));
    await session.prompt("/optchat nonsense");
    assert.match(notices.at(-1) ?? "", /Usage/);
    await session.prompt("/optchat");
    assert.match(notices.at(-1) ?? "", /OptChat: on/);
    attemptBusyToggle = true;
    toolRequest = true;
    await session.prompt("PUBLIC_BUSY");
    assert.ok(notices.some(n => n.includes("idle")));
    assert.ok((await rows()).some(r => r.text === "PUBLIC_BUSY"));
    await session.prompt("/optchat off");
    assert.equal(statuses.at(-1), "OptChat: off");
    const beforePrivate = await rows();
    const readStatuses = statuses.length;
    toolRequest = true;
    await session.prompt("PRIVATE_OFF_TOKEN");
    const offContext = calls.at(-2)!;
    assert.equal(getCurrentSystemPrompt(offContext), session.systemPrompt);
    assert.equal(textOf(offContext.filter(m => m.role === "user").at(-1)?.content ?? ""), "PRIVATE_OFF_TOKEN");
    const offResults = calls.at(-1)!.filter(m => m.role === "toolResult").slice(-2);
    assert.equal(offResults.length, 2);
    assert.ok(offResults.every(m => m.role === "toolResult" && m.isError && textOf(m.content).includes("OptChat is off")));
    assert.deepEqual(await rows(), beforePrivate, "off must not append inputs, replies, calls, or results");
    assert.equal(statuses.length, readStatuses, "disabled tools must not read memory");
    // A private note or unanswered user entry must not be backfilled on re-enable.
    testPi.sendMessage({ customType: "private", content: "PRIVATE_IDLE_NOTE", display: false });
    await session.prompt("/optchat on");
    cancelNext = true;
    const beforeCancel = calls.length;
    await session.prompt("PUBLIC_CANCELLED");
    assert.equal(calls.length, beforeCancel, "cancelled resume must not call the main model");
    await session.prompt("PUBLIC_AFTER");
    const resumed = calls.at(-1)!;
    assert.ok(JSON.stringify(resumed).includes("PUBLIC_BEFORE"));
    assert.ok(JSON.stringify(resumed).includes("PUBLIC_AFTER"));
    assert.ok(!JSON.stringify(resumed).includes("PRIVATE_"));
    assert.ok(!JSON.stringify(await rows()).includes("PRIVATE_"));
    assert.ok((await rows()).some(r => r.text === "PUBLIC_AFTER"));
    assert.deepEqual(failures, []);
  } finally {
    if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();

    for (const [key, value] of Object.entries({ OPTCHAT_BIN: old.bin, OPTCHAT_DIR: old.dir, OPTCHAT_MODEL: old.model, PI_CODING_AGENT_DIR: old.agentDir })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

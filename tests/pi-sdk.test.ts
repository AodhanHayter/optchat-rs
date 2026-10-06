import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type Api, type AssistantMessage, type Context, type Message, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import optchat from "../pi/index.ts";
import { imageNotice, textOf } from "../pi/memory.ts";

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

test("real pi SDK: the extension factory launches no memory process before session_start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-lifecycle-"));
  const old = { bin: process.env.OPTCHAT_BIN, dir: process.env.OPTCHAT_DIR, model: process.env.OPTCHAT_MODEL, agentDir: process.env.PI_CODING_AGENT_DIR };
  // A launcher that records every spawn, so the assertion sees the process itself, not a side effect of it.
  const launcher = join(dir, "launch-optchat.sh");

  await writeFile(launcher, `#!/bin/sh\nprintf 'launched\\n' >> ${JSON.stringify(join(dir, "launched"))}\nexec ${JSON.stringify(resolve("target/debug/optchat"))} "$@"\n`);
  await chmod(launcher, 0o755);
  process.env.OPTCHAT_BIN = launcher;
  process.env.OPTCHAT_DIR = join(dir, "memory");
  process.env.OPTCHAT_MODEL = "optchat-lifecycle/compact";
  process.env.PI_CODING_AGENT_DIR = dir;
  const launched = async () => (await readdir(dir)).includes("launched");
  const failures: unknown[] = [];

  const provider = {
    baseUrl: "http://127.0.0.1:1", apiKey: "test-only", api: "openai-completions" as const,
    models: ["master", "compact"].map(id => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model: Model<Api>, _context: { messages: Message[] }) {
      const stream = createAssistantMessageEventStream();

      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, usage,
        timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "unused" }],
      };

      stream.push({ type: "done", reason: "stop", message });
      stream.end();

      return stream;
    },
  };

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });

  runtime.registerProvider("optchat-lifecycle", provider);

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "Lifecycle test instructions.",
    extensionFactories: [pi => { pi.registerProvider("optchat-lifecycle", provider); }, optchat],
  });

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(await launched(), false, "loading the extension must not launch the Rust process");
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("optchat-lifecycle", "master")!, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: ["zoom", "date"] }));
    assert.equal(await launched(), false, "creating the session must not launch the Rust process either");
    await session.bindExtensions({ mode: "print", onError: error => failures.push(error), abortHandler: () => { void session?.abort(); } });
    assert.equal(await launched(), true, "session_start owns the launch");
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

// A valid 1x1 PNG, so pi's image normalization accepts it.
const image = { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" };

interface Row { kind: string; text: string }

interface PlannedCall { name: string; arguments: Record<string, string | number | boolean> }

/** A real SDK session with OptChat loaded from a trusted project settings file and a scripted provider. */
interface Harness {
  session: AgentSession;
  /** Every main-model request: its messages and the tool names declared to it. */
  calls: { messages: Message[]; tools: string[] }[];
  /** Tool calls for the next main-model replies, one batch per reply; an empty queue replies with text. */
  plan: PlannedCall[][];
  failures: unknown[];
  rows(): Promise<Row[]>;
  close(): Promise<void>;
}

async function harness(label: string, search: boolean | undefined, extension: (pi: ExtensionAPI) => void, tools?: string[]): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), `optchat-${label}-`));
  const old = { OPTCHAT_BIN: process.env.OPTCHAT_BIN, OPTCHAT_DIR: process.env.OPTCHAT_DIR, OPTCHAT_MODEL: process.env.OPTCHAT_MODEL, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

  await mkdir(join(dir, ".pi"));
  await writeFile(join(dir, ".pi/settings.json"), JSON.stringify({ optchat: { bin: resolve("target/debug/optchat"), dir: "../memory", model: `${label}/compact`, search } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.OPTCHAT_BIN;
  delete process.env.OPTCHAT_DIR;
  delete process.env.OPTCHAT_MODEL;
  const calls: Harness["calls"] = [];
  const plan: PlannedCall[][] = [];
  const failures: unknown[] = [];
  let next = 0;

  const provider = {
    baseUrl: "http://127.0.0.1:1", apiKey: "test-only", api: "openai-completions" as const,
    models: ["master", "compact"].map(id => ({ id, name: id, reasoning: false, input: ["text" as const, "image" as const], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model: Model<Api>, context: Context) {
      const stream = createAssistantMessageEventStream();
      const compact = model.id === "compact";

      if (!compact) calls.push({ messages: structuredClone(context.messages), tools: getCurrentTools(context.messages).map(t => t.name) });
      const batch = compact ? undefined : plan.shift();

      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, usage,
        timestamp: Date.now(), stopReason: batch ? "toolUse" : "stop",
        content: batch ? batch.map(call => ({ type: "toolCall" as const, id: `call-${++next}`, name: call.name, arguments: call.arguments })) : [{ type: "text", text: compact ? "A short summary." : "ok" }],
      };

      stream.push({ type: "done", reason: batch ? "toolUse" : "stop", message });
      stream.end();

      return stream;
    },
  };

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });

  runtime.registerProvider(label, provider);

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "Harness instructions.",
    extensionFactories: [pi => { pi.registerProvider(label, provider); extension(pi); }, optchat],
  });

  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel(label, "master")!, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools });

  await session.bindExtensions({ mode: "print", onError: error => failures.push(error), abortHandler: () => { void session.abort(); } });

  return {
    session, calls, plan, failures,
    async rows() {
      const files = (await readdir(join(dir, "memory/main"))).filter(f => f.endsWith(".jsonl")).sort();

      return (await Promise.all(files.map(f => readFile(join(dir, "memory/main", f), "utf8")))).join("").trim().split("\n").map(line => JSON.parse(line));
    },
    async close() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();

      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }

      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Another extension's tools: a generic `search`, a tool kept inactive, and a probe that calls memory_search programmatically. */
function neighbor(pi: ExtensionAPI): void {
  pi.registerTool({ name: "search", label: "Search", description: "Another extension's generic search.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "OTHER_SEARCH" }], details: undefined }) });
  pi.registerTool({ name: "kept_inactive", label: "Kept inactive", description: "Deactivated by its owner.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }) });
  pi.registerTool({
    name: "probe", label: "Probe", description: "Calls memory_search through ctx.executeTool.", parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params, signal, _update, ctx) => {
      const outcome = await ctx.executeTool("memory_search", { text: params.text }, { signal });

      return { content: [{ type: "text", text: `${outcome.isError ? "ERROR" : "OK"} ${textOf(outcome.result.content)}` }], details: undefined };
    },
  });
  pi.on("session_start", () => { pi.setActiveTools(pi.getActiveTools().filter(name => name !== "kept_inactive")); });
}

function toolText(messages: Message[], name: string) {
  const result = messages.findLast(m => m.role === "toolResult" && m.toolName === name);

  assert.ok(result && result.role === "toolResult", `no ${name} result`);

  return { text: textOf(result.content), isError: result.isError };
}

test("real pi SDK: memory_search is neither declared nor callable unless optchat.search is true", async () => {
  for (const search of [undefined, false]) {
    const h = await harness("search-off", search, neighbor);

    try {
      assert.ok(h.session.getActiveToolNames().includes("zoom"), "OptChat itself is loaded");
      assert.ok(!h.session.getAllTools().some(t => t.name === "memory_search"));
      assert.ok(h.session.getActiveToolNames().includes("search") && h.session.getActiveToolNames().includes("probe"));
      assert.ok(!h.session.getActiveToolNames().includes("kept_inactive"));
      h.plan.push([{ name: "probe", arguments: { text: "anything" } }, { name: "memory_search", arguments: { text: "anything" } }, { name: "search", arguments: {} }]);
      await h.session.prompt("Try to search memory.");
      assert.ok(!h.calls[0].tools.includes("memory_search"));
      assert.ok(h.calls[0].tools.includes("search"));
      const probe = toolText(h.calls[1].messages, "probe");
      assert.match(probe.text, /^ERROR /, "programmatic invocation must fail when search is not enabled");
      assert.equal(toolText(h.calls[1].messages, "memory_search").isError, true);
      assert.equal(toolText(h.calls[1].messages, "search").text, "OTHER_SEARCH");
      assert.deepEqual(h.failures, []);
    } finally { await h.close(); }
  }
});

test("real pi SDK: optchat.search declares memory_search beside other extensions' tools, and off refuses it", async () => {
  const h = await harness("search-on", true, neighbor);

  try {
    assert.equal(h.session.getAllTools().find(t => t.name === "memory_search")?.exposure, "direct");

    for (const name of ["memory_search", "search", "probe", "read", "zoom", "date"]) assert.ok(h.session.getActiveToolNames().includes(name), name);
    assert.ok(!h.session.getActiveToolNames().includes("kept_inactive"), "registering memory_search must not reactivate another extension's tool");
    await h.session.prompt("First turn.");
    assert.ok(h.calls[0].tools.includes("memory_search") && h.calls[0].tools.includes("search"));
    assert.ok(!h.calls[0].tools.includes("kept_inactive"));
    await h.session.prompt("/optchat off");
    const before = await h.rows();
    h.plan.push([{ name: "memory_search", arguments: { text: "First" } }, { name: "probe", arguments: { text: "First" } }]);
    await h.session.prompt("Search while off.");
    const direct = toolText(h.calls.at(-1)!.messages, "memory_search");
    assert.equal(direct.isError, true);
    assert.match(direct.text, /OptChat is off/);
    assert.match(toolText(h.calls.at(-1)!.messages, "probe").text, /^ERROR .*OptChat is off/);
    assert.deepEqual(await h.rows(), before, "off must not record the search calls or results");
    assert.deepEqual(h.failures, []);
  } finally { await h.close(); }
});

test("real pi SDK: registering memory_search preserves tool activation with an explicit allowlist", async () => {
  for (const admitted of [true, false]) {
    const tools = ["search", "probe", "kept_inactive", "read", "zoom", "date"];

    if (admitted) tools.push("memory_search");
    const h = await harness("search-allowlist", true, neighbor, tools);

    try {
      assert.equal(h.session.getActiveToolNames().includes("memory_search"), admitted);
      assert.ok(!h.session.getActiveToolNames().includes("kept_inactive"));
      await h.session.prompt("Check tool declarations.");
      assert.equal(h.calls[0].tools.includes("memory_search"), admitted);
      assert.ok(!h.calls[0].tools.includes("kept_inactive"));
      assert.ok(h.calls[0].tools.includes("search"));
      assert.deepEqual(h.failures, []);
    } finally { await h.close(); }
  }
});

test("real pi SDK: memory_search returns the Rust search payload (requires target/debug/optchat built with the search op)", async () => {
  const h = await harness("search-rust", true, neighbor);

  try {
    await h.session.prompt("Remember NEEDLE_ALPHA in this message.");
    await h.session.prompt("A second message without the token.");
    h.plan.push([{ name: "memory_search", arguments: { text: "needle_alpha" } }, { name: "probe", arguments: { text: "NEEDLE_ALPHA" } }]);
    h.plan.push([{ name: "memory_search", arguments: { text: "needle_alpha", include_tools: true } }]);
    h.plan.push([{ name: "memory_search", arguments: { text: "   " } }]);
    await h.session.prompt("Search memory.");
    const first = toolText(h.calls.at(-3)!.messages, "memory_search");
    assert.equal(first.isError, false, `rebuild target/debug/optchat with the Phase 1 search op: ${first.text}`);
    const payload = JSON.parse(first.text);
    assert.equal(payload.hits.length, 1);
    assert.equal(payload.hits[0].kind, "user");
    assert.ok(payload.hits[0].snippet.includes("NEEDLE_ALPHA"));
    assert.ok(payload.hits[0].covering === null || Number.isInteger(payload.hits[0].covering.n));
    assert.equal(payload.next_before, null);
    assert.match(toolText(h.calls.at(-3)!.messages, "probe").text, /^OK \{"hits":\[\{/);
    const withTools = JSON.parse(toolText(h.calls.at(-2)!.messages, "memory_search").text);
    assert.ok(withTools.hits.some((hit: Row) => hit.kind === "tool"), "include_tools reaches Rust");
    assert.ok(withTools.hits.every((hit: { id: number }, i: number, all: { id: number }[]) => i === 0 || all[i - 1].id > hit.id), "newest first");
    const blank = toolText(h.calls.at(-1)!.messages, "memory_search");
    assert.equal(blank.isError, true, "Rust rejects a whitespace-only query without stopping OptChat");
    const older = withTools.hits.at(-1).id;
    h.plan.push([{ name: "memory_search", arguments: { text: "needle_alpha", include_tools: true, before: older } }]);
    await h.session.prompt("Older hits.");
    const paged = JSON.parse(toolText(h.calls.at(-1)!.messages, "memory_search").text);
    assert.ok(paged.hits.every((hit: { id: number }) => hit.id < older), "before is exclusive");
    assert.deepEqual(h.failures, []);
  } finally { await h.close(); }
});

test("real pi SDK: image attachments are noted once in memory while provider image blocks stay unchanged", async () => {
  let cancelNext = false;
  let session!: AgentSession;

  const h = await harness("images", undefined, pi => {
    pi.on("context_with_system", (_event, ctx) => {
      if (cancelNext) { cancelNext = false; ctx.abort(); }
    });
    pi.registerTool({ name: "snapshot", label: "Snapshot", description: "Large text and an image.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "HEAD" + "🦀".repeat(31_000) + "TAIL" }, image], details: undefined }) });
    pi.registerTool({ name: "picture", label: "Picture", description: "Only an image.", parameters: Type.Object({}), execute: async () => ({ content: [image], details: undefined }) });
    pi.registerTool({
      name: "nested", label: "Nested", description: "Calls picture and queues an image.", parameters: Type.Object({}),
      execute: async (_id, _params, signal, _update, ctx) => {
        await ctx.executeTool("picture", {}, { signal });
        await session.steer("QUEUED_WITH_IMAGE", [image]);

        return { content: [{ type: "text", text: "nested done" }], details: undefined };
      },
    });
  });

  session = h.session;
  const count = async (text: string) => (await h.rows()).filter(r => r.text === text).length;
  const images = (messages: Message[]) => messages.flatMap(m => (m.role === "user" || m.role === "toolResult") && Array.isArray(m.content) ? m.content.filter(b => b.type === "image") : []);

  try {
    h.plan.push([{ name: "snapshot", arguments: {} }, { name: "nested", arguments: {} }]);
    await h.session.prompt("", { images: [image] });
    assert.equal(h.calls.length, 2);
    assert.deepEqual(images(h.calls[0].messages), [image], "the image-only prompt reaches the provider unchanged");
    const follow = h.calls[1].messages;
    assert.deepEqual(images(follow), [image, image, image], "prompt, tool result, and queued images all reach the provider");
    const snapshot = follow.find(m => m.role === "toolResult" && m.toolName === "snapshot");
    assert.ok(snapshot && snapshot.role === "toolResult");
    assert.deepEqual(snapshot.content.at(-1), image);
    const capped = textOf(snapshot.content);
    assert.ok([...capped].length <= 30_000 && capped.startsWith("HEAD") && capped.endsWith("TAIL"), "tool result text cap is unchanged");
    assert.equal(await count(imageNotice), 2, "the image-only prompt and the nested picture result are each noted once");
    assert.equal((await h.rows()).filter(r => r.kind === "user" && r.text === imageNotice).length, 1);
    assert.equal((await h.rows()).filter(r => r.kind === "echo" && r.text === imageNotice).length, 1);
    assert.equal(await count(`QUEUED_WITH_IMAGE\n${imageNotice}`), 1, "queued input is noted at input, not again on delivery");
    const echo = (await h.rows()).filter(r => r.kind === "echo" && r.text.startsWith("HEAD"));
    assert.equal(echo.length, 1);
    assert.ok(echo[0].text.includes("omitted") && echo[0].text.endsWith(`TAIL\n${imageNotice}`));
    assert.ok(!JSON.stringify(await h.rows()).includes(image.data), "image bytes are never stored");

    cancelNext = true;
    const beforeCancel = h.calls.length;
    await h.session.prompt("ABORTED_WITH_IMAGE", { images: [image] });
    assert.equal(h.calls.length, beforeCancel, "the aborted turn must not call the main model");
    assert.equal(await count(`ABORTED_WITH_IMAGE\n${imageNotice}`), 1);
    await h.session.prompt("After abort.");
    assert.equal(await count(`ABORTED_WITH_IMAGE\n${imageNotice}`), 1, "an aborted image prompt is recorded exactly once");

    await h.session.prompt("/optchat off");
    const before = await h.rows();
    await h.session.prompt("PRIVATE_IMAGE", { images: [image] });
    assert.deepEqual(images(h.calls.at(-1)!.messages).at(-1), image);
    assert.deepEqual(await h.rows(), before, "off records no image notice");
    assert.deepEqual(h.failures, []);
  } finally { await h.close(); }
});

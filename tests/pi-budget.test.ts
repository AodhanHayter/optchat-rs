import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, estimateTokens, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import optchat from "../pi/index.ts";
import { recordedText } from "../pi/memory.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const contextWindow = 32_768;

const maxTokens = 4096;

const image = { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" };

// Issue #7: no delivered user message advances the memory boundary during these loops.
for (const scenario of ["tool loop", "parallel tools", "compaction disabled", "large user", "large system", "large tools", "images"] as const) {
  test(`real pi SDK: context budget stops safely and can resume (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "optchat-budget-"));
    const old = { bin: process.env.OPTCHAT_BIN, dir: process.env.OPTCHAT_DIR, model: process.env.OPTCHAT_MODEL, agentDir: process.env.PI_CODING_AGENT_DIR };
    process.env.OPTCHAT_BIN = resolve("target/debug/optchat");
    process.env.OPTCHAT_DIR = join(dir, "memory");
    process.env.OPTCHAT_MODEL = "optchat-budget/compact";
    process.env.PI_CODING_AGENT_DIR = dir;
    const calls: Message[][] = [];
    const failures: unknown[] = [];
    const notices: string[] = [];
    const payloads: string[] = [];
    const batch = scenario === "parallel tools" ? 3 : 1;
    const firstRequestTooLarge = ["large user", "large system", "large tools", "images"].includes(scenario);
    const prompt = scenario === "large user" ? "long input ".repeat(12_000) : "Run repeated large_result calls without new user messages.";
    let finishing = false;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

    const provider = {
      baseUrl: "http://127.0.0.1:1", apiKey: "test-only", api: "openai-completions" as const,
      models: ["master", "compact", "larger"].map(id => ({ id, name: id, reasoning: false, input: ["text" as const, "image" as const], contextWindow: id === "master" ? contextWindow : 200_000, maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      streamSimple(model: Model<Api>, context: { messages: Message[] }) {
        const stream = createAssistantMessageEventStream();
        const compact = model.id === "compact";

        if (!compact) calls.push(structuredClone(context.messages));
        // Bound the fixture even before the guard exists: the budget assertion must fail, not hang.
        const again = !compact && !finishing && calls.length <= 6;
        const input = context.messages.reduce((n, m) => n + estimateTokens(m), 0);

        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          usage: { ...usage, input, output: 32, totalTokens: input + 32 }, timestamp: Date.now(),
          stopReason: again ? "toolUse" : "stop",
          content: again ? [
            { type: "text", text: `Working on batch ${calls.length}.` },
            ...Array.from({ length: batch }, (_, i) => ({ type: "toolCall" as const, id: `result-${calls.length}-${i}`, name: "large_result", arguments: { n: calls.length * batch + i } })),
          ] : [{ type: "text", text: compact ? "Summary of completed tool work." : "Done." }],
        };

        stream.push({ type: "done", reason: again ? "toolUse" : "stop", message });
        stream.end();

        return stream;
      },
    };

    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: scenario !== "compaction disabled", reserveTokens: 8192, keepRecentTokens: 4096 }, retry: { enabled: false } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
    runtime.registerProvider("optchat-budget", provider);

    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => scenario === "large system" ? "instructions ".repeat(12_000) : "Budget test instructions.",
      extensionFactories: [pi => {
        pi.registerProvider("optchat-budget", provider);
        pi.on("session_start", (_event, ctx) => { ctx.ui.notify = message => { notices.push(message); }; });
        pi.registerTool({
          name: "large_result", label: "Large result", description: scenario === "large tools" ? "tool description ".repeat(9000) : "Return a result below OptChat's per-result cap",
          parameters: Type.Object({ n: Type.Integer() }),
          execute: async (_id, { n }) => {
            const text = `Result ${n}: ` + "tool-output ".repeat(2100);
            payloads.push(text);

            return { content: [{ type: "text", text }], details: undefined };
          },
        });
      }, optchat],
    });

    try {
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("optchat-budget", "master")!, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: ["large_result"] }));
      await session.bindExtensions({ mode: "print", onError: error => failures.push(error), abortHandler: () => { void session?.abort(); } });
      const images = scenario === "images" ? Array.from({ length: 30 }, () => image) : [];
      await session.prompt(prompt, { images });
      assert.deepEqual(failures, []);

      for (const messages of calls) {
        const input = messages.reduce((n, m) => n + estimateTokens(m), 0);
        assert.ok(input + maxTokens <= contextWindow, `over-budget request reached provider: ${input} input + ${maxTokens} output > ${contextWindow}`);
      }

      assert.ok(notices.some(n => n.includes("OptChat paused") && n.includes("context budget")), "a safe stop explains how to recover");
      assert.ok(notices.some(n => n.includes("new message")));

      if (firstRequestTooLarge) {
        assert.equal(calls.length, 0, "do not send even the initial request if it cannot fit");
      } else {
        assert.ok(calls.length > 1 && calls.length < 7, "exercise a tool loop, then stop before it overflows");
        assert.equal(payloads.length, calls.length * batch, "finish and record the entire tool batch before pausing");
        assert.equal(session.messages.filter(m => m.role === "toolResult").length, payloads.length, "the visible session keeps its full tool history");
      }

      const beforeResume = calls.length;
      finishing = true;

      // A huge fixed system prompt/tool schema needs a larger model, not just a fresh view.
      if (scenario === "large system" || scenario === "large tools") await session.setModel(runtime.getModel("optchat-budget", "larger")!);
      await session.prompt("Continue from memory and finish.");
      assert.equal(calls.length, beforeResume + 1, "budget pause must not permanently disable memory or require a restart");
      assert.equal(calls.at(-1)!.filter(m => m.role === "assistant" || m.role === "toolResult").length, 0);
      assert.deepEqual(failures, []);

      for (const messages of calls) {
        const pending = new Set<string>();

        for (const message of messages) {
          if (message.role === "assistant") {
            for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
          } else if (message.role === "toolResult") assert.ok(pending.delete(message.toolCallId));
        }

        assert.equal(pending.size, 0, "outgoing requests preserve complete tool-call/result groups");
      }

      const files = (await readdir(join(dir, "memory/main"))).filter(f => f.endsWith(".jsonl")).sort();
      const rows = (await Promise.all(files.map(f => readFile(join(dir, "memory/main", f), "utf8")))).join("").trim().split("\n").map(line => JSON.parse(line));

      for (const text of payloads) assert.equal(rows.filter(r => r.kind === "echo" && r.text === text).length, 1);
      assert.equal(rows.filter(r => r.kind === "tool" && r.text.startsWith("large_result ")).length, payloads.length);

      if (!firstRequestTooLarge) assert.equal(rows.filter(r => r.kind === "talk" && r.text.startsWith("Working on batch ")).length, beforeResume);
      const savedInput = rows.filter(r => r.kind === "user" && r.text !== "Continue from memory and finish.").map(r => r.text).join("");
      assert.equal(savedInput, recordedText([{ type: "text", text: prompt }, ...images]), "even refused input is durable in full, exactly once");
    } finally {
      if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();

      for (const [key, value] of Object.entries({ OPTCHAT_BIN: old.bin, OPTCHAT_DIR: old.dir, OPTCHAT_MODEL: old.model, PI_CODING_AGENT_DIR: old.agentDir })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }

      await rm(dir, { recursive: true, force: true });
    }
  });
}

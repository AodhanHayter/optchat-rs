import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import optchat from "../pi/index.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// GitHub issue #6: a pi-goal-style loop never produces an assistant reply with
// stopReason !== "toolUse" (each cycle ends in a tool call that terminates the run early,
// e.g. goal_wait), and the next cycle starts from an extension-injected user message
// (pi.sendUserMessage(text, { deliverAs: "followUp" }), the same call pi-goal makes).
// OptChat's turn boundary never advances, so every new cycle resends the entire raw
// transcript instead of a fresh, bounded view.
test("real pi SDK: goal-loop cycles (toolUse-ending turns + extension-injected continuations) get a fresh, bounded OptChat context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-goal-"));
  const old = { bin: process.env.OPTCHAT_BIN, dir: process.env.OPTCHAT_DIR, model: process.env.OPTCHAT_MODEL, agentDir: process.env.PI_CODING_AGENT_DIR };
  process.env.OPTCHAT_BIN = resolve("target/debug/optchat");
  process.env.OPTCHAT_DIR = join(dir, "memory");
  process.env.OPTCHAT_MODEL = "optchat-goal/compact";
  process.env.PI_CODING_AGENT_DIR = dir;

  const mainCalls: Message[][] = [];
  const failures: unknown[] = [];
  let testPi!: ExtensionAPI;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  // pi.sendUserMessage() (the real extension API, used by pi-goal) is fire-and-forget: it
  // returns void, not the triggered turn's completion. Wait for the next settle instead.
  function nextSettled(): Promise<void> {
    return new Promise(resolve => {
      const unsubscribe = session!.subscribe(event => {
        if (event.type === "agent_settled") { unsubscribe(); resolve(); }
      });
    });
  }

  const provider = {
    baseUrl: "http://127.0.0.1:1", apiKey: "test-only", api: "openai-completions" as const,
    models: ["master", "compact"].map(id => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model: Model<Api>, context: { messages: Message[] }) {
      const stream = createAssistantMessageEventStream();

      if (model.id === "compact") {
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "Compact goal summary." }] };

        stream.push({ type: "done", reason: "stop", message });
        stream.end();

        return stream;
      }

      mainCalls.push(structuredClone(context.messages));
      const n = mainCalls.length;

      // n=1: an ordinary (non-terminating) tool call within the first turn's own loop.
      // n=2,3: a goal_wait-style tool call that terminates the run early (stopReason stays "toolUse").
      // n=4: the goal finally finishes with a real "stop".
      const content: AssistantMessage["content"] = n === 1
        ? [{ type: "toolCall", id: "progress-note-1", name: "progress_note", arguments: {} }]
        : n <= 3
        ? [{ type: "toolCall", id: `goal-wait-${n - 1}`, name: "goal_wait", arguments: { cycle: n - 1 } }]
        : [{ type: "text", text: "Goal complete." }];

      const stopReason = n <= 3 ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason, content };

      stream.push({ type: "done", reason: stopReason, message });
      stream.end();

      return stream;
    },
  };

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
  runtime.registerProvider("optchat-goal", provider);

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "Stable goal test instructions.",
    extensionFactories: [
      pi => {
        testPi = pi;
        pi.registerProvider("optchat-goal", provider);
        // An ordinary tool call mid-turn that queues an aside (like /steer), distinct from the
        // goal continuation injected between cycles: it must not terminate the current turn.
        pi.registerTool({
          name: "progress_note", label: "Progress note", description: "Test stand-in for an ordinary mid-turn aside.",
          parameters: Type.Object({}),
          execute: async () => {
            await session!.steer("Ordinary steer during goal cycle 1.");

            return { content: [{ type: "text", text: "Progress noted." }], details: undefined };
          },
        });
        // Test stand-in for pi-goal's goal_wait tool: it returns terminate:true, which ends the
        // run even though the assistant message's own stopReason is still "toolUse".
        pi.registerTool({
          name: "goal_wait", label: "Goal Wait", description: "Test stand-in for pi-goal's goal_wait tool.",
          parameters: Type.Object({ cycle: Type.Integer() }),
          execute: async (_id, params) => ({ content: [{ type: "text", text: `Goal waiting after cycle ${params.cycle}.` }], details: undefined, terminate: true }),
        });
      },
      optchat,
    ],
  });

  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("optchat-goal", "master")!, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: ["progress_note", "goal_wait"] }));
    await session.bindExtensions({ mode: "print", onError: error => failures.push(error), abortHandler: () => { void session?.abort(); } });

    // Cycle 1: one uninterrupted turn (progress_note, then goal_wait terminates it).
    await session.prompt("Start the /goal. Note progress, then call goal_wait.");
    assert.equal(mainCalls.length, 2);

    // Cycle 2: the previous assistant message ended with stopReason "toolUse" (goal_wait), not
    // "stop". pi-goal wakes and injects a continuation exactly like this: pi.sendUserMessage(text,
    // { deliverAs: "followUp" }). No final assistant reply ever happened.
    const settled2 = nextSettled();
    testPi.sendUserMessage("Goal-injected continuation: resume cycle 2.", { deliverAs: "followUp" });
    await settled2;
    assert.equal(mainCalls.length, 3);

    // Cycle 3: a custom "work" message lands right at the boundary (an agent report, not the
    // user's words), then another goal continuation finally lets the model finish for real.
    const settled3 = nextSettled();
    testPi.sendMessage({ customType: "goal_note", content: "CUSTOM_WORK_AROUND_BOUNDARY", display: false });
    testPi.sendUserMessage("Goal-injected continuation: resume cycle 3.", { deliverAs: "followUp" });
    await settled3;
    assert.equal(mainCalls.length, 4);
    assert.deepEqual(failures, []);

    // --- The issue #6 symptom: each goal-injected continuation must start from a fresh, bounded
    // OptChat view, not the raw transcript of every earlier toolUse-ending cycle.
    for (const index of [2, 3]) {
      assert.equal(
        mainCalls[index].filter(m => m.role === "assistant" || m.role === "toolResult").length, 0,
        `cycle starting at mainCalls[${index}] must see a fresh OptChat view; got raw assistant/toolResult messages carried over from earlier goal_wait cycles (issue #6)`,
      );
    }

    // --- Tool call/result pairs must never be split, in every request actually sent.
    for (const [index, calls] of mainCalls.entries()) {
      const pending = new Set<string>();

      for (const m of calls) {
        if (m.role === "assistant") {
          for (const block of m.content) if (block.type === "toolCall") pending.add(block.id);
        } else if (m.role === "toolResult") {
          assert.ok(pending.delete(m.toolCallId), `mainCalls[${index}]: toolResult ${m.toolCallId} has no preceding toolCall`);
        }
      }

      assert.equal(pending.size, 0, `mainCalls[${index}]: unanswered toolCall(s) ${[...pending]}`);
    }

    // --- Durability: every original is recorded exactly once, regardless of how the view is
    // composed: the goal continuations, an ordinary mid-turn steer, and the custom work message.
    const files = (await readdir(join(dir, "memory/main"))).filter(f => f.endsWith(".jsonl")).sort();
    const rows = (await Promise.all(files.map(f => readFile(join(dir, "memory/main", f), "utf8")))).join("").trim().split("\n").map(line => JSON.parse(line));
    const count = (kind: string, text: string) => rows.filter(r => r.kind === kind && r.text === text).length;

    assert.equal(count("user", "Start the /goal. Note progress, then call goal_wait."), 1);
    assert.equal(count("user", "Goal-injected continuation: resume cycle 2."), 1);
    assert.equal(count("user", "Goal-injected continuation: resume cycle 3."), 1);
    assert.equal(count("user", "Ordinary steer during goal cycle 1."), 1, "an ordinary mid-turn steer is durable exactly once");
    assert.equal(count("work", "CUSTOM_WORK_AROUND_BOUNDARY"), 1, "a custom message around the boundary is an agent's report, logged exactly once");
    assert.equal(rows.filter(r => r.kind === "tool" && r.text.startsWith("goal_wait")).length, 2);
    assert.equal(rows.filter(r => r.kind === "echo" && r.text.startsWith("Goal waiting after cycle")).length, 2);
  } finally {
    if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();

    for (const [key, value] of Object.entries({ OPTCHAT_BIN: old.bin, OPTCHAT_DIR: old.dir, OPTCHAT_MODEL: old.model, PI_CODING_AGENT_DIR: old.agentDir })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

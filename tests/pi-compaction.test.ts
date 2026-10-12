import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import optchat from "../pi/index.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const scenario of ["restart", "cancel", "failed summaries", "checkpoint failure"] as const) {
  test(`real pi SDK: manual compaction preserves recall and logging (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "optchat-native-"));
    const previous = { OPTCHAT_BIN: process.env.OPTCHAT_BIN, OPTCHAT_DIR: process.env.OPTCHAT_DIR, OPTCHAT_MODEL: process.env.OPTCHAT_MODEL, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
    Object.assign(process.env, { OPTCHAT_BIN: resolve("target/debug/optchat"), OPTCHAT_DIR: join(dir, "memory"), OPTCHAT_MODEL: "native/compact", PI_CODING_AGENT_DIR: dir });
    const requests: Message[][] = [];
    const errors: unknown[] = [];
    const notices: string[] = [];
    let failSummary = false;
    let checkpointFailure = false;
    let cancel = false;
    let wake!: () => void;
    const rejectedSummary = new Promise<void>(resolve => { wake = resolve; });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

    const provider = {
      baseUrl: "http://127.0.0.1:1", apiKey: "test-only", api: "openai-completions" as const,
      models: ["master", "compact"].map(id => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 32_768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      streamSimple(model: Model<Api>, context: { messages: Message[] }) {
        const stream = createAssistantMessageEventStream();
        const summary = model.id === "compact";
        const failed = summary && failSummary;

        if (!summary) requests.push(structuredClone(context.messages));
        const tool = !summary && (requests.length <= 2 || requests.length === 4);

        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          usage, timestamp: Date.now(), stopReason: failed ? "error" : tool ? "toolUse" : "stop",
          errorMessage: failed ? "offline fixture" : undefined,
          content: tool ? [{ type: "toolCall", id: `call-${requests.length}`, name: "step", arguments: { n: requests.length } }] : [{ type: "text", text: summary ? "Remember the task and completed steps; zoom for originals." : "Done." }],
        };

        if (failed) { wake(); stream.push({ type: "error", reason: "error", error: message }); }
        else stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
        stream.end();

        return stream;
      },
    };

    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
    runtime.registerProvider("native", provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1024 }, retry: { enabled: false } });
    let manager = SessionManager.create(dir, join(dir, "sessions"));

    async function open() {
      const resourceLoader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPromptOverride: () => "Follow the task.",
        extensionFactories: [pi => {
          pi.registerProvider("native", provider);
          pi.registerTool({ name: "step", label: "Step", description: "Complete one step", parameters: Type.Object({ n: Type.Integer() }), execute: async (_id, { n }) => ({ content: [{ type: "text", text: `STEP-${n}: ${"details ".repeat(900)}` }], details: undefined, terminate: n === 2 }) });
          pi.on("session_start", (_event, ctx) => { ctx.ui.notify = text => { notices.push(text); }; });
        }, pi => optchat({ ...pi, appendEntry: (type, data) => {
          if (checkpointFailure && type === "optchat.cursor") throw new Error("checkpoint write failed");
          pi.appendEntry(type, data);
        } }), pi => {
          pi.on("session_before_compact", () => cancel ? { cancel: true } : undefined);
        }],
      });

      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("native", "master")!, resourceLoader, settingsManager, sessionManager: manager, tools: ["step", "zoom"] }));
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error), abortHandler: () => { void session?.abort(); } });

      return session;
    }

    async function rows() {
      const files = (await readdir(join(dir, "memory/main"))).filter(file => file.endsWith(".jsonl")).sort();

      return (await Promise.all(files.map(file => readFile(join(dir, "memory/main", file), "utf8")))).join("").trim().split("\n").map(line => JSON.parse(line));
    }

    try {
      const active = await open();
      await active.prompt("TASK-ORIGINAL: do both steps, then finish.");
      assert.equal(requests.length, 2);
      const entriesBefore = manager.getEntries().filter(entry => entry.type === "message");

      if (scenario === "checkpoint failure") {
        checkpointFailure = true;
        await assert.rejects(active.compact(), /cancel/i);
        assert.equal(manager.getEntries().filter(entry => entry.type === "compaction").length, 0);
        assert.ok(notices.some(text => text.includes("OptChat stopped: checkpoint write failed")));
        assert.equal((await rows()).filter(row => row.kind === "echo").length, 2, "a failed session checkpoint does not remove durable originals");
      } else if (scenario === "failed summaries") {
        failSummary = true;
        await active.sendCustomMessage({ customType: "report", content: "IDLE-REPORT: " + "report ".repeat(800), display: true }, { triggerTurn: false });
        const compacting = active.compact();
        await rejectedSummary;
        active.abortCompaction();
        await assert.rejects(compacting);
        assert.equal(manager.getEntries().filter(entry => entry.type === "compaction").length, 0);
        assert.ok((await rows()).some(row => row.kind === "work" && row.text.startsWith("IDLE-REPORT:")), "pending delivered reports are durable even if the summary fails");
      } else {
        cancel = scenario === "cancel";

        if (cancel) {
          await assert.rejects(active.compact(), /cancel/i);
          assert.equal(manager.getEntries().filter(entry => entry.type === "compaction").length, 0);
          cancel = false;
        }

        await active.compact();
        const compact = manager.getEntries().findLast(entry => entry.type === "compaction");
        assert.equal(compact?.fromHook, true);
        assert.ok(compact?.summary.includes("<chat>"));
        assert.equal(manager.getEntries().filter(entry => entry.type === "message").length, entriesBefore.length, "Pi compaction preserves the original session entries");
        const loggedBefore = await rows();
        assert.equal(loggedBefore.filter(row => row.kind === "user").length, 1);
        assert.equal(loggedBefore.filter(row => row.kind === "tool").length, 2);
        assert.equal(loggedBefore.filter(row => row.kind === "echo").length, 2);

        if (scenario === "restart") {
          await active.sendCustomMessage({ customType: "late-report", content: "RESTART-REPORT: pending instructions survive reload.", display: true }, { triggerTurn: false });
          const file = manager.getSessionFile()!;
          await active.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          active.dispose();
          session = undefined;
          manager = SessionManager.open(file);
          await open();
        }

        // Continue the persisted split turn, with no new user message to repair our state.
        await session!.agent.continue();
        assert.equal(session!.getLastAssistantText(), "Done.");
        const request = requests.at(-1)!;
        const memory = request.filter(message => message.role === "user" && JSON.stringify(message.content).includes("<chat>"));
        assert.equal(memory.length, 1, "native summary is the only memory snapshot");
        assert.equal(request.filter(message => message.role === "toolResult").length, 1, "only Pi's retained tool batch survives");
        const after = await rows();
        assert.deepEqual(after.filter(row => row.kind !== "talk" && row.kind !== "work"), loggedBefore.filter(row => row.kind !== "talk" && row.kind !== "work"), "retained originals are not logged again after compaction or restart");

        if (scenario === "restart") assert.equal(after.filter(row => row.kind === "work" && row.text.startsWith("RESTART-REPORT:")).length, 1, "an idle report after the last durable checkpoint is not lost on restart");
        const zoom = session!.agent.state.tools.find(tool => tool.name === "zoom")!;
        const result = await zoom.execute("recall", { id: 0, n: 1 });
        assert.match(JSON.stringify(result.content), /TASK-ORIGINAL/);
        await session!.prompt("NEW-TASK: perform one more step.");
        const next = requests.at(-1)!;
        assert.deepEqual(next.filter(message => message.role === "toolResult").map(message => message.toolCallId), ["call-4"], "a fresh turn must not resurrect the suffix of an earlier compaction");
        assert.equal(next.filter(message => message.role === "user" && JSON.stringify(message.content).includes("<chat>")).length, 1);
      }

      assert.deepEqual(errors, []);
    } finally {
      if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();

      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }

      await rm(dir, { recursive: true, force: true });
    }
  });
}

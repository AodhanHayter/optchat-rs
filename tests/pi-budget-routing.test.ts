import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import optchat from "../pi/index.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface WireRequest { max_tokens?: number; max_completion_tokens?: number }

// PR #9 review: observe actual HTTP dispatch after routing, all context transforms,
// and Pi's built-in output-token clamp, rather than a mock provider's entry point.
for (const scenario of ["physical control", "virtual defaults", "virtual misleading limits", "later context", "forced system", "llama 32k", "llama 128k", "anthropic control", "anthropic oversized", "unknown payload"] as const) {
  test(`real pi SDK: final request budget (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "optchat-budget-routing-"));
    const old = { bin: process.env.OPTCHAT_BIN, dir: process.env.OPTCHAT_DIR, model: process.env.OPTCHAT_MODEL, agentDir: process.env.PI_CODING_AGENT_DIR };
    process.env.OPTCHAT_BIN = resolve("target/debug/optchat");
    process.env.OPTCHAT_DIR = join(dir, "memory");
    process.env.OPTCHAT_MODEL = "optchat-routing/compact";
    process.env.PI_CODING_AGENT_DIR = dir;
    const requests: WireRequest[] = [];
    const failures: unknown[] = [];
    const notices: string[] = [];
    const virtual = scenario.startsWith("virtual");
    const local = scenario.startsWith("llama");
    const anthropic = scenario.startsWith("anthropic");
    const contextWindow = scenario === "llama 128k" ? 131_072 : 32_768;
    const shouldPause = ["virtual misleading limits", "later context", "forced system", "anthropic oversized", "unknown payload"].includes(scenario);
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      requests.push(await new Request(_input, init).json());

      if (anthropic) {
        const events = [
          { type: "message_start", message: { id: "test-response", type: "message", role: "assistant", model: "master", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "Done." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ];

        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
      }

      const chunk = { id: "test-response", object: "chat.completion.chunk", created: 0, model: "master", choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: "stop" }] };

      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    };

    const provider = {
      baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only", api: anthropic ? "anthropic-messages" as const : "openai-completions" as const,
      models: ["master", "compact"].map(id => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: id === "master" ? contextWindow : 200_000, maxTokens: id === "master" && local ? contextWindow : 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
        if (model.id === "master") return streamSimple(model, context, { ...options, fetch: mockFetch });
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "Summary." }] };
        stream.push({ type: "done", reason: "stop", message });
        stream.end();

        return stream;
      },
    };

    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
    runtime.registerProvider("optchat-routing", provider);

    if (virtual) runtime.registerVirtualModel({
      provider: "router", id: "auto", name: "Auto",
      contextWindow: scenario === "virtual misleading limits" ? 200_000 : undefined,
      maxTokens: scenario === "virtual misleading limits" ? 4096 : undefined,
      route: () => ({ model: runtime.getModel("optchat-routing", "master")!, thinkingLevel: "off" }),
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => "Short instructions.",
      extensionFactories: [pi => {
        pi.registerProvider("optchat-routing", provider);

        if (scenario === "unknown payload") pi.on("before_provider_request", () => ({ opaque: true }));
        pi.on("session_start", (_event, ctx) => { ctx.ui.notify = message => { notices.push(message); }; });
      }, optchat, pi => {
        if (scenario === "later context" || scenario === "anthropic oversized") pi.on("context_with_system", event => ({
          messages: [...event.messages, { role: "user", content: "large input ".repeat(12_000), timestamp: 0 }],
        }));

        if (scenario === "forced system") pi.on("before_agent_start", () => ({ systemPrompt: "large instructions ".repeat(8000) }));
      }],
    });

    try {
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel(virtual ? "router" : "optchat-routing", virtual ? "auto" : "master")!, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: [] }));
      await session.bindExtensions({ mode: "print", onError: error => failures.push(error), abortHandler: () => { void session?.abort(); } });
      await session.prompt(scenario === "virtual misleading limits" ? "large input ".repeat(12_000) : "Short prompt.");
      assert.deepEqual(failures, []);

      if (shouldPause) {
        assert.equal(requests.length, 0, "an oversized final request must never reach the HTTP transport");
        assert.ok(notices.some(n => n.includes("OptChat paused")));
      } else {
        assert.equal(requests.length, 1, "a valid short request must not be blocked by virtual/catalog limits");
        assert.equal(notices.some(n => n.includes("OptChat paused")), false);
        assert.equal(session.getLastAssistantText(), "Done.");
        const outputLimit = requests[0].max_tokens ?? requests[0].max_completion_tokens;
        assert.ok(outputLimit !== undefined && outputLimit > 0 && outputLimit < contextWindow, "the provider uses the effective output limit");
      }
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

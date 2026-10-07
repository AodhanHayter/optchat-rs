import { open } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getCurrentSystemPrompt, type UserMessage } from "@earendil-works/pi-ai";
import type { ContextEventResult, ExtensionAPI, ExtensionContext, MessageEndEventResult } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";
import { Type } from "typebox";
import { MemoryDriver, cachePayload, recordedText, textOf, type Prepared } from "./memory.ts";
import { capText } from "./transport.ts";
import { loadConfig, resolvePath } from "./config.ts";

/** Every way OptChat can refuse work: a dead Rust process, a driver fault, or a session that is off. */
class OptChatError extends Data.TaggedError("OptChatError")<{ readonly message: string }> {}

interface Prompts { master: string; view: string }

function asError(cause: unknown): OptChatError {
  if (cause instanceof OptChatError) return cause;

  return new OptChatError({ message: cause instanceof Error ? cause.message : String(cause) });
}

/** The driver and the Rust client stay Promise-shaped; this is the only crossing into the error channel. */
function attempt<A>(work: () => Promise<A>): Effect.Effect<A, OptChatError> {
  return Effect.tryPromise({ try: work, catch: asError });
}

/** Creates `path` private (0600 on Unix) and durable. `wx` refuses any existing entry, a symlink included. */
async function writeNewPrivate(path: string, text: string): Promise<void> {
  const file = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EEXIST" ? new Error("it already exists and OptChat never overwrites; choose a new path") : error;
  });

  try {
    await file.writeFile(text);
    await file.sync();
  } catch (error) {
    // The pathname may now belong to another file. Never unlink it on failure.
    await file.close().catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; a partial snapshot may remain at ${path}`, { cause: error });
  }

  await file.close();
}

/** Command feedback: print and JSON modes have no UI, so their notifications go to stderr as pi's own do. */
function tell(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  ctx.ui.notify(message, level);

  if (!ctx.hasUI) console.error(message);
}

export default function optchat(pi: ExtensionAPI): void {
  // pi-subagents children must not compete for the master's writer lock or log their tool loops.
  if (process.env.PI_SUBAGENT_CHILD) return;
  let driver: MemoryDriver | undefined;
  let context: ExtensionContext;
  let fatal: OptChatError | undefined;
  let prompts: Prompts = { master: "", view: "" };
  let systemPrompt: string | undefined;
  // Turn state is derived from pi's own transcript positions, never from message identity.
  let anchor = -1; // index of the first message of the current turn
  let cursor = 0; // context messages whose user/custom entries are already in the log
  let promptStarted = false; // the next turn starts from an idle prompt, not from pi's queue
  let prepared: Prepared | undefined;
  let enabled = true;
  let switching = false;
  let resumed = false;
  let floor = 0; // transcript entries before re-enable are never part of a saved turn
  let config: ReturnType<typeof loadConfig> | undefined;
  let reads = 0;
  let reading = 0;
  let lastRead = "";
  let searchRegistered = false;

  /** The live driver, or the failure that explains why there is none. */
  const running: Effect.Effect<MemoryDriver, OptChatError> = Effect.suspend(() => {
    const active = driver;

    return active ? Effect.succeed(active) : Effect.fail(fatal ?? new OptChatError({ message: "OptChat is not running" }));
  });

  function status(ctx = context): void {
    const text = !enabled ? "OptChat: off" : fatal ? "OptChat: error" : reading ? `OptChat: reading memory · ${lastRead}` : `OptChat: on${reads ? ` · ${reads} reads · last: ${lastRead}` : ""}`;
    ctx.ui.setStatus("optchat", text);
  }

  /** A memory read reported in the status line; the counters are restored even when the read fails. */
  function read<A>(label: string, work: (memory: MemoryDriver) => Promise<A>): Effect.Effect<A, OptChatError> {
    return Effect.gen(function* () {
      if (!enabled) return yield* Effect.fail(new OptChatError({ message: "OptChat is off. Use /optchat on to enable memory." }));
      const memory = yield* running;

      reads++; reading++; lastRead = label; status();

      return yield* Effect.ensuring(attempt(() => work(memory)), Effect.sync(() => { reading--; lastRead = label; status(); }));
    });
  }

  function append(kind: string, text: string): Effect.Effect<void, OptChatError> {
    return Effect.flatMap(running, memory => attempt(() => memory.append(kind, text)));
  }

  /** The factory starts nothing: the Rust process is launched here, from a live session. */
  function start(ctx: ExtensionContext): Effect.Effect<void, OptChatError> {
    return Effect.gen(function* () {
      if (!driver) {
        const settings = config ??= yield* Effect.try({ try: () => loadConfig(ctx.cwd, ctx.isProjectTrusted()), catch: asError });
        // Pi's own session id when the installed SDK exposes one; the Rust writer never sees it.
        const sessionId = ctx.sessionManager.getSessionId();
        driver = yield* Effect.try({ try: () => new MemoryDriver(ctx, settings.bin, settings.dir, settings.model, error => fail(error), sessionId), catch: asError });

        if (settings.search) registerSearch();
      }

      const memory = driver;

      prompts = yield* attempt(() => memory.client.call<Prompts>("prompts"));
      memory.kick();
    });
  }

  function fail(cause: unknown, ctx = context): void {
    fatal = asError(cause);
    status(ctx);
    ctx.ui.notify(`OptChat stopped: ${fatal.message}. Fix the cause and restart pi.`, "error");
    ctx.abort();
  }

  function enable(ctx: ExtensionContext): Effect.Effect<void, OptChatError> {
    return Effect.gen(function* () {
      fatal = undefined;
      resumed = true;
      yield* start(ctx);
      ctx.ui.notify("OptChat: on. Messages from while it was off will not be saved to OptChat.", "info");
    });
  }

  function disable(ctx: ExtensionContext): Effect.Effect<void, OptChatError> {
    return Effect.gen(function* () {
      status(ctx);
      const memory = driver;

      if (memory) yield* attempt(() => memory.close());
      driver = undefined;
      ctx.ui.notify("OptChat: off. Memory reads and writes are disabled. Pi still keeps its own session history.", "info");
    });
  }

  /** `/optchat [on|off]`: the switching flag is released whichever way the toggle ends. */
  function toggle(action: string, ctx: ExtensionContext): Effect.Effect<void> {
    return Effect.gen(function* () {
      if (!action) {
        status();
        ctx.ui.notify(enabled ? "OptChat: on" : "OptChat: off", "info");

        return;
      }

      if (!["on", "off"].includes(action)) {
        ctx.ui.notify("Usage: /optchat [on|off|status|usage|browse PATH]", "warning");

        return;
      }

      if (switching || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait until the agent is idle and its queue is empty, then run /optchat again.", "warning");

        return;
      }

      const next = action === "on";

      if (next === enabled) {
        status();
        ctx.ui.notify(enabled ? "OptChat: on" : "OptChat: off", "info");

        return;
      }

      switching = true;
      enabled = next;
      anchor = -1; cursor = 0; prepared = undefined; promptStarted = false;

      yield* Effect.ensuring(
        Effect.catch(enabled ? enable(ctx) : disable(ctx), error => Effect.sync(() => fail(error, ctx))),
        Effect.sync(() => { switching = false; status(); }),
      );
    });
  }

  /** `/optchat browse PATH`: the live Rust process exports, so no second writer opens the memory directory.
   *  Every failure is reported to the user; none stops OptChat or the chat. */
  function browse(destination: string, ctx: ExtensionContext): Effect.Effect<void> {
    if (!destination) return Effect.sync(() => tell(ctx, "Usage: /optchat browse PATH (writes a new private HTML snapshot of memory; never overwrites)", "warning"));
    const path = resolvePath(ctx.cwd, destination);

    return Effect.catch(
      Effect.gen(function* () {
        const html = yield* read("browse", memory => memory.client.call<string>("export"));

        yield* attempt(() => writeNewPrivate(path, html));
        tell(ctx, `OptChat: wrote a private, read-only memory snapshot to ${path}. It contains saved chat history; share it with care.`, "info");
      }),
      error => Effect.sync(() => tell(ctx, `OptChat browse did not write ${path}: ${error.message}`, "error")),
    );
  }

  /** `/optchat status`: store path, the Rust `status` RPC fields, and the driver's own provider-attempt counts.
   *  Read-only; off is reported the same way browse reports it, without starting a writer. */
  function showStatus(ctx: ExtensionContext): Effect.Effect<void> {
    return Effect.catch(
      Effect.gen(function* () {
        const rpc = yield* read("status", active => active.client.call<RpcStatus>("status"));
        const memory = yield* running;

        const counts = memory.diagnostics();

        const lines = [
          "OptChat status",
          `  store: ${config?.dir ?? "(unknown)"}`,
          `  messages: ${rpc.messages}`,
          `  view bytes: ${rpc.bytes}`,
          `  budget: ${rpc.budget}`,
          `  pending jobs: ${rpc.busy}`,
          `  settled: ${rpc.settled}`,
          `  active provider attempts: ${counts.activeJobs}`,
          `  retrying (cooldown): ${counts.retryingJobs}`,
        ];

        tell(ctx, lines.join("\n"), "info");
      }),
      error => Effect.sync(() => tell(ctx, `OptChat status unavailable: ${error.message}`, "error")),
    );
  }

  /** `/optchat usage`: the driver's private compactor ledger, flushed and summarized; never a provider call. */
  function showUsage(ctx: ExtensionContext): Effect.Effect<void> {
    return Effect.catch(
      Effect.gen(function* () {
        const text = yield* read("usage", active => active.usage());

        tell(ctx, text, "info");
      }),
      error => Effect.sync(() => tell(ctx, `OptChat usage unavailable: ${error.message}`, "error")),
    );
  }

  pi.registerCommand("optchat", {
    description: "Show memory status, enable/disable OptChat, inspect compactor usage, or save an HTML memory snapshot: /optchat [on|off|status|usage|browse PATH]",
    handler: async (args, ctx) => {
      context = ctx;
      const command = args.trim();
      const browsing = /^browse(?:\s+([\s\S]*))?$/.exec(command);

      if (browsing) {
        await Effect.runPromise(browse(browsing[1] ?? "", ctx));

        return;
      }

      if (command === "status") {
        await Effect.runPromise(showStatus(ctx));

        return;
      }

      if (command === "usage") {
        await Effect.runPromise(showUsage(ctx));

        return;
      }

      await Effect.runPromise(toggle(command, ctx));
    },
  });

  function isText(m: AgentMessage): m is AgentMessage & { role: "user" | "custom"; content: UserMessage["content"] } {
    return m.role === "user" || m.role === "custom";
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    anchor = -1; cursor = 0; floor = 0; prepared = undefined;

    await Effect.runPromise(Effect.catch(
      Effect.gen(function* () {
        if (enabled) yield* start(ctx);
        status(ctx);
      }),
      error => Effect.sync(() => fail(error, ctx)),
    ));
  });

  pi.on("input", async (event, ctx) => {
    context = ctx;

    if (!enabled) return { action: "continue" };

    if (fatal || !driver) {
      ctx.ui.notify(`OptChat is unavailable: ${fatal?.message ?? "not started"}`, "error");

      return { action: "handled" };
    }

    // Queued input is durable immediately: pi can discard its queue, and the delivered copy
    // can differ (skill/template expansion). Every mid-run user message comes from this queue.
    if (!event.streamingBehavior) return { action: "continue" };

    return Effect.runPromise(Effect.catch(
      Effect.as(append("user", recordedText([{ type: "text", text: event.text }, ...(event.images ?? [])])), { action: "continue" } as const),
      error => Effect.sync(() => {
        fail(error, ctx);

        return { action: "handled" } as const;
      }),
    ));
  });

  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;

    if (!enabled) return;
    promptStarted = true;
    anchor = -1;
    systemPrompt ??= `${prompts.master}\n${prompts.view}\n${event.systemPrompt}`;

    return { systemPrompt };
  });
  pi.on("session_before_compact", () => enabled ? { cancel: true } : undefined);
  pi.on("cache_warming_decision", () => enabled ? { action: "stop" } : undefined);

  /** Everything the model said or saw, in the order the transcript finalized it. */
  function record(message: AgentMessage): Effect.Effect<MessageEndEventResult | undefined, OptChatError> {
    return Effect.gen(function* () {
      if (message.role === "assistant") {
        if (message.stopReason === "error") return undefined; // pi retries; the retry's reply is logged

        for (const block of message.content) {
          if (block.type === "text" && block.text) yield* append("talk", block.text);

          if (block.type === "toolCall") yield* append("tool", `${block.name} ${JSON.stringify(block.arguments)}`);
        }

        return undefined;
      }

      if (message.role !== "toolResult") return undefined;
      const text = textOf(message.content);
      const capped = capText(text);
      const recorded = recordedText(message.content);

      yield* append("echo", recorded === text ? capped : capText(recorded));

      // Memory tools return memory itself; memory_search output is already bounded by Rust.
      if (capped === text || ["zoom", "date", "memory_search"].includes(message.toolName)) return undefined;
      // `structuredContent` would otherwise outlive the text it described.
      const replacement = { ...message, content: [{ type: "text" as const, text: capped }, ...message.content.filter(b => b.type !== "text")], structuredContent: undefined };

      return { message: replacement };
    });
  }

  pi.on("message_end", async (event, ctx) => {
    context = ctx;

    if (!enabled) return undefined;

    if (fatal) {
      ctx.abort();

      return undefined;
    }

    return Effect.runPromise(Effect.catch(record(event.message), error => Effect.sync(() => {
      fail(error, ctx);

      return undefined;
    })));
  });

  // Nested calls (codemode, ctx.executeTool) never produce transcript messages.
  pi.on("tool_execution_start", async (event, ctx) => {
    if (!enabled || !event.parentToolCallId) return;

    await Effect.runPromise(Effect.catch(append("tool", `${event.toolName} ${JSON.stringify(event.args)}`), error => Effect.sync(() => fail(error, ctx))));
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!enabled || !event.parentToolCallId) return;

    await Effect.runPromise(Effect.catch(append("echo", capText(recordedText(event.result?.content) || String(event.result ?? ""))), error => Effect.sync(() => fail(error, ctx))));
  });

  /** This hook owns the complete model transcript. The visible pi session is unchanged. */
  function compose(messages: AgentMessage[], ctx: ExtensionContext): Effect.Effect<ContextEventResult, OptChatError> {
    return Effect.gen(function* () {
      if (fatal) return yield* Effect.fail(fatal);
      const memory = driver;

      if (!memory) return yield* Effect.fail(new OptChatError({ message: "memory process is not running" }));
      // The current turn starts at the first user/custom message after the last final reply.
      const boundary = messages.findLastIndex(m => m.role === "assistant" && m.stopReason !== "toolUse");

      // After re-enabling, exclude private idle notes and unanswered messages too.
      if (resumed) floor = messages.findLastIndex(m => m.role === "user");
      resumed = false;
      const begin = messages.findIndex((m, i) => i >= floor && i > boundary && isText(m));

      if (begin >= 0 && (begin !== anchor || !prepared)) {
        anchor = begin;
        prepared = undefined;
        const fromPrompt = promptStarted;

        promptStarted = false;
        ctx.ui.setStatus("optchat", "OptChat: waiting for summaries…");
        // The waiting status is transient: restore the real one however the wait ends.
        const ready = yield* Effect.ensuring(attempt(() => memory.wait(ctx.signal)), Effect.sync(() => status(ctx)));

        if (!ready) {
          for (const text of unlogged(messages, Math.max(cursor, anchor), fromPrompt)) yield* append("user", text);
          cursor = messages.length;
          ctx.abort();

          return { messages: messages.filter(m => m.role === "system").slice(0, 1) };
        }

        const fresh = unlogged(messages, Math.max(cursor, anchor), fromPrompt);

        prepared = yield* read("context", active => fresh.length ? active.client.call<Prepared>("prepare", { texts: fresh }) : active.client.call<Prepared>("view"));
        memory.kick();
      } else {
        if (anchor < 0 || !prepared) return yield* Effect.fail(new OptChatError({ message: "no current turn in pi context; refusing to reuse old conversation" }));

        for (const text of unlogged(messages, cursor, false)) yield* append("user", text);
      }

      cursor = messages.length;
      const current = messages.slice(anchor).filter(m => m.role !== "system");
      const content = isText(current[0]) ? current[0].content : "";
      const user: UserMessage = { role: "user", timestamp: current[0].timestamp, content: [...prepared.blocks.map(b => ({ type: "text" as const, text: b.text })), ...(Array.isArray(content) ? content : [{ type: "text" as const, text: content }])] };
      const system = getCurrentSystemMessage(messages);

      systemPrompt ??= `${prompts.master}\n${prompts.view}\n${getCurrentSystemPrompt(messages)}`;
      const head: AgentMessage = { ...system, role: "system", content: systemPrompt, sections: undefined, timestamp: 0 };

      return { messages: [head, user, ...current.slice(1)] };
    });
  }

  pi.on("context_with_system", async (event, ctx) => {
    context = ctx;

    if (!enabled) return undefined;

    return Effect.runPromise(Effect.catch(compose(event.messages, ctx), error => Effect.sync(() => {
      fail(error, ctx);

      // Pi swallows handler exceptions. Abort explicitly and return no stale conversation.
      return { messages: event.messages.filter(m => m.role === "system").slice(0, 1) };
    })));
  });

  /** Texts delivered since `from` that are not in the log yet: extension messages always, and
   *  user messages only when a prompt started the turn (queued ones were logged at input). */
  function unlogged(messages: AgentMessage[], from: number, users: boolean): string[] {
    return messages.slice(from).filter(isText).flatMap(m => users || m.role === "custom" ? [recordedText(m.content)] : []);
  }

  pi.on("before_provider_request", (event, ctx) => enabled ? cachePayload(event.payload, prepared?.blocks ?? [], ctx.model) : undefined);

  pi.on("session_shutdown", async (_event, ctx) => {
    await Effect.runPromise(Effect.ensuring(
      Effect.suspend(() => {
        const memory = driver;

        return memory ? attempt(() => memory.close()) : Effect.void;
      }),
      Effect.sync(() => { driver = undefined; ctx.ui.setStatus("optchat", undefined); }),
    ));
  });

  pi.registerTool({
    name: "zoom", label: "Zoom",
    description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
    execute: async (_id, params) => {
      const text = await Effect.runPromise(read(`zoom ${params.id}+${params.n}`, memory => memory.client.call<string>("zoom", params)));

      return { content: [{ type: "text", text }], details: undefined };
    },
  });
  pi.registerTool({
    name: "date", label: "Date", description: "The date and time of message id.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    execute: async (_id, params) => {
      const text = await Effect.runPromise(read(`date ${params.id}`, memory => memory.client.call<string>("date", params)));

      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  /** Opt-in via `optchat.search`. Registered only once settings load, so without it the tool is neither declared nor callable. */
  function registerSearch(): void {
    if (searchRegistered) return;
    searchRegistered = true;
    const active = new Set(pi.getActiveTools());

    pi.registerTool({
      name: "memory_search", label: "Memory search",
      description: "Find original messages containing literal text (ASCII letters match case-insensitively; no regex). Returns JSON: up to 20 hits, newest first, each with id, date, kind, snippet, and covering, the view line id+n holding it (open it with zoom), or null. Pass next_before as before for older hits. include_tools also searches tool calls and results.",
      parameters: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 256 }),
        before: Type.Optional(Type.Integer({ minimum: 0 })),
        include_tools: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        // Absent optional fields are dropped by JSON serialization, so Rust applies its defaults.
        const payload = await Effect.runPromise(read("search", memory => memory.client.call<SearchPayload>("search", params)));

        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: undefined };
      },
    });
    // SDK refresh can reactivate allowlisted tools. Keep prior activation, admitting
    // memory_search only if the SDK activated it under the user's tool allowlist.
    pi.setActiveTools(pi.getActiveTools().filter(name => name === "memory_search" || active.has(name)));
  }
}

/** The Rust `status` op result (`Memory::status` in src/lib.rs). */
interface RpcStatus { messages: number; bytes: number; budget: number; busy: number; settled: boolean }

/** The Rust `search` op result. */
interface SearchPayload {
  hits: { id: number; date: string; kind: string; snippet: string; covering: { id: number; n: number } | null }[];
  next_before: number | null;
}

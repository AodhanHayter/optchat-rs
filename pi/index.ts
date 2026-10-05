import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getCurrentSystemPrompt, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MemoryDriver, cachePayload, textOf, type Prepared } from "./memory.ts";
import { capText } from "./transport.ts";
import { loadConfig } from "./config.ts";

export default function optchat(pi: ExtensionAPI): void {
  // pi-subagents children must not compete for the master's writer lock or log their tool loops.
  if (process.env.PI_SUBAGENT_CHILD) return;
  let driver: MemoryDriver | undefined;
  let context: ExtensionContext;
  let fatal: Error | undefined;
  let prompts = { master: "", view: "" };
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

  function status(ctx = context): void {
    const text = !enabled ? "OptChat: off" : fatal ? "OptChat: error" : reading ? `OptChat: reading memory · ${lastRead}` : `OptChat: on${reads ? ` · ${reads} reads · last: ${lastRead}` : ""}`;
    ctx.ui.setStatus("optchat", text);
  }

  async function read<T>(label: string, work: () => Promise<T>): Promise<T> {
    if (!enabled) throw new Error("OptChat is off. Use /optchat on to enable memory.");

    if (!driver) throw fatal ?? new Error("OptChat is not running");
    reads++; reading++; lastRead = label; status();

    try { return await work(); }
    finally { reading--; lastRead = label; status(); }
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    if (!driver) {
      config ??= loadConfig(ctx.cwd, ctx.isProjectTrusted());
      driver = new MemoryDriver(ctx, config.bin, config.dir, config.model, error => fail(error));
    }

    prompts = await driver.client.call("prompts");
    driver.kick();
  }

  pi.registerCommand("optchat", {
    description: "Show memory status, or enable/disable OptChat: /optchat [on|off]",
    handler: async (args, ctx) => {
      context = ctx;
      const action = args.trim();

      if (!action) {
        status();
        ctx.ui.notify(enabled ? "OptChat: on" : "OptChat: off", "info");

        return;
      }

      if (!["on", "off"].includes(action)) {
        ctx.ui.notify("Usage: /optchat [on|off]", "warning");

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

      try {
        if (enabled) {
          fatal = undefined;
          resumed = true;
          await start(ctx);
          ctx.ui.notify("OptChat: on. Messages from while it was off will not be saved to OptChat.", "info");
        } else {
          status();
          await driver?.close();
          driver = undefined;
          ctx.ui.notify("OptChat: off. Memory reads and writes are disabled. Pi still keeps its own session history.", "info");
        }
      } catch (error) { fail(error, ctx); }
      finally { switching = false; status(); }
    },
  });

  function fail(cause: unknown, ctx = context): void {
    fatal = cause instanceof Error ? cause : new Error(String(cause));
    status(ctx);
    ctx.ui.notify(`OptChat stopped: ${fatal.message}. Fix the cause and restart pi.`, "error");
    ctx.abort();
  }

  async function append(kind: string, text: string): Promise<void> {
    if (!driver) throw fatal ?? new Error("OptChat is not running");
    await driver.append(kind, text);
  }

  function isText(m: AgentMessage): m is AgentMessage & { role: "user" | "custom"; content: UserMessage["content"] } {
    return m.role === "user" || m.role === "custom";
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    anchor = -1; cursor = 0; floor = 0; prepared = undefined;

    try {
      if (enabled) await start(ctx);
      status(ctx);
    } catch (error) { fail(error, ctx); }
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
    if (event.streamingBehavior) {
      try { await append("user", event.text); }
      catch (error) {
        fail(error, ctx);

        return { action: "handled" };
      }
    }

    return { action: "continue" };
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

  pi.on("message_end", async (event, ctx) => {
    context = ctx;

    if (!enabled) return;

    if (fatal) {
      ctx.abort();

      return;
    }

    try {
      const message = event.message;

      if (message.role === "assistant") {
        if (message.stopReason === "error") return; // pi retries; the retry's reply is logged

        for (const block of message.content) {
          if (block.type === "text" && block.text) await append("talk", block.text);

          if (block.type === "toolCall") await append("tool", `${block.name} ${JSON.stringify(block.arguments)}`);
        }
      } else if (message.role === "toolResult") {
        const text = textOf(message.content);
        const capped = capText(text);
        await append("echo", capped);

        if (capped !== text && !["zoom", "date"].includes(message.toolName)) return { message: { ...message, content: [{ type: "text", text: capped }, ...message.content.filter(b => b.type !== "text")], structuredContent: undefined } };
      }
    } catch (error) { fail(error, ctx); }
  });

  // Nested calls (codemode, ctx.executeTool) never produce transcript messages.
  pi.on("tool_execution_start", async (event, ctx) => {
    if (!enabled || !event.parentToolCallId) return;

    try { await append("tool", `${event.toolName} ${JSON.stringify(event.args)}`); } catch (error) { fail(error, ctx); }
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!enabled || !event.parentToolCallId) return;

    try { await append("echo", capText(textOf(event.result?.content) || String(event.result ?? ""))); } catch (error) { fail(error, ctx); }
  });

  // This hook owns the complete model transcript. The visible pi session is unchanged.
  pi.on("context_with_system", async (event, ctx) => {
    context = ctx;

    if (!enabled) return;

    try {
      if (fatal) throw fatal;

      if (!driver) throw new Error("memory process is not running");
      const messages = event.messages;
      // The current turn starts at the first user/custom message after the last final reply.
      const boundary = messages.findLastIndex(m => m.role === "assistant" && m.stopReason !== "toolUse");

      // After re-enabling, exclude private idle notes and unanswered messages too.
      if (resumed) floor = messages.findLastIndex(m => m.role === "user");
      resumed = false;
      const start = messages.findIndex((m, i) => i >= floor && i > boundary && isText(m));

      if (start >= 0 && (start !== anchor || !prepared)) {
        anchor = start;
        prepared = undefined;
        const fromPrompt = promptStarted;
        promptStarted = false;
        ctx.ui.setStatus("optchat", "OptChat: waiting for summaries…");
        const ready = await driver.wait(ctx.signal);
        status(ctx);

        if (!ready) {
          for (const text of unlogged(messages, Math.max(cursor, anchor), fromPrompt)) await append("user", text);
          cursor = messages.length;
          ctx.abort();

          return { messages: messages.filter(m => m.role === "system").slice(0, 1) };
        }

        const fresh = unlogged(messages, Math.max(cursor, anchor), fromPrompt);
        prepared = await read("context", () => fresh.length ? driver!.client.call<Prepared>("prepare", { texts: fresh }) : driver!.client.call<Prepared>("view"));
        driver.kick();
      } else {
        if (anchor < 0 || !prepared) throw new Error("no current turn in pi context; refusing to reuse old conversation");

        for (const text of unlogged(messages, cursor, false)) await append("user", text);
      }

      cursor = messages.length;
      const current = messages.slice(anchor).filter(m => m.role !== "system");
      const content = isText(current[0]) ? current[0].content : "";
      const user: UserMessage = { role: "user", timestamp: current[0].timestamp, content: [...prepared.blocks.map(b => ({ type: "text" as const, text: b.text })), ...(Array.isArray(content) ? content : [{ type: "text" as const, text: content }])] };
      const system = getCurrentSystemMessage(messages);
      systemPrompt ??= `${prompts.master}\n${prompts.view}\n${getCurrentSystemPrompt(messages)}`;

      return { messages: [{ ...system, role: "system", content: systemPrompt, sections: undefined, timestamp: 0 }, user, ...current.slice(1)] };
    } catch (error) {
      fail(error, ctx);

      // Pi swallows handler exceptions. Abort explicitly and return no stale conversation.
      return { messages: event.messages.filter(m => m.role === "system").slice(0, 1) };
    }
  });

  /** Texts delivered since `from` that are not in the log yet: extension messages always, and
   *  user messages only when a prompt started the turn (queued ones were logged at input). */
  function unlogged(messages: AgentMessage[], from: number, users: boolean): string[] {
    return messages.slice(from).filter(isText).flatMap(m => users || m.role === "custom" ? [textOf(m.content)] : []);
  }

  pi.on("before_provider_request", (event, ctx) => enabled ? cachePayload(event.payload, prepared?.blocks ?? [], ctx.model) : undefined);

  pi.on("session_shutdown", async (_event, ctx) => {
    try { await driver?.close(); } finally { driver = undefined; ctx.ui.setStatus("optchat", undefined); }
  });

  pi.registerTool({
    name: "zoom", label: "Zoom",
    description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
    execute: async (_id, params) => {
      const text = await read(`zoom ${params.id}+${params.n}`, () => driver!.client.call<string>("zoom", params));

      return { content: [{ type: "text", text }], details: undefined };
    },
  });
  pi.registerTool({
    name: "date", label: "Date", description: "The date and time of message id.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    execute: async (_id, params) => {
      const text = await read(`date ${params.id}`, () => driver!.client.call<string>("date", params));

      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}

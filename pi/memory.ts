import type { AssistantMessage, Message, Model, Api, TextContent, ImageContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OptChatClient } from "./transport.ts";

export interface Block { type: "text"; text: string; cache_control?: { type: "ephemeral" } }

/** The parts of pi's ExtensionContext the driver uses. */
export interface DriverContext { ui: Pick<ExtensionContext["ui"], "notify">; modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "streamSimple"> }

/** Rust `Job`: the first message always carries the cache blocks; retries append plain text. */
interface Job { l: number; i: number; system: string; messages: [{ role: "user"; content: Block[] }, ...{ role: string; content: string | Block[] }[]] }

export interface Prepared { view: string; blocks: Block[]; text: string; ids: number[] }

/** Spec §8 request layout: at most three view marks plus the request-end mark. */
export function cachePayload(payload: any, blocks: Block[], model: Pick<Model<Api>, "api" | "compat"> | undefined): any {
  if (!payload || !model) return payload;

  if (model.api === "openai-responses") {
    const compat = model.compat;

    if (!compat || !("supportsExplicitPromptCacheMode" in compat) || !compat.supportsExplicitPromptCacheMode || !Array.isArray(payload.input)) return payload;
    const texts = new Set(blocks.flatMap(b => b.cache_control ? [b.text] : []));

    for (const item of payload.input) {
      if (!Array.isArray(item?.content)) continue;

      for (const block of item.content) {
        if (block.type === "input_text" && texts.delete(block.text)) block.prompt_cache_breakpoint = { mode: "explicit" };
      }
    }

    if (payload.reasoning) payload.reasoning.context = "all_turns";

    return payload;
  }

  if (model.api !== "anthropic-messages" || !Array.isArray(payload.messages)) return payload;
  delete payload.cache_control;

  for (const blocks of [payload.system, payload.tools, ...payload.messages.map((m: any) => m.content)]) {
    if (Array.isArray(blocks)) for (const block of blocks) delete block.cache_control;
  }

  const texts = new Set(blocks.flatMap(b => b.cache_control ? [b.text] : []));
  let marks = 0;

  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (marks < 3 && block.type === "text" && texts.has(block.text)) {
        block.cache_control = { type: "ephemeral" };
        texts.delete(block.text);
        marks++;
      }
    }
  }

  payload.cache_control = { type: "ephemeral" };

  return payload;
}

export function textOf(content: string | (TextContent | ImageContent | ThinkingContent | ToolCall)[]): string {
  return Array.isArray(content) ? content.flatMap(b => b.type === "text" ? [b.text] : []).join("") : content;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Aborted"));

    if (signal.aborted) {
      void work.catch(() => {});
      abort();

      return;
    }

    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class MemoryDriver {
  readonly client: OptChatClient;
  private lifetime = new AbortController();
  private listeners = new Set<() => void>();
  private revision = 0;
  private pumping = false;
  private again = false;
  private active = new Set<Promise<void>>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private reported = new Set<string>();
  error?: Error;

  private ctx: DriverContext;
  private modelName: string;
  private onFatal: (error: Error) => void;
  constructor(ctx: DriverContext, bin: string, dir: string, modelName: string, onFatal: (error: Error) => void) {
    this.ctx = ctx;
    this.modelName = modelName;
    this.onFatal = onFatal;
    this.client = new OptChatClient(bin, ["--dir", dir, "serve"]);
    this.client.onStderr = line => console.error(`optchat: ${line}`);
    this.client.onExit = error => this.fail(error);
  }

  private changed(): void {
    this.revision++;

    for (const fn of this.listeners) fn();
  }
  private fail(error: Error): void {
    if (this.lifetime.signal.aborted || this.error) return;
    this.error = error;
    this.lifetime.abort(error);

    for (const timer of this.timers) clearTimeout(timer);
    this.changed();
    this.onFatal(error);
  }

  async append(kind: string, text: string): Promise<void> {
    if (this.error) throw this.error;
    await this.client.call("append", { kind, text });
    this.changed();
    this.kick();
  }

  kick(): void {
    if (this.error || this.lifetime.signal.aborted) return;

    if (this.pumping) {
      this.again = true;

      return;
    }

    this.pumping = true;
    void (async () => {
      try {
        const jobs = await this.client.call<Job[]>("jobs");

        for (const job of jobs) {
          const task = this.run(job).finally(() => { this.active.delete(task); this.changed(); this.kick(); });
          this.active.add(task);
        }
      } catch (error) {
        // SAFETY: OptChatClient.call rejects only with Error instances.
        this.fail(error as Error);
      }
      finally {
        this.pumping = false;
        this.changed();

        if (this.again) { this.again = false; this.kick(); }
      }
    })();
  }

  private async run(job: Job): Promise<void> {
    const key = `${job.l}:${job.i}`;

    try {
      const slash = this.modelName.indexOf("/");
      const model = this.ctx.modelRegistry.find(this.modelName.slice(0, slash), this.modelName.slice(slash + 1));

      if (!model || slash < 1) throw new Error(`compactor model unavailable: ${this.modelName}; set OPTCHAT_MODEL=provider/model-id`);
      const blocks = job.messages[0].content;
      const native: Message[] = [{ role: "user", content: blocks.map(b => ({ type: "text", text: b.text })), timestamp: 0 }];

      for (;;) {
        const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120_000)]);

        const reply: AssistantMessage = await abortable(this.ctx.modelRegistry.streamSimple(model, { systemPrompt: job.system, messages: native }, {
          reasoning: "medium", cacheRetention: "short", signal, timeoutMs: 120_000, maxRetries: 0,
          onPayload: payload => cachePayload(payload, blocks, model),
        }).result(), signal);

        if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
        const text = textOf(reply.content);

        // Avoid calling submit with an empty reply: the failure path owns the cooldown.
        if (!text.trim()) throw new Error("compactor returned empty text");
        let result: { retry: Job | null };

        try { result = await this.client.call("submit", { l: job.l, i: job.i, text }); }
        catch (error) {
          // SAFETY: OptChatClient.call rejects only with Error instances.
          this.fail(error as Error);

          return;
        }

        if (!result.retry) {
          this.reported.delete(key);

          return;
        }

        native.push(reply, { role: "user", content: result.retry.messages.at(-1)!.content, timestamp: 0 });
      }
    } catch (error) {
      if (this.lifetime.signal.aborted) return;

      if (!this.reported.has(key)) {
        this.reported.add(key);
        this.ctx.ui.notify(`OptChat summary ${key}: ${String(error)}. Retrying in 10 seconds.`, "warning");
      }

      try { await this.client.call("fail", { l: job.l, i: job.i }); }
      catch (failure) {
        // SAFETY: OptChatClient.call rejects only with Error instances.
        this.fail(failure as Error);

        return;
      }

      const timer = setTimeout(() => { this.timers.delete(timer); this.kick(); }, 10_010);
      this.timers.add(timer);
    }
  }

  async wait(signal?: AbortSignal): Promise<boolean> {
    this.kick();

    for (;;) {
      if (signal?.aborted) return false;

      if (this.error) throw this.error;
      const revision = this.revision;
      const status = await this.client.call<{ settled: boolean }>("status");

      if (status.settled) return !signal?.aborted;
      await new Promise<void>(resolve => {
        const finish = () => { this.listeners.delete(finish); signal?.removeEventListener("abort", finish); resolve(); };

        this.listeners.add(finish);
        signal?.addEventListener("abort", finish, { once: true });

        if (this.revision !== revision || signal?.aborted || this.error || this.lifetime.signal.aborted) finish();
      });

      if (this.lifetime.signal.aborted) return false;
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();

    for (const timer of this.timers) clearTimeout(timer);
    this.changed();
    await this.client.dispose();
    await Promise.allSettled(this.active);
  }
}

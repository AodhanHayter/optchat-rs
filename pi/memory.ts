import type { AssistantMessage, Message, Model, Api, TextContent, ImageContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Data, Deferred, Duration, Effect, Exit, Fiber, Scope } from "effect";
import { randomUUID } from "node:crypto";
import { OptChatClient, type TransportError } from "./transport.ts";
import { UsageLedger, formatUsage, measured, replyOutcome, type Outcome } from "./usage.ts";

export interface Block { type: "text"; text: string; cache_control?: { type: "ephemeral" } }

/** The parts of pi's ExtensionContext the driver uses. */
export interface DriverContext {
  /** Pi's print mode has no UI and a silent notify; warnings then also go to stderr. */
  hasUI?: ExtensionContext["hasUI"];
  ui: Pick<ExtensionContext["ui"], "notify">;
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "streamSimple">;
}

/** Rust `Job`: the first message always carries the cache blocks; retries append plain text. */
interface Job { l: number; i: number; system: string; messages: [{ role: "user"; content: Block[] }, ...{ role: string; content: string | Block[] }[]] }

export interface Prepared { view: string; blocks: Block[]; text: string; ids: number[] }

/** One failed compactor attempt. The Rust queue holds the job; the driver stays healthy. */
export class CompactionError extends Data.TaggedError("CompactionError")<{ cause: Error }> {}

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

export const imageNotice = "[Image attachment: retained in the Pi session; image bytes are not stored in OptChat memory.]";

/** The text OptChat stores for content: `textOf`, then one notice line per image. Provider content is never changed. */
export function recordedText(content: string | (TextContent | ImageContent | ThinkingContent | ToolCall)[]): string {
  const text = textOf(content);
  const images = Array.isArray(content) ? content.filter(b => b.type === "image").length : 0;

  return images ? [...(text ? [text] : []), ...Array.from({ length: images }, () => imageNotice)].join("\n") : text;
}

/** Bridges a caller's AbortSignal, which pi owns, into the fiber that waits on it. */
function aborted(signal: AbortSignal | undefined): Effect.Effect<void> {
  if (!signal) return Effect.never;

  return Effect.callback<void>(resume => {
    if (signal.aborted) {
      resume(Effect.void);

      return;
    }

    const wake = () => resume(Effect.void);

    signal.addEventListener("abort", wake, { once: true });

    return Effect.sync(() => signal.removeEventListener("abort", wake));
  });
}

function asError(cause: unknown): Error {
  // SAFETY: an Error stays itself; anything else is described by its own string form.
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Live driver state for status: provider attempts in flight, and jobs waiting out a failure cooldown. */
export interface DriverDiagnostics { activeJobs: number; retryingJobs: number }

/** One provider invocation; `done` makes a late provider callback a no-op once the attempt is recorded. */
interface AttemptState { id: string; at: string; start: number; outcome: Outcome; done: boolean }

export class MemoryDriver {
  readonly client: OptChatClient;
  /** Every background fiber lives here, so one close interrupts provider work and retry waits. */
  private readonly scope = Scope.makeUnsafe("parallel");
  private readonly reported = new Set<string>();
  /** Failure cooldowns per job key since its last accepted summary; recorded as each attempt's retry number. */
  private readonly failures = new Map<string, number>();
  private readonly ledger: UsageLedger;
  private readonly sessionId: string;
  private activeAttempts = 0;
  private coolingJobs = 0;
  /** Replaced and completed on every state change, so a waiter never misses one it did not see. */
  private revision = Deferred.makeUnsafe<void>();
  private pumping = false;
  private again = false;
  private stopped = false;
  private closing?: Promise<void>;
  error?: Error;

  private ctx: DriverContext;
  private modelName: string;
  private onFatal: (error: Error) => void;
  constructor(ctx: DriverContext, bin: string, dir: string, modelName: string, onFatal: (error: Error) => void, sessionId?: string) {
    this.ctx = ctx;
    this.modelName = modelName;
    this.onFatal = onFatal;
    this.sessionId = sessionId || randomUUID();
    this.ledger = new UsageLedger(dir, message => {
      try { this.ctx.ui.notify(message, "warning"); } catch {
        console.error(message);

        return;
      }

      if (this.ctx.hasUI === false) console.error(message);
    });
    this.client = new OptChatClient(bin, ["--dir", dir, "serve"]);
    this.client.onStderr = line => console.error(`optchat: ${line}`);
    this.client.onExit = error => this.fail(error);
  }

  private changed(): void {
    const previous = this.revision;

    this.revision = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  }

  private fail(error: Error): void {
    // The process and its writer lock are gone, even mid-close; unwritten telemetry must not be written unlocked.
    this.ledger.revoke();

    if (this.stopped) return;
    this.stopped = true;
    this.error = error;
    this.changed();
    this.onFatal(error);
    // Detached on purpose: this also runs from the fiber being interrupted, and from Node callbacks.
    Effect.runFork(Scope.close(this.scope, Exit.void));
  }

  private fork(work: Effect.Effect<void>): void {
    Fiber.runIn(Effect.runFork(work), this.scope);
  }

  append(kind: string, text: string): Promise<void> {
    return Effect.runPromise(this.appendEntry(kind, text));
  }

  private appendEntry(kind: string, text: string): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      if (this.error) return Effect.fail(this.error);

      return this.client.request("append", { kind, text }).pipe(Effect.flatMap(() => Effect.sync(() => {
        this.changed();
        this.kick();
      })));
    });
  }

  kick(): void {
    if (this.stopped) return;

    if (this.pumping) {
      this.again = true;

      return;
    }

    this.pumping = true;
    this.fork(this.pump());
  }

  /** Single-flight: one `jobs` call at a time, with one trailing run for the kicks it overlapped. */
  private pump(): Effect.Effect<void> {
    return this.client.request<Job[]>("jobs").pipe(
      Effect.flatMap(jobs => Effect.sync(() => {
        for (const job of jobs) this.fork(this.runJob(job));
      })),
      Effect.catchTag("TransportError", error => Effect.sync(() => this.fail(error))),
      Effect.ensuring(Effect.sync(() => {
        this.pumping = false;
        this.changed();

        if (this.again) {
          this.again = false;
          this.kick();
        }
      })),
    );
  }

  private runJob(job: Job): Effect.Effect<void> {
    return this.compact(job).pipe(
      Effect.catchTag("CompactionError", failure => this.cooldown(job, failure)),
      Effect.catchTag("TransportError", error => Effect.sync(() => this.fail(error))),
      Effect.ensuring(Effect.sync(() => {
        this.changed();
        this.kick();
      })),
    );
  }

  /** The corrective dialogue: Rust answers `submit` with the next retry turn until it accepts one. */
  private compact(job: Job): Effect.Effect<void, CompactionError | TransportError> {
    return Effect.gen({ self: this }, function* () {
      const slash = this.modelName.indexOf("/");
      const model = this.ctx.modelRegistry.find(this.modelName.slice(0, slash), this.modelName.slice(slash + 1));

      if (!model || slash < 1) return yield* new CompactionError({ cause: new Error(`compactor model unavailable: ${this.modelName}; set OPTCHAT_MODEL=provider/model-id`) });
      const blocks = job.messages[0].content;
      const native: Message[] = [{ role: "user", content: blocks.map(b => ({ type: "text", text: b.text })), timestamp: 0 }];

      for (let attempt = 1; ; attempt++) {
        const reply = yield* this.stream(job, model, blocks, native, attempt);

        const text = yield* Effect.try({
          try: () => {
            if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
            const text = textOf(reply.content);

            // Malformed and empty replies must release the job through the failure cooldown.
            if (!text.trim()) throw new Error("compactor returned empty text");

            return text;
          },
          catch: cause => new CompactionError({ cause: asError(cause) }),
        });

        const result = yield* this.client.request<{ retry: Job | null }>("submit", { l: job.l, i: job.i, text });

        if (!result.retry) {
          this.reported.delete(`${job.l}:${job.i}`);
          this.failures.delete(`${job.l}:${job.i}`);

          return;
        }

        native.push(reply, { role: "user", content: result.retry.messages.at(-1)!.content, timestamp: 0 });
      }
    });
  }

  /**
   * The fiber's own signal aborts the provider call on interruption, so close cancels it at once.
   * Every invocation records exactly one ledger attempt in its release, whichever way it ends.
   */
  private stream(job: Job, model: Model<Api>, blocks: Block[], messages: Message[], attempt: number): Effect.Effect<AssistantMessage, CompactionError> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        this.activeAttempts++;
        // Interruption is the only way out that sets no outcome of its own.
        const state: AttemptState = { id: randomUUID(), at: new Date().toISOString(), start: performance.now(), outcome: "cancelled", done: false };

        return state;
      }),
      state => Effect.callback<AssistantMessage, CompactionError>((resume, signal) => {
        const failed = (outcome: Outcome) => (cause: unknown) => {
          // A late rejection after cancellation or timeout belongs to the attempt already recorded.
          if (state.done) return;
          state.outcome = outcome;
          resume(Effect.fail(new CompactionError({ cause: asError(cause) })));
        };

        try {
          this.ctx.modelRegistry.streamSimple(model, { systemPrompt: job.system, messages }, {
            reasoning: "medium", cacheRetention: "short", signal, timeoutMs: 120_000, maxRetries: 0,
            onPayload: payload => cachePayload(payload, blocks, model),
          }).result().then(reply => resume(Effect.succeed(reply)), failed("rejected"));
        } catch (error) { failed("threw")(error); }
      }).pipe(
        Effect.timeout(Duration.seconds(120)),
        Effect.catchTag("TimeoutError", error => Effect.suspend(() => {
          state.outcome = "timeout";

          return Effect.fail(new CompactionError({ cause: error }));
        })),
      ),
      (state, exit) => Effect.sync(() => {
        state.done = true;
        this.activeAttempts--;
        const reply = Exit.isSuccess(exit) ? exit.value : undefined;
        const outcome = Exit.isSuccess(exit) ? replyOutcome(reply) : state.outcome;

        this.ledger.record({
          v: 1, id: state.id, session: this.sessionId, provider: model.provider || "unknown", model: model.id || "unknown",
          l: job.l, i: job.i, attempt, retry: this.failures.get(`${job.l}:${job.i}`) ?? 0, outcome,
          at: state.at, ms: Math.max(0, Math.round(performance.now() - state.start)), ...measured(reply, model, outcome),
        });
      }),
    );
  }

  /** Reports once per job, releases it in Rust, then holds the fiber for the queue's own cooldown. */
  private cooldown(job: Job, failure: CompactionError): Effect.Effect<void, TransportError> {
    return Effect.suspend(() => {
      const key = `${job.l}:${job.i}`;

      if (!this.reported.has(key)) {
        this.reported.add(key);
        this.ctx.ui.notify(`OptChat summary ${key}: ${String(failure.cause)}. Retrying in 10 seconds.`, "warning");
      }

      this.failures.set(key, (this.failures.get(key) ?? 0) + 1);

      return Effect.acquireUseRelease(
        Effect.sync(() => { this.coolingJobs++; }),
        () => this.client.request("fail", { l: job.l, i: job.i }).pipe(
          Effect.flatMap(() => Effect.sync(() => {
            this.changed();
            this.kick();
          })),
          Effect.flatMap(() => Effect.sleep(Duration.millis(10_010))),
        ),
        () => Effect.sync(() => { this.coolingJobs--; }),
      );
    });
  }

  diagnostics(): DriverDiagnostics {
    return { activeJobs: this.activeAttempts, retryingJobs: this.coolingJobs };
  }

  /** Historical compactor totals for this store. Reads only the private ledger; never calls a provider. */
  async usage(): Promise<string> {
    if (this.stopped) throw this.error ?? new Error("optchat process is not running");
    // A reply proves this driver's process holds the store's writer lock before the ledger is touched.
    await this.client.call("status");

    // Close may have begun while status was in flight; its ledger drain must be the last ledger work.
    if (this.stopped) throw this.error ?? new Error("optchat process is not running");

    return formatUsage(await this.ledger.read(), this.ledger.unrecorded);
  }

  wait(signal?: AbortSignal): Promise<boolean> {
    return Effect.runPromise(this.settled(signal));
  }

  private settled(signal: AbortSignal | undefined): Effect.Effect<boolean, Error> {
    return Effect.gen({ self: this }, function* () {
      this.kick();

      for (;;) {
        if (signal?.aborted) return false;

        if (this.error) return yield* Effect.fail(this.error);
        // Read the revision first: a change between here and the await still wakes this fiber.
        const revision = this.revision;
        const status = yield* this.client.request<{ settled: boolean }>("status");

        if (status.settled) return !signal?.aborted;
        yield* Effect.race(Deferred.await(revision), aborted(signal));

        if (this.stopped) return false;
      }
    });
  }

  close(): Promise<void> {
    return this.closing ??= Effect.runPromise(this.shutdown());
  }

  private shutdown(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.stopped = true;
      this.changed();

      // Interrupt provider work and retry waits first; stdin still carries every durable write.
      // Their telemetry drains while the Rust writer lock is still held; the ledger never rejects.
      return Scope.close(this.scope, Exit.void).pipe(
        Effect.flatMap(() => Effect.promise(() => this.ledger.close())),
        Effect.flatMap(() => Effect.sync(() => {
          this.activeAttempts = 0;
          this.coolingJobs = 0;
        })),
        Effect.flatMap(() => Effect.promise(() => this.client.dispose())),
      );
    });
  }
}

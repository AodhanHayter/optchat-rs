import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Data, Deferred, Duration, Effect } from "effect";

/** Every failure of the optchat process boundary. One is fatal: the process is gone for good. */
export class TransportError extends Data.TaggedError("TransportError")<{ message: string }> {}

/** The envelope `serve` writes back for every request line; `result` is the op's own JSON. */
interface Reply { request_id: number; ok: boolean; result: any; error: string }

/** One locked Rust process. Node's writable stream preserves complete JSON-line order. */
export class OptChatClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Deferred.Deferred<any, TransportError>>();
  /** Ids of interrupted calls: the server still owes a reply, so a late one is not a protocol breach. */
  private readonly abandoned = new Set<number>();
  private readonly exited = Deferred.makeUnsafe<void>();
  private nextId = 1;
  private closed = false;
  private disposal?: Promise<void>;
  onStderr?: (line: string) => void;
  onExit?: (error: TransportError) => void;

  constructor(bin: string, args: string[]) {
    this.proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.once("close", () => { Deferred.doneUnsafe(this.exited, Effect.void); });
    createInterface({ input: this.proc.stdout }).on("line", line => this.receive(line));
    createInterface({ input: this.proc.stderr }).on("line", line => this.onStderr?.(line));
    this.proc.on("error", error => this.failUnsafe(new TransportError({ message: error.message })));
    this.proc.stdin.on("error", error => this.failUnsafe(new TransportError({ message: error.message })));
    this.proc.on("close", code => this.failUnsafe(new TransportError({ message: `optchat exited (${code})` })));
  }

  private receive(line: string): void {
    let reply: Reply;

    try { reply = JSON.parse(line); }
    catch (error) {
      // SAFETY: JSON.parse throws only SyntaxError, which is an Error.
      this.failUnsafe(new TransportError({ message: (error as Error).message }));

      return;
    }

    if (!reply) {
      this.failUnsafe(new TransportError({ message: "unexpected optchat response" }));

      return;
    }

    const waiter = this.pending.get(reply.request_id);

    if (!waiter) {
      // Only an id this client never issued means the pipe is not answering our protocol.
      if (!this.abandoned.delete(reply.request_id)) this.failUnsafe(new TransportError({ message: "unexpected optchat response" }));

      return;
    }

    this.pending.delete(reply.request_id);
    Deferred.doneUnsafe(waiter, reply.ok ? Effect.succeed(reply.result) : Effect.fail(new TransportError({ message: reply.error })));
  }

  /** Runs from Node callbacks, so it completes the waiters directly instead of forking a fiber. */
  private failUnsafe(error: TransportError): void {
    if (this.closed) return;
    this.closed = true;

    for (const waiter of this.pending.values()) Deferred.doneUnsafe(waiter, Effect.fail(error));
    this.pending.clear();
    this.abandoned.clear();
    this.proc.kill();
    this.onExit?.(error);
  }

  /** The native form: interrupting the caller abandons the reply without failing the process. */
  request<T = any>(op: string, fields: Record<string, number | string | string[]> = {}): Effect.Effect<T, TransportError> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.fail(new TransportError({ message: "optchat process is not running" }));
      const id = this.nextId++;
      const waiter = Deferred.makeUnsafe<T, TransportError>();

      this.pending.set(id, waiter);
      this.proc.stdin.write(`${JSON.stringify({ ...fields, op, request_id: id })}\n`, error => {
        if (error) this.failUnsafe(new TransportError({ message: error.message }));
      });

      return Deferred.await(waiter).pipe(Effect.onInterrupt(() => Effect.sync(() => {
        if (this.pending.delete(id)) this.abandoned.add(id);
      })));
    });
  }

  call<T = any>(op: string, fields: Record<string, number | string | string[]> = {}): Promise<T> {
    return Effect.runPromise(this.request<T>(op, fields));
  }

  dispose(): Promise<void> {
    this.onExit = undefined;

    return this.disposal ??= Effect.runPromise(this.shutdown());
  }

  private shutdown(): Effect.Effect<void> {
    return Effect.suspend(() => {
      // Closing stdin lets the server finish its current fsync and exit without a torn tail.
      this.proc.stdin.end();

      return Deferred.await(this.exited).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
        Effect.flatMap(() => {
          this.failUnsafe(new TransportError({ message: "optchat closed" }));

          return Deferred.await(this.exited);
        }),
      );
    });
  }
}

export const CAP = 30_000;

export function capText(text: string): string {
  const chars = Array.from(text);

  if (chars.length <= CAP) return text;
  const keep = CAP - 80;
  const head = Math.floor(keep / 2);
  const tail = keep - head;

  return `${chars.slice(0, head).join("")}\n[... ${chars.length - keep} characters omitted ...]\n${chars.slice(chars.length - tail).join("")}`;
}

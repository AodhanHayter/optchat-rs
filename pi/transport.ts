import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** One locked Rust process. Node's writable stream preserves complete JSON-line order. */
export class OptChatClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private closed = false;
  private exited: Promise<void>;
  onStderr?: (line: string) => void;
  onExit?: (error: Error) => void;

  constructor(bin: string, args: string[]) {
    this.proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise(resolve => this.proc.once("close", () => resolve()));
    createInterface({ input: this.proc.stdout }).on("line", line => {
      try {
        const reply = JSON.parse(line);
        const waiter = this.pending.get(reply.request_id);

        if (!waiter) throw new Error("unexpected optchat response");
        this.pending.delete(reply.request_id);

        if (reply.ok) waiter.resolve(reply.result);
        else waiter.reject(new Error(reply.error));
      } catch (error) {
        // SAFETY: JSON.parse and this block throw only Error instances.
        this.fail(error as Error);
      }
    });
    createInterface({ input: this.proc.stderr }).on("line", line => this.onStderr?.(line));
    this.proc.on("error", error => this.fail(error));
    this.proc.stdin.on("error", error => this.fail(error));
    this.proc.on("close", code => this.fail(new Error(`optchat exited (${code})`)));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;

    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.proc.kill();
    this.onExit?.(error);
  }

  call<T = any>(op: string, fields: Record<string, number | string | string[]> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("optchat process is not running"));
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ ...fields, op, request_id: id })}\n`, error => {
        if (error) this.fail(error);
      });
    });
  }

  async dispose(): Promise<void> {
    this.onExit = undefined;
    // Closing stdin lets the server finish its current fsync and exit without a torn tail.
    this.proc.stdin.end();
    await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
    this.fail(new Error("optchat closed"));
    await this.exited;
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

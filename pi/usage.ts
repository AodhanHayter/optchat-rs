import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, ModelCostRates } from "@earendil-works/pi-ai";
import { Option, Schema } from "effect";

/** The compactor ledger's file name inside the store directory, beside but outside `main` and `tree`. */
export const LEDGER_FILE = "compactor-usage.jsonl";

/** How one provider attempt ended. Bounded so the ledger never carries provider error text. */
export const OUTCOMES = ["ok", "empty", "error", "aborted", "threw", "rejected", "timeout", "cancelled"] as const;

export type Outcome = typeof OUTCOMES[number];

const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Name = Schema.String.check(Schema.isNonEmpty());

const Tokens = Schema.Struct({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count });

/** One provider attempt. No prompt, reply, or error text: only identity, timing, and counts. */
const AttemptRecord = Schema.Struct({
  v: Schema.Literal(1),
  id: Name,
  session: Name,
  provider: Name,
  model: Name,
  l: Index,
  i: Index,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  retry: Index,
  outcome: Schema.Literals(OUTCOMES),
  at: Name,
  ms: Count,
  tokens: Schema.NullOr(Tokens),
  cost: Schema.NullOr(Count),
});

export type AttemptRecord = typeof AttemptRecord.Type;

export type TokenCounts = typeof Tokens.Type;

const decodeRecord = Schema.decodeUnknownOption(AttemptRecord);

/** What a provider reply claims about usage, validated before any of it is trusted or stored; cost apart from tokens. */
const decodeTokens = Schema.decodeUnknownOption(Tokens);

const decodeTotal = Schema.decodeUnknownOption(Schema.Struct({ total: Count }));

const decodeText = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));

/** One attempt's tokens and estimated cost; null means unknown, never zero. */
export interface Measurement { tokens: TokenCounts | null; cost: number | null }

/** Outcome of a reply the provider did return; the driver's own acceptance check reads the same fields. */
export function replyOutcome(reply: AssistantMessage | undefined): Outcome {
  if (reply?.stopReason === "error") return "error";

  if (reply?.stopReason === "aborted") return "aborted";
  const content: unknown[] = Array.isArray(reply?.content) ? reply.content : [];

  return content.flatMap(block => Option.toArray(decodeText(block))).some(block => block.text.trim()) ? "ok" : "empty";
}

function rates(values: number[]): boolean {
  return values.every(n => Number.isFinite(n) && n >= 0);
}

/** pi-ai's `calculateCost` tariff: the highest tier whose threshold this request's input exceeds, else the base. */
function tariff(cost: Model<Api>["cost"], input: number): ModelCostRates {
  let applied: ModelCostRates = cost;
  let threshold = -1;

  for (const tier of cost.tiers ?? []) {
    if (input > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      applied = tier;
      threshold = tier.inputTokensAbove;
    }
  }

  return applied;
}

/**
 * Token counts when the reply reports any, and the catalog cost only when it can be trusted.
 * All-zero usage is the SDK's default fill, not a measurement; an all-zero applicable tariff is not proof of free service.
 * The SDK prices with the requested model, so a different served `responseModel` makes the cost unknown.
 * Error and abort replies keep their partial tokens but never claim a cost.
 */
export function measured(reply: AssistantMessage | undefined, model: Pick<Model<Api>, "provider" | "id" | "cost">, outcome: Outcome): Measurement {
  const usage = Option.getOrUndefined(decodeTokens(reply?.usage));

  if (!reply || !usage || usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return { tokens: null, cost: null };
  const tokens = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
  const total = Option.getOrUndefined(decodeTotal(reply.usage.cost))?.total;
  const cost = model.cost;
  const tiers = cost?.tiers ?? [];

  if (total === undefined || !cost || !(outcome === "ok" || outcome === "empty")) return { tokens, cost: null };

  if (reply.provider !== model.provider || reply.model !== model.id || (reply.responseModel && reply.responseModel !== model.id)) return { tokens, cost: null };

  if (!rates([cost.input, cost.output, cost.cacheRead, cost.cacheWrite]) || !tiers.every(t => rates([t.input, t.output, t.cacheRead, t.cacheWrite, t.inputTokensAbove]))) return { tokens, cost: null };
  const applied = tariff(cost, tokens.input + tokens.cacheRead + tokens.cacheWrite);

  return { tokens, cost: [applied.input, applied.output, applied.cacheRead, applied.cacheWrite].some(n => n > 0) ? total : null };
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

/** The store no longer belongs to this driver, so its ledger must not be touched again. */
export class LedgerRevoked extends Error {
  constructor() { super("usage ledger: this driver no longer owns the store; optchat process is not running"); }
}

/**
 * Opens our own private ledger file, never a link, FIFO, or anything else. A missing file is created exclusively.
 * Platforms without O_NOFOLLOW (Windows) may follow a link on open; nothing is written before the opened file
 * and the path's own lstat are proved to be the same single-link regular file, and an ambiguous identity fails closed.
 * `owned` is checked before each step, so a revoked store is never created or opened.
 */
async function openLedger(path: string, write: boolean, owned: () => void): Promise<{ handle: FileHandle; size: number; mode: number }> {
  const flags = (write ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) | O_NOFOLLOW | O_NONBLOCK;
  let handle: FileHandle;

  owned();

  try { handle = await open(path, flags); } catch (error: any) {
    if (!write || error?.code !== "ENOENT") throw error;
    // A dangling link reads as missing where open follows links; refuse it rather than create its target.
    const existing = await lstat(path).then(() => true, (missing: any) => missing?.code === "ENOENT" ? false : Promise.reject(missing));

    if (existing) throw new Error(`${path} is not a regular file`);
    owned();
    handle = await open(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
  }

  try {
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });

    if (!opened.isFile() || !named.isFile()) throw new Error(`${path} is not a regular file`);

    if (opened.ino === 0n || opened.ino !== named.ino || opened.dev !== named.dev) throw new Error(`${path} is not the file that was opened`);

    if (opened.nlink !== 1n) throw new Error(`${path} has other hard links`);

    if (process.getuid && opened.uid !== BigInt(process.getuid())) throw new Error(`${path} is owned by another user`);
    owned();

    return { handle, size: Number(opened.size), mode: Number(opened.mode) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export interface LedgerRead { path: string; records: AttemptRecord[]; warnings: string[] }

/** Reads the whole ledger on demand. Missing is zero attempts; a repeated attempt id counts once. */
export async function readLedger(path: string, owned: () => void = () => {}): Promise<LedgerRead> {
  const result: LedgerRead = { path, records: [], warnings: [] };
  let text: string;

  try {
    const { handle } = await openLedger(path, false, owned);

    try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch (error: any) {
    if (error instanceof LedgerRevoked) throw error;

    if (error?.code === "ENOENT") return result;
    result.warnings.push(`${path}: unreadable (${error?.code ?? error?.message ?? "error"})`);

    return result;
  }

  const lines = text.split("\n");
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const torn = index === lines.length - 1;
    let value: unknown;

    try { value = JSON.parse(line); } catch { value = undefined; }

    const record = decodeRecord(value);

    if (Option.isNone(record)) {
      result.warnings.push(`${path}:${index + 1}: ${torn ? "torn" : "malformed"} record ignored`);

      return;
    }

    if (seen.has(record.value.id)) return;
    seen.add(record.value.id);
    result.records.push(record.value);
  });

  return result;
}

const SHOWN_WARNINGS = 20;

/** Human-readable historical totals. Unknown cost and missing usage stay unknown, never zero. */
export function formatUsage(read: LedgerRead, unrecorded: number): string {
  const { records } = read;
  const outcomes = new Map<Outcome, number>();
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let measuredCount = 0;
  let priced = 0;
  let cost = 0;
  let ms = 0;

  for (const r of records) {
    outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
    ms += r.ms;

    if (r.tokens) {
      measuredCount++;
      tokens.input += r.tokens.input;
      tokens.output += r.tokens.output;
      tokens.cacheRead += r.tokens.cacheRead;
      tokens.cacheWrite += r.tokens.cacheWrite;
    }

    if (r.cost !== null) {
      priced++;
      cost += r.cost;
    }
  }

  const lines = [
    `OptChat compactor usage (all sessions in this store)`,
    `Ledger: ${read.path}`,
    `Provider attempts: ${records.length}`,
  ];

  if (records.length) {
    lines.push(
      `Outcomes: ${OUTCOMES.flatMap(o => outcomes.has(o) ? [`${o} ${outcomes.get(o)}`] : []).join(", ")}`,
      `Corrective retry attempts: ${records.filter(r => r.attempt > 1).length}; attempts after a failure cooldown: ${records.filter(r => r.retry > 0).length}`,
      `Request time: ${(ms / 1000).toFixed(1)} s total`,
      `Tokens (${measuredCount} of ${records.length} attempts reported usage): input ${tokens.input}, output ${tokens.output}, cache read ${tokens.cacheRead}, cache write ${tokens.cacheWrite}`,
      `Estimated cost: $${cost.toFixed(4)} for ${priced} priced attempts; ${records.length - priced} attempts unknown (usage or pricing unavailable, not free)`,
    );
  }

  const incomplete = read.warnings.slice(0, SHOWN_WARNINGS);

  if (read.warnings.length > SHOWN_WARNINGS) incomplete.push(`${read.warnings.length - SHOWN_WARNINGS} more ledger warnings in ${read.path}`);

  if (unrecorded) incomplete.push(`${unrecorded} attempts in this session could not be recorded`);

  if (incomplete.length) lines.push("Totals are incomplete:", ...incomplete.map(w => `  ${w}`));

  return lines.join("\n");
}

/**
 * Private append-only ledger. Writes and reads run one at a time on one chain, so close drains both.
 * The driver uses it only while its Rust process holds the store's writer lock; `revoke` ends that use
 * at the next I/O boundary, including work already queued or in flight.
 */
export class UsageLedger {
  readonly path: string;
  /** Attempts this driver measured but could not persist. */
  unrecorded = 0;
  private pending: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private handle?: FileHandle;
  /** The file ends inside a line (a crash or failed write), so the next write starts a fresh one. */
  private torn = false;
  private warned = false;
  private closed = false;
  private revoked = false;
  private warn: (message: string) => void;

  constructor(dir: string, warn: (message: string) => void) {
    this.path = join(dir, LEDGER_FILE);
    this.warn = warn;
  }

  record(record: AttemptRecord): void {
    if (this.closed || this.revoked) {
      this.unrecorded++;

      return;
    }

    this.pending.push(`${JSON.stringify(record)}\n`);
    this.enqueue(() => this.write());
  }

  private enqueue<A>(work: () => Promise<A>): Promise<A> {
    const next = this.chain.then(work);

    this.chain = next.catch(() => {});

    return next;
  }

  /** Revoked or closed both end ownership: close drains accepted work before it sets `closed`. */
  private readonly owned = (): void => {
    if (this.revoked || this.closed) throw new LedgerRevoked();
  };

  private async release(): Promise<void> {
    const handle = this.handle;

    this.handle = undefined;
    await handle?.close().catch(() => {});
  }

  private async write(): Promise<void> {
    const batch = this.pending;

    if (!batch.length) return;
    this.pending = [];

    try {
      if (!this.handle) {
        const { handle, size, mode } = await openLedger(this.path, true, this.owned);

        // Owned at once, so any later failure closes it.
        this.handle = handle;

        if (process.platform !== "win32" && mode & 0o077) await handle.chmod(0o600);

        if (size > 0) {
          const last = Buffer.alloc(1);

          this.owned();
          await handle.read(last, 0, 1, size - 1);
          this.torn = last[0] !== 0x0a;
        }
      }

      this.owned();
      await this.handle.appendFile(`${this.torn ? "\n" : ""}${batch.join("")}`);
      this.torn = false;
      this.warned = false;
    } catch (error) {
      this.unrecorded += batch.length;
      this.torn = true;
      await this.release();

      if (!this.warned && !(error instanceof LedgerRevoked)) {
        this.warned = true;
        this.warn(`OptChat usage ledger write failed; memory is unaffected: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Flushes pending attempts, then reads the ledger on the same chain. Rejects once the store is revoked. */
  read(): Promise<LedgerRead> {
    return this.enqueue(async () => {
      await this.write();

      return readLedger(this.path, this.owned);
    });
  }

  /** The writer lock is gone: nothing queued, in flight, or later is written or read; the file is closed. */
  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    this.unrecorded += this.pending.length;
    this.pending = [];
    this.enqueue(() => this.release());
  }

  /** Drains every queued write and read, then closes the file. Never rejects. */
  close(): Promise<void> {
    return this.enqueue(async () => {
      await this.write();
      this.closed = true;
      await this.release();
    });
  }
}

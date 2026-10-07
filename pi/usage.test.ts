import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, open, type FileHandle, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { calculateCost, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { formatUsage, LEDGER_FILE, measured, readLedger, replyOutcome, UsageLedger, type AttemptRecord } from "./usage.ts";

const unix = process.platform !== "win32";

function record(fields: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    v: 1, id: crypto.randomUUID(), session: "s", provider: "test", model: "compact", l: 0, i: 0, attempt: 1, retry: 0,
    outcome: "ok", at: "2026-01-01T00:00:00.000Z", ms: 10, tokens: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5 }, cost: 0.01, ...fields,
  };
}

async function withDir(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "optchat-usage-"));

  try { await work(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const model = { provider: "test", id: "compact", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } } satisfies Pick<Model<Api>, "provider" | "id" | "cost">;

function reply(fields: Partial<AssistantMessage> = {}): AssistantMessage {
  // SAFETY: measured and replyOutcome read only usage, provider, model, content, and stopReason.
  return {
    role: "assistant", api: "openai-completions", provider: "test", model: "compact", stopReason: "stop", timestamp: 0,
    content: [{ type: "text", text: "summary" }],
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0.0001, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00012 } },
    ...fields,
  } as AssistantMessage;
}

test("measured keeps known usage and never treats missing usage or zero pricing as free", () => {
  assert.deepEqual(measured(reply(), model, "ok"), { tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, cost: 0.00012 });
  assert.deepEqual(measured(undefined, model, "cancelled"), { tokens: null, cost: null });
  const zero = reply({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  assert.deepEqual(measured(zero, model, "ok"), { tokens: null, cost: null }, "a zero-filled default is not a measurement");
  const free = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(measured(reply(), free, "ok").cost, null, "all-zero catalog rates are unknown pricing");
  assert.equal(measured(reply({ model: "fallback" }), model, "ok").cost, null, "a reply from another model is not priced by this catalog");
  const partial = measured(reply({ stopReason: "error" }), model, "error");
  assert.deepEqual(partial.tokens, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, "an error reply keeps its partial usage");
  assert.equal(partial.cost, null, "partial usage is not a complete cost");
  const corrupt = reply({ usage: { ...reply().usage, input: -1 } });
  assert.deepEqual(measured(corrupt, model, "ok"), { tokens: null, cost: null });
  assert.equal(replyOutcome(reply({ stopReason: "aborted" })), "aborted");
  assert.equal(replyOutcome(reply({ content: [] })), "empty");
  // SAFETY: a malformed provider reply must classify without throwing.
  assert.equal(replyOutcome({ stopReason: "stop" } as AssistantMessage), "empty");
});

test("missing ledger is zero attempts; totals report a known subtotal and unknown attempts", async () => {
  await withDir(async dir => {
    const path = join(dir, LEDGER_FILE);
    const empty = await readLedger(path);
    assert.deepEqual(empty, { path, records: [], warnings: [] });
    assert.match(formatUsage(empty, 0), /Provider attempts: 0/);
    assert.doesNotMatch(formatUsage(empty, 0), /incomplete/);
    const text = formatUsage({ path, records: [record(), record({ attempt: 2, cost: null }), record({ outcome: "cancelled", retry: 1, tokens: null, cost: null })], warnings: [] }, 0);
    assert.match(text, /Provider attempts: 3/);
    assert.match(text, /Outcomes: ok 2, cancelled 1/);
    assert.match(text, /Corrective retry attempts: 1; attempts after a failure cooldown: 1/);
    assert.match(text, /Tokens \(2 of 3 attempts reported usage\): input 200, output 20, cache read 100, cache write 10/);
    assert.match(text, /Estimated cost: \$0\.0100 for 1 priced attempts; 2 attempts unknown/);
  });
});

test("ledger appends privately, dedups by attempt id, and reports corrupt and torn lines by path and line", async () => {
  await withDir(async dir => {
    const path = join(dir, LEDGER_FILE);
    const good = record();

    const lines = [
      JSON.stringify(good),
      JSON.stringify(good),
      JSON.stringify(record({ tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      JSON.stringify(record({ cost: -0.5 })),
      JSON.stringify(record({ id: "" })),
      JSON.stringify(record()).replace('"ms":10', '"ms":1e999'),
      "not json",
      '{"v":1,"id":"torn',
    ];

    await writeFile(path, lines.join("\n"), { mode: 0o644 });
    const warnings: string[] = [];
    const ledger = new UsageLedger(dir, message => warnings.push(message));
    const next = record();
    ledger.record(next);
    const read = await ledger.read();
    await ledger.close();
    assert.deepEqual(warnings, []);
    assert.deepEqual(read.records.map(r => r.id), [good.id, next.id], "a repeated id counts once and the new append survives the torn tail");
    assert.deepEqual(read.warnings, [3, 4, 5, 6, 7, 8].map(n => `${path}:${n}: malformed record ignored`));

    if (unix) assert.equal((await stat(path)).mode & 0o777, 0o600, "our own ledger is made private");
    const text = formatUsage(read, 0);
    assert.match(text, /Totals are incomplete/);
    assert.ok(read.warnings.every(w => text.includes(w)));
    await writeFile(path, `${JSON.stringify(record())}\n{"v":1`);
    assert.deepEqual((await readLedger(path)).warnings, [`${path}:2: torn record ignored`]);
  });
});

test("a new ledger is created 0600 and records written after close are counted as unrecorded", async () => {
  await withDir(async dir => {
    const ledger = new UsageLedger(dir, assert.fail);
    ledger.record(record());
    await ledger.close();
    ledger.record(record());
    assert.equal(ledger.unrecorded, 1);

    if (unix) assert.equal((await stat(ledger.path)).mode & 0o777, 0o600);
    assert.equal((await readLedger(ledger.path)).records.length, 1);
  });
});

// Windows has no O_NOFOLLOW: there the symlink and hard-link cases exercise the lstat/fstat identity check.
test("ledger refuses symlinks, hard links, directories, and FIFOs without touching their targets", async () => {
  await withDir(async dir => {
    const outside = join(dir, "outside");
    await writeFile(outside, "unrelated\n", { mode: 0o644 });
    const store = join(dir, "store");

    const cases: [string, () => Promise<void>][] = [
      ["symlink", () => symlink(outside, join(store, LEDGER_FILE))],
      ["hard link", () => link(outside, join(store, LEDGER_FILE))],
      ["directory", () => mkdir(join(store, LEDGER_FILE))],
      ...unix ? [["fifo", async () => { execFileSync("mkfifo", [join(store, LEDGER_FILE)]); }] satisfies [string, () => Promise<void>]] : [],
    ];

    for (const [name, make] of cases) {
      await rm(store, { recursive: true, force: true });
      await mkdir(store, { mode: 0o700 });

      try { await make(); } catch (error: any) {
        // Unprivileged Windows accounts cannot create symlinks; that case is then unreachable for them too.
        if (!unix && error?.code === "EPERM") continue;
        throw error;
      }

      const warnings: string[] = [];
      const ledger = new UsageLedger(store, message => warnings.push(message));
      ledger.record(record());
      ledger.record(record());
      const read = await ledger.read();
      await ledger.close();
      assert.equal(warnings.length, 1, `${name}: one warning for repeated failures`);
      assert.match(warnings[0], /usage ledger write failed; memory is unaffected/);
      assert.equal(ledger.unrecorded, 2, name);
      assert.deepEqual(read.records, [], name);
      assert.equal(read.warnings.length, 1, name);
      assert.ok(read.warnings[0].startsWith(`${ledger.path}: unreadable`), name);
      assert.equal(await readFile(outside, "utf8"), "unrelated\n", `${name}: the target is untouched`);

      if (unix) assert.equal((await stat(outside)).mode & 0o777, 0o644, `${name}: the target is not chmodded`);
      await stat(ledger.path); // the failed path is never unlinked
    }
  });
});

/** FileHandle methods are shared through one prototype; tests wrap them to pause or fail the ledger's own I/O. */
async function fileHandlePrototype(dir: string): Promise<any> {
  const probe = await open(join(dir, "probe"), "w");
  const proto = Object.getPrototypeOf(probe);

  await probe.close();

  return proto;
}

function wrap(proto: any, name: string, replacement: (original: Function) => Function): () => void {
  const original = proto[name];

  proto[name] = replacement(original);

  return () => { proto[name] = original; };
}

/** Pauses the first call of `name` until `release`; reports the handle it paused. */
function pauseFirst(proto: any, name: string) {
  let started!: (handle: any) => void;
  let release!: () => void;
  const paused = new Promise<any>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;

  const restore = wrap(proto, name, original => async function (this: any, ...args: unknown[]) {
    if (first) {
      first = false;
      started(this);
      await gate;
    }

    return original.apply(this, args);
  });

  return { paused, release, restore };
}

test("cost is unknown for a substituted model, an applicable zero tariff, or an invalid total; tokens survive", () => {
  const priced = (fields: Partial<AssistantMessage>, catalog = model, outcome: "ok" | "error" = "ok") => measured(reply(fields), catalog, outcome);
  const tokens = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(priced({ responseModel: "other-model" }), { tokens, cost: null }, "the SDK keeps the requested model and prices with it");
  assert.equal(priced({ responseModel: "compact" }).cost, 0.00012);

  // The installed SDK prices the request itself; the ledger must agree on which tariff it used.
  const withCost = (catalog: typeof model) => {
    const usage = { ...reply().usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

    // SAFETY: calculateCost reads only the model's cost table.
    return { usage: { ...usage, cost: calculateCost({ ...catalog, api: "openai-completions" } as Model<Api>, usage) } };
  };

  const zeroTier = { ...model, cost: { ...model.cost, tiers: [{ inputTokensAbove: 50, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] } };
  assert.deepEqual(priced(withCost(zeroTier), zeroTier), { tokens, cost: null }, "the applicable all-zero tier is unknown pricing");
  const farTier = { ...model, cost: { ...model.cost, tiers: [{ inputTokensAbove: 1000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] } };
  assert.equal(priced(withCost(farTier), farTier).cost, withCost(farTier).usage.cost.total, "a tier above this request does not apply");
  const paidTier = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 50, input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }] } };
  const paid = withCost(paidTier).usage.cost.total;
  assert.ok(paid > 0);
  assert.equal(priced(withCost(paidTier), paidTier).cost, paid, "the SDK's applicable tier, not the base, decides");
  const broken = { usage: { ...reply().usage, cost: { ...reply().usage.cost, total: Number.NaN } } };
  assert.deepEqual(priced(broken, model, "error"), { tokens, cost: null }, "an error reply keeps tokens without a valid cost");
  assert.deepEqual(priced(broken), { tokens, cost: null }, "an invalid total affects only cost");
});

test("a failed ledger initialization closes the file it opened", async () => {
  await withDir(async dir => {
    const proto = await fileHandlePrototype(dir);
    const path = join(dir, LEDGER_FILE);
    const existing = `${JSON.stringify(record())}\n`;
    await writeFile(path, existing, { mode: 0o600 });
    const handles: FileHandle[] = [];

    const restore = wrap(proto, "read", original => function (this: FileHandle, ...args: unknown[]) {
      handles.push(this);

      return handles.length > 1 ? original.apply(this, args) : Promise.reject(new Error("injected tail read failure"));
    });

    const warnings: string[] = [];
    const ledger = new UsageLedger(dir, message => warnings.push(message));

    try {
      ledger.record(record());
      await ledger.close();
    } finally { restore(); }

    assert.equal(handles.length, 1, "the tail read ran once");
    assert.equal(handles[0].fd, -1, "the handle opened for initialization is closed");
    assert.equal(warnings.length, 1);
    assert.equal(ledger.unrecorded, 1);
    assert.equal(await readFile(path, "utf8"), existing);
  });
});

test("revocation while the ledger opens stops the append and closes the file", async () => {
  await withDir(async dir => {
    const proto = await fileHandlePrototype(dir);
    const path = join(dir, LEDGER_FILE);
    const existing = `${JSON.stringify(record())}\n`;
    await writeFile(path, existing, { mode: 0o600 });
    const pause = pauseFirst(proto, "stat");
    const warnings: string[] = [];
    const ledger = new UsageLedger(dir, message => warnings.push(message));

    try {
      ledger.record(record());
      const handle = await pause.paused;
      ledger.revoke();
      pause.release();
      await ledger.close();
      assert.equal(handle.fd, -1);
    } finally { pause.restore(); }

    assert.equal(await readFile(path, "utf8"), existing, "nothing is written after revocation");
    assert.equal(ledger.unrecorded, 1);
    assert.deepEqual(warnings, [], "revocation is reported by the driver, not as a write failure");
  });
});

test("a read queued before revocation never opens the ledger", async () => {
  await withDir(async dir => {
    await writeFile(join(dir, LEDGER_FILE), `${JSON.stringify(record())}\n`, { mode: 0o600 });
    const ledger = new UsageLedger(dir, assert.fail);
    ledger.record(record());
    const read = ledger.read();
    ledger.revoke();
    await assert.rejects(read, /no longer owns the store/);
    await ledger.close();
    assert.equal(ledger.unrecorded, 1);
    assert.equal((await readLedger(ledger.path)).records.length, 1);
  });
});

test("a ledger path replaced by a link after open is refused without writing anywhere", async t => {
  await withDir(async dir => {
    const proto = await fileHandlePrototype(dir);
    const path = join(dir, LEDGER_FILE);
    const aside = join(dir, "aside");
    const outside = join(dir, "outside");
    const existing = `${JSON.stringify(record())}\n`;
    await writeFile(path, existing, { mode: 0o600 });
    await writeFile(outside, "unrelated\n");
    const pause = pauseFirst(proto, "stat");
    const warnings: string[] = [];
    const ledger = new UsageLedger(dir, message => warnings.push(message));

    try {
      ledger.record(record());
      await pause.paused;
      await rename(path, aside);

      try { await symlink(outside, path); } catch (error: any) {
        pause.release();

        if (error?.code === "EPERM") return t.skip("symlinks need privileges here");
        throw error;
      }

      pause.release();
      await ledger.close();
    } finally { pause.restore(); }

    assert.equal(warnings.length, 1);
    assert.equal(ledger.unrecorded, 1);
    assert.equal(await readFile(aside, "utf8"), existing, "the opened file is not appended once its path changed");
    assert.equal(await readFile(outside, "utf8"), "unrelated\n");
  });
});

test("a closed ledger drains accepted records, then refuses later reads", async () => {
  await withDir(async dir => {
    const ledger = new UsageLedger(dir, assert.fail);
    ledger.record(record());
    await ledger.close();
    assert.equal((await readLedger(ledger.path)).records.length, 1, "records accepted before close are written");
    await assert.rejects(ledger.read(), /no longer owns the store/);
  });
});

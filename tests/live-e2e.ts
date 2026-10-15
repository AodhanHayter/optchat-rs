// Live end-to-end compaction run against a real provider. Costs money (~$0.02-0.05); run on purpose:
//   node tests/live-e2e.ts [provider/model-id] [effort]   (default anthropic/claude-haiku-5-5 at medium)
//   npm run test:live                           (Haiku, then openai-codex/gpt-6-luna)
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { EFFORTS } from "../pi/config.ts";
import { MemoryDriver } from "../pi/memory.ts";
import { LEDGER_FILE } from "../pi/usage.ts";

const modelName = process.argv[2] ?? "anthropic/claude-haiku-5-5";

const effort = EFFORTS.find(level => level === (process.argv[3] ?? "medium"));

if (!effort) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);

const runtime = await ModelRuntime.create();

const [provider, id] = [modelName.slice(0, modelName.indexOf("/")), modelName.slice(modelName.indexOf("/") + 1)];

if (!runtime.getModel(provider, id)) throw new Error(`model ${modelName} not configured in pi`);

// A short coding session; each message is long enough that the transcript needs several summaries and merges.
const chat: [string, string][] = [
  ["user", "The CSV importer in src/import.rs crashes on files with a trailing blank line. Please find out why and fix it without changing the public API. Keep the error messages naming the file and the line number, our support team depends on that format: 'import.csv:42: expected 5 fields, got 1'."],
  ["tool", "read src/import.rs lines 1-120: fn parse_rows(path: &Path) -> Result<Vec<Row>> splits on '\\n', indexes fields[4] without checking the field count; empty last line gives fields == [\"\"], so fields[4] panics with index out of bounds. Errors use format!(\"{}:{}: {}\", path.display(), n, msg)."],
  ["talk", "Found it: parse_rows indexes fields[4] before checking the count, and a trailing blank line yields a single empty field, so it panics instead of returning an error. I will skip fully empty lines and turn any other short row into the usual 'expected 5 fields, got N' error with the file and line number."],
  ["user", "Skipping blank lines is fine, but only trailing ones. A blank line in the middle of a file usually means a broken export and we want that reported as an error, not silently ignored. Also add a regression test for both cases please."],
  ["tool", "edit src/import.rs: trim trailing empty lines before the loop; a short or empty row inside the file returns Err(\"{path}:{n}: expected 5 fields, got {k}\"). Added tests trailing_blank_line_is_ignored and blank_line_inside_file_is_an_error in tests/import.rs using tempfile fixtures."],
  ["echo", "cargo test --test import: running 14 tests ... test trailing_blank_line_is_ignored ok, test blank_line_inside_file_is_an_error ok, test quoted_commas ok ... test result: ok. 14 passed; 0 failed; 0 ignored; finished in 0.41s. cargo clippy: no warnings."],
  ["talk", "Fixed in src/import.rs: trailing blank lines are dropped, a blank or short line inside the file is an error 'import.csv:N: expected 5 fields, got K'. Two regression tests added in tests/import.rs; all 14 import tests and clippy pass. Not checked: Windows line endings (\\r\\n) at the end of the file."],
  ["user", "Good catch on Windows line endings, our biggest customer exports from Excel on Windows. Please handle \\r\\n too, and then write a short note for the changelog under 'Fixed' for version 2.3.1."],
];

const dir = await mkdtemp(join(tmpdir(), "optchat-live-"));

const warnings: string[] = [];

const fatal: Error[] = [];

const ctx = {
  ui: { notify: (message: string) => { warnings.push(message); console.error(`notify: ${message}`); } },
  modelRegistry: { find: (p: string, m: string) => runtime.getModel(p, m), streamSimple: runtime.streamSimple.bind(runtime) },
};

const driver = new MemoryDriver(ctx, resolve("target/debug/optchat"), dir, modelName, error => fatal.push(error), undefined, undefined, effort);

const started = Date.now();

try {
  for (const [kind, text] of chat) await driver.append(kind, text);

  assert.equal(await driver.wait(AbortSignal.timeout(300_000), true), true, "compaction did not finish within 5 minutes");

  // A small byte limit makes Rust render the summaries instead of the raw messages.
  const { view } = await driver.client.call("view", { display: true, max_bytes: 1500 });

  const rows = (await readFile(join(dir, LEDGER_FILE), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));

  console.log(view);

  for (const r of rows) console.log(`${r.l}:${r.i} attempt ${r.attempt} retry ${r.retry} ${r.outcome} ${(r.ms / 1000).toFixed(1)}s out ${r.tokens?.output} $${r.cost?.toFixed(5)}`);

  const cost = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);

  console.log(`${modelName}: ${rows.length} calls, $${cost.toFixed(4)}, ${((Date.now() - started) / 1000).toFixed(0)}s`);

  assert.deepEqual(fatal, []);
  assert.deepEqual(warnings, []);
  assert.ok(rows.length >= 3, `expected several summary calls, got ${rows.length}`);
  assert.deepEqual(rows.filter(r => r.outcome !== "ok"), [], "every call succeeded");
  assert.ok(rows.every(r => r.tokens?.output > 0 && r.cost > 0), "every call recorded tokens and cost");
  assert.ok(!view.includes("not summarized yet"), "every message summarized");
  assert.match(view, /^\d+\+[2-9]\d*\|/m, "the view shows merged summaries");
  // Details the user insisted on must survive compaction.
  assert.match(view, /2\.3\.1/);
  assert.match(view, /\\r\\n|CRLF|Windows/i);
  console.log(`PASS ${modelName}`);
} finally {
  await driver.close();
  await rm(dir, { recursive: true, force: true });
}

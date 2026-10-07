// Synthetic stores only. No Pi session, credentials, or provider requests.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { OptChatClient, capText } from "../pi/transport.ts";
import { LEDGER_FILE, readLedger, formatUsage } from "../pi/usage.ts";

const mode = process.argv[2];

assert.ok(["import", "export", "export_file", "usage", "capText"].includes(mode), "usage: node --expose-gc benches/driver.mjs import|export|export_file|usage|capText");

const sizes = (process.env.OPTCHAT_BENCH_SIZES ?? (mode === "import" ? "100" : "1000,10000,100000")).split(",").map(Number);

const samples = Number(process.env.OPTCHAT_BENCH_SAMPLES ?? 3);

assert.ok(Number.isSafeInteger(samples) && samples > 0);

const binary = resolve(process.env.OPTCHAT_BENCH_BIN ?? "target/release/optchat");

const text = "source code, logs, and Unicode 🦀\n".repeat(32);

function message(i) {
  return { i, kind: "user", text, size: Buffer.byteLength(text) + 6, date: "2026-01-01T00:00:00Z" };
}

async function jsonLines(path, count, record) {
  const file = await open(path, "wx", 0o600);

  try {
    for (let start = 0; start < count; start += 256) {
      const lines = [];

      for (let i = start; i < Math.min(start + 256, count); i++) lines.push(JSON.stringify(record(i)));
      await file.writeFile(lines.join("\n") + "\n");
    }
  } finally { await file.close(); }
}

console.log("case,median_ms,node_peak_rss_kib,rust_peak_rss_kib,output_bytes,samples");

for (const count of sizes) {
  assert.ok(Number.isSafeInteger(count) && count >= 0);
  const dir = await mkdtemp(join(tmpdir(), "optchat-driver-bench-"));
  let client;
  let input;
  let bytes = 0;
  let rustPeak = "";

  try {
    if (mode === "export" || mode === "export_file") {
      await mkdir(join(dir, "main"), { mode: 0o700 });
      await jsonLines(join(dir, "main", "2026-01-01.jsonl"), count, message);
      // A sparse tree also measures large pending snapshots, not only settled views.
      client = new OptChatClient(binary, ["--dir", dir, "serve"]);
      await client.call("status");
    } else if (mode === "usage") {
      await jsonLines(join(dir, LEDGER_FILE), count, i => ({
        v: 1, id: `attempt-${i}`, session: "synthetic", provider: "test", model: "test",
        l: 0, i, attempt: 1, retry: 0, outcome: "ok", at: "2026-01-01T00:00:00Z", ms: 10,
        tokens: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 }, cost: null,
      }));
    } else if (mode === "import") {
      input = Array.from({ length: count }, (_, i) => message(i));
    } else {
      input = "🦀".repeat(count);
    }

    const times = [];

    for (let sample = 0; sample < samples; sample++) {
      if (mode === "import") {
        client = new OptChatClient(binary, ["--dir", join(dir, String(sample)), "serve"]);
        await client.call("status");
      }

      globalThis.gc?.();
      const start = performance.now();

      if (mode === "export" || mode === "export_file") {
        const path = join(dir, `snapshot-${sample}.html`);

        if (mode === "export") {
          // The old browse path: transport a full HTML string, then write it in Node.
          const html = await client.call("export");
          const file = await open(path, "wx", 0o600);

          try {
            await file.writeFile(html);
            await file.sync();
          } finally { await file.close(); }
        } else {
          assert.deepEqual(await client.call("export_file", { file: path }), { file: path });
        }

        times.push(performance.now() - start);
        // Validate the saved output without loading it back into Node's heap.
        const file = await open(path, "r");

        try {
          bytes = (await file.stat()).size;
          const header = Buffer.alloc(64);
          const tail = Buffer.alloc(23);
          await file.read(header, 0, header.length, 0);
          await file.read(tail, 0, tail.length, bytes - tail.length);
          assert.ok(header.toString().startsWith("<!doctype html>"));
          assert.equal(tail.toString(), "</script></body></html>");
        } finally { await file.close(); }
      } else if (mode === "import") {
        const reply = await client.call("import", { messages: input });
        times.push(performance.now() - start);
        assert.equal(reply.imported, count);
        assert.equal((await client.call("status")).messages, count);
      } else if (mode === "usage") {
        const ledger = await readLedger(join(dir, LEDGER_FILE));
        const report = formatUsage(ledger, 0);
        times.push(performance.now() - start);
        assert.equal(ledger.attempts, count);
        assert.equal(ledger.warnings.length, 0);
        bytes = Buffer.byteLength(report);
      } else {
        const result = capText(input);
        times.push(performance.now() - start);
        bytes = Buffer.byteLength(result);
      }

      if (client && process.platform === "linux") {
        const status = await readFile(`/proc/${client.proc.pid}/status`, "utf8");
        const match = status.match(/^VmHWM:\s+(\d+) kB$/m);
        rustPeak = Math.max(Number(rustPeak), Number(match?.[1] ?? 0));
      }

      if (mode === "import") await client.dispose();
    }

    times.sort((a, b) => a - b);
    console.log(`${mode}/${count},${times[Math.floor(times.length / 2)].toFixed(3)},${process.resourceUsage().maxRSS},${rustPeak},${bytes},${samples}`);
  } finally {
    await client?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

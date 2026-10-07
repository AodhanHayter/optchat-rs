// Compare deterministic public RPC traces. Both stores are disposable fixtures.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OptChatClient } from "../pi/transport.ts";

const [baseline, candidate] = process.argv.slice(2);

assert.ok(baseline && candidate, "usage: node scripts/compare-engines.mjs BASELINE_BINARY CANDIDATE_BINARY");

const root = await mkdtemp(join(tmpdir(), "optchat-equivalence-"));

let calls = 0;

try {
  for (const budget of [1, 130, 1024, 128000]) {
    for (const seed of [1, 98765]) {
      let state = seed;

      const random = n => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

        return state % n;
      };

      const dirs = [join(root, `old-${budget}-${seed}`), join(root, `new-${budget}-${seed}`)];
      const messages = [];
      const nodes = [];

      for (let i = 0; i < 48; i++) {
        const text = `source ${i}: ` + "a🦀\r\nb".repeat(random(90) + 1);
        messages.push({ i, kind: "user", text, size: 6 + Buffer.byteLength(text), date: "2026-01-01T00:00:00Z" });

        if (random(4) !== 0) {
          const summary = `summary ${i}: ` + "x".repeat(random(650) + 1);
          nodes.push({ l: 0, i, text: summary, size: summary.length });
        }
      }

      for (let l = 1; l < 6; l++) {
        for (let i = 0; i < (48 >> l); i++) {
          if (random(2) && [0, 1].every(j => nodes.some(n => n.l === l - 1 && n.i === 2 * i + j))) {
            const text = "parent " + "y".repeat(random(800) + 1);
            nodes.push({ l, i, text, size: text.length });
          }
        }
      }

      for (const dir of dirs) {
        await mkdir(join(dir, "main"), { recursive: true });
        await mkdir(join(dir, "tree"));
        await writeFile(join(dir, "main/2026-01-01.jsonl"), messages.map(m => JSON.stringify(m)).join("\n") + "\n");
        await writeFile(join(dir, "tree/2026-01-01.jsonl"), nodes.map(n => JSON.stringify(n)).join("\n") + "\n");
      }

      const start = () => [baseline, candidate].map((binary, i) => new OptChatClient(resolve(binary), ["--dir", dirs[i], "--view-bytes", String(budget), "serve"]));
      let clients = start();
      let active = [];

      const call = async (op, args = {}) => {
        const values = await Promise.all(clients.map(c => c.call(op, args)));
        assert.deepEqual(values[1], values[0], `budget=${budget} seed=${seed} op=${op} call=${calls}`);
        calls++;

        return values[0];
      };

      try {
        for (let round = 0; round < 180; round++) {
          active.push(...await call("jobs"));
          await call("view", { display: true });
          await call("status");

          if (round % 13 === 0) await call("append", { kind: "note", text: `appended ${round} ` + "q".repeat(random(600)), date: "2026-01-02T00:00:00Z" });

          if (active.length) {
            const n = random(active.length);
            const job = active[n];

            if (round % 23 === 5) {
              await call("fail", { l: job.l, i: job.i });
              active.splice(n, 1);
            } else {
              const reply = await call("submit", { l: job.l, i: job.i, text: "answer " + "x".repeat(random(700) + 1) });

              if (reply.retry) active[n] = reply.retry;
              else active.splice(n, 1);
            }
          }

          if (round % 29 === 28) {
            await Promise.all(clients.map(c => c.dispose()));
            clients = start();
            active = [];
          }
        }

        for (const text of ["SOURCE", "a🦀\r\nB", "non-match", "q".repeat(256), "summary"]) {
          await call("search", { text, before: 35, include_tools: true });
        }

        const expected = await clients[0].call("export");
        const file = join(dirs[1], "snapshot.html");
        assert.deepEqual(await clients[1].call("export_file", { file }), { file });

        // Viewer code may improve independently. All markup and embedded history before it must match.
        const snapshot = html => {
          const end = html.indexOf("</script><script>");
          assert.ok(end >= 0);

          return html.slice(0, end);
        };

        assert.equal(snapshot(await readFile(file, "utf8")), snapshot(expected), "snapshot data matches the baseline byte for byte");
      } finally { await Promise.all(clients.map(c => c.dispose())); }
    }
  }

  console.log(`Compared ${calls} identical RPC responses and 8 matching snapshot payloads across 8 sparse-history runs`);
} finally { await rm(root, { recursive: true, force: true }); }

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Fiber } from "effect";
import { OptChatClient, type TransportError } from "./transport.ts";

const binary = resolve("target/debug/optchat");

/** A stand-in server: `crash` dies on the first line, `stray` answers an id nobody asked for,
 *  and `silent` neither answers nor exits when stdin ends. */
const FAKE = `const mode = process.argv[2];
if (mode === "stray") process.stdout.write('{"request_id":99,"ok":true,"result":null}\\n');
if (mode === "null") process.stdout.write('null\\n');
process.stdin.resume();
process.stdin.on("data", () => { if (mode === "crash") process.exit(3); });
setInterval(() => {}, 1000);
`;

async function fakeServer(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "optchat-fake-"));

  await writeFile(join(dir, "server.mjs"), FAKE);

  return dir;
}

test("a cancelled request keeps its durable write and its late reply is not a protocol failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optchat-cancel-"));
  const client = new OptChatClient(binary, ["--dir", dir, "serve"]);
  const fatal: TransportError[] = [];
  client.onExit = error => { fatal.push(error); };

  try {
    const sent = Effect.runFork(client.request("append", { kind: "user", text: "cancelled before the reply" }));
    // No event-loop turn has passed since the write, so the server's reply is certainly still in flight.
    const exit = await Effect.runPromiseExit(Fiber.interrupt(sent).pipe(Effect.flatMap(() => Fiber.join(sent))));
    assert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause), "the request fiber must end interrupted");
    assert.equal((await client.call("status")).messages, 1, "the append was written before the interrupt");
    assert.deepEqual(fatal, [], "a reply to a cancelled request must not kill the client");
  } finally { await client.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("a dying process fails its pending request once and stays closed", async () => {
  const dir = await fakeServer();
  const client = new OptChatClient(process.execPath, [join(dir, "server.mjs"), "crash"]);
  const fatal: TransportError[] = [];
  client.onExit = error => { fatal.push(error); };

  try {
    await assert.rejects(client.call("status"), /optchat exited \(3\)/);
    assert.equal(fatal.length, 1);
    await assert.rejects(client.call("status"), /process is not running/);
  } finally { await client.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("a reply to a request this client never made is fatal", async () => {
  const dir = await fakeServer();
  const client = new OptChatClient(process.execPath, [join(dir, "server.mjs"), "stray"]);
  let reported!: (error: TransportError) => void;
  const fatal = new Promise<TransportError>(resolve => { reported = resolve; });
  client.onExit = reported;

  try {
    assert.match((await fatal).message, /unexpected optchat response/);
  } finally { await client.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("a null response fails pending requests without escaping the process boundary", async () => {
  const dir = await fakeServer();
  const client = new OptChatClient(process.execPath, [join(dir, "server.mjs"), "null"]);
  const fatal: TransportError[] = [];
  client.onExit = error => { fatal.push(error); };

  try {
    await assert.rejects(Effect.runPromise(client.request("status").pipe(Effect.timeout("1 second"))), /unexpected optchat response/);
    assert.equal(fatal.length, 1);
    await assert.rejects(client.call("status"), /process is not running/);
  } finally { await client.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("dispose stops a server that ignores stdin, and runs only once", async () => {
  const dir = await fakeServer();
  const client = new OptChatClient(process.execPath, [join(dir, "server.mjs"), "silent"]);

  try {
    const unanswered = client.call("status");
    const first = client.dispose();
    assert.equal(client.dispose(), first, "dispose must not start a second shutdown");
    await assert.rejects(unanswered, /optchat closed/);
    await first;
    await assert.rejects(client.call("status"), /process is not running/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

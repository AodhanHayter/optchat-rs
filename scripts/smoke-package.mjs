import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

assert.ok(process.argv[2], "Usage: node scripts/smoke-package.mjs PATH_TO_INSTALLED_PACKAGE");

const root = resolve(process.argv[2]);

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const binary = join(root, "bin", `${process.platform}-${process.arch}`, `optchat${process.platform === "win32" ? ".exe" : ""}`);

assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), `optchat ${pkg.version}`);

// Effect ships as a real runtime dependency now, so resolve it through ordinary Node module
// resolution from the installed package; npm may nest it under root or hoist it to an
// ancestor node_modules, and both are valid, so this does not assume either layout.
const resolveFromRoot = createRequire(join(root, "package.json"));

for (const name of Object.keys(pkg.dependencies ?? {})) {
  assert.ok(resolveFromRoot.resolve(name), `${name} must resolve from the installed package`);
}

// Pi supplies peer dependencies at runtime; they must not be bundled alongside the package.
for (const name of Object.keys(pkg.peerDependencies ?? {})) {
  assert.equal(existsSync(join(root, "node_modules", ...name.split("/"))), false, `Pi supplies the peer dependency: ${name}`);
}

for (const excluded of ["src", "tests", "tools", ".pi", "pi/config.test.ts", "pi/memory.test.ts"]) {
  assert.equal(existsSync(join(root, excluded)), false, `Unexpected package content: ${excluded}`);
}

const dir = await mkdtemp(join(tmpdir(), "optchat-package-"));

const memory = join(dir, "memory");

// Run in an isolated process and agent directory, without credentials or paid model calls.
process.env.PI_CODING_AGENT_DIR = dir;

process.env.PI_OFFLINE = "1";

delete process.env.PI_SUBAGENT_CHILD;

delete process.env.OPTCHAT_BIN;

delete process.env.OPTCHAT_DIR;

delete process.env.OPTCHAT_MODEL;

let session;

try {
  await writeFile(join(dir, "settings.json"), JSON.stringify({ optchat: { dir: memory } }));
  execFileSync(binary, ["--dir", memory, "append", "user", "Packaged binary round trip"]);
  const settingsManager = SettingsManager.inMemory({});
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [root],
  });

  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.equal(resourceLoader.getExtensions().extensions.length, 1);
  ({ session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(dir), tools: ["zoom", "date"],
  }));
  const failures = [];
  await session.bindExtensions({ mode: "print", onError: error => failures.push(error), abortHandler: () => failures.push("aborted") });
  const runner = session.extensionRunner;
  const zoom = runner.getToolDefinition("zoom");
  const result = await zoom.execute("smoke", { id: 0, n: 1 }, undefined, undefined, runner.createToolContext("smoke"));
  assert.deepEqual(result.content, [{ type: "text", text: "0+0|user: Packaged binary round trip" }]);
  assert.deepEqual(failures, []);
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  const status = JSON.parse(execFileSync(binary, ["--dir", memory, "status"], { encoding: "utf8" }));
  assert.equal(status.messages, 1, "Shutdown must release the writer lock");
  console.log(`Installed package passed on ${process.platform}-${process.arch}`);
} finally {
  if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
}

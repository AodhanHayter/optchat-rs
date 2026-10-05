import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "./config.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "optchat-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agent);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const global = join(agent, "settings.json");
  const project = join(cwd, ".pi/settings.json");

  return { agent, cwd, global, project };
}

test("OptChat defaults, partial layers, file-relative paths, and environment precedence", async t => {
  const { agent, cwd, global, project } = await fixture(t);
  assert.deepEqual(loadConfig(cwd, true, agent, {}), {
    bin: "optchat", dir: join(homedir(), ".local/share/optchat/chat"), model: "anthropic/claude-sonnet-4-5",
  });
  await writeFile(global, '\uFEFF' + JSON.stringify({ theme: "dark", optchat: { bin: "./bin/optchat", dir: "memory", model: "global/compact" } }));
  await writeFile(project, JSON.stringify({ optchat: { model: "project/compact" } }));
  assert.deepEqual(loadConfig(cwd, true, agent, {}), { bin: join(agent, "bin/optchat"), dir: join(agent, "memory"), model: "project/compact" });
  await writeFile(project, JSON.stringify({ optchat: { dir: "../memory" } }));
  assert.deepEqual(loadConfig(cwd, true, agent, {}), { bin: join(agent, "bin/optchat"), dir: join(cwd, "memory"), model: "global/compact" });
  assert.deepEqual(loadConfig(cwd, true, agent, { OPTCHAT_BIN: "custom-optchat", OPTCHAT_DIR: "env-memory", OPTCHAT_MODEL: "env/compact" }), {
    bin: "custom-optchat", dir: join(cwd, "env-memory"), model: "env/compact",
  });
  assert.equal(loadConfig(cwd, true, agent, { OPTCHAT_BIN: "./target/optchat" }).bin, join(cwd, "target/optchat"));
  await writeFile(global, JSON.stringify({ optchat: { bin: "~/bin/optchat", dir: "~/memories" } }));
  await writeFile(project, "{}");
  assert.equal(loadConfig(cwd, true, agent, {}).bin, join(homedir(), "bin/optchat"));
  assert.equal(loadConfig(cwd, true, agent, {}).dir, join(homedir(), "memories"));
});

test("untrusted project settings are not read, even when malformed", async t => {
  const { agent, cwd, global, project } = await fixture(t);
  await writeFile(global, JSON.stringify({ optchat: { model: "global/compact" } }));
  await writeFile(project, "{not JSON");
  assert.equal(loadConfig(cwd, false, agent, {}).model, "global/compact");
  await writeFile(project, JSON.stringify({ optchat: { bin: "./untrusted", dir: "private", model: "project/compact" } }));
  assert.deepEqual(loadConfig(cwd, false, agent, {}), { bin: "optchat", dir: join(homedir(), ".local/share/optchat/chat"), model: "global/compact" });
});

test("invalid settings fail with their source instead of silently using another memory", async t => {
  const { agent, cwd, global, project } = await fixture(t);
  await writeFile(global, "{broken");
  assert.throws(() => loadConfig(cwd, true, agent, {}), error => String(error).includes(global));
  await writeFile(global, "{}");

  for (const optchat of [null, [], "bad", { directory: "typo" }, { bin: 42 }, { dir: " " }, { dir: "bad\0path" }, { model: "no-provider" }, { model: "provider/" }]) {
    await writeFile(project, JSON.stringify({ optchat }));
    assert.throws(() => loadConfig(cwd, true, agent, {}), error => String(error).includes(project));
  }

  await writeFile(project, "{}");

  for (const env of [{ OPTCHAT_BIN: "" }, { OPTCHAT_DIR: " " }, { OPTCHAT_MODEL: "bad" }]) {
    assert.throws(() => loadConfig(cwd, true, agent, env), /environment/);
  }
});

test("pi agent directory override selects the user settings location", async t => {
  const { agent, cwd, global } = await fixture(t);
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;

  try {
    await writeFile(global, JSON.stringify({ optchat: { model: "custom/compact" } }));
    assert.equal(loadConfig(cwd, false, undefined, {}).model, "custom/compact");
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  }
});

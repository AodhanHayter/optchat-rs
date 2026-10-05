import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { Result, Schema, SchemaIssue } from "effect";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface OptChatConfig { bin: string; dir: string; model: string }

const keys = ["bin", "dir", "model"] as const;

function paths(config: Partial<OptChatConfig>, base: string): Partial<OptChatConfig> {
  const result = { ...config };

  for (const key of ["bin", "dir"] as const) {
    const value = result[key];

    if (value === undefined) continue;

    if (value === "~" || value.startsWith("~/")) result[key] = join(homedir(), value.slice(2));
    else if (key === "dir" || isAbsolute(value) || /[\\/]/.test(value)) result[key] = resolve(base, value);
  }

  return result;
}

const Text = Schema.String.check(Schema.isPattern(/^[^\0]*[^\s\0][^\0]*$/));

const ModelId = Schema.String.check(Schema.isPattern(/^[^/\s\0]+\/[^\s\0]+$/));

const OptChatFields = Schema.Struct({
  bin: Schema.optionalKey(Text),
  dir: Schema.optionalKey(Text),
  model: Schema.optionalKey(ModelId),
});

// The outer settings document may carry unrelated pi settings (theme, etc.); only the
// nested `optchat` object is validated strictly, so excess-property rejection is scoped
// to a second decode of just that value instead of the whole document.
const Layer = Schema.Struct({ optchat: Schema.optionalKey(Schema.Unknown) });

type SettingsLayer = ReturnType<SettingsManager["getGlobalSettings"]> | { optchat: Partial<OptChatConfig> };

function fail(source: string, issue: SchemaIssue.Issue): never {
  const [{ path, message }] = SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues;

  throw new Error(`${source}: invalid ${["optchat", ...(path ?? [])].join(".")} (${message}); expected optchat { bin?, dir?, model?: "provider/model-id" }, each a non-empty string without NUL characters`);
}

function parse(layer: SettingsLayer, source: string): Partial<OptChatConfig> {
  const outer = Schema.decodeUnknownResult(Layer)(layer);

  if (Result.isFailure(outer)) fail(source, outer.failure.issue);
  const { optchat } = outer.success;

  if (optchat === undefined) return {};

  const inner = Schema.decodeUnknownResult(OptChatFields)(optchat, { onExcessProperty: "error" });

  if (Result.isFailure(inner)) fail(source, inner.failure.issue);

  return inner.success;
}

/** Use pi's JSON parser and project-trust gating. Resolve each layer before merging. */
export function loadConfig(cwd: string, projectTrusted: boolean, agentDir = getAgentDir(), env: NodeJS.ProcessEnv = process.env): OptChatConfig {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const [error] = settings.drainErrors();

  if (error) throw new Error(`${error.path}: cannot load OptChat settings: ${error.error.message}`);
  const bundled = fileURLToPath(new URL(`../bin/${process.platform}-${process.arch}/optchat${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
  const config: OptChatConfig = { bin: existsSync(bundled) ? bundled : "optchat", dir: join(homedir(), ".local/share/optchat/chat"), model: "anthropic/claude-sonnet-4-5" };

  for (const [layer, base] of [[settings.getGlobalSettings(), resolve(agentDir)], [settings.getProjectSettings(), resolve(cwd, CONFIG_DIR_NAME)]] as const) {
    Object.assign(config, paths(parse(layer, join(base, "settings.json")), base));
  }

  const overrides: Partial<OptChatConfig> = {};

  for (const key of keys) {
    const value = env[`OPTCHAT_${key.toUpperCase()}`];

    if (value !== undefined) overrides[key] = value;
  }

  return { ...config, ...paths(parse({ optchat: overrides }, "environment"), cwd) };
}

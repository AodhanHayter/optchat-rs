# optchat-rs

OptChat is a Rust memory engine with a pi extension, based on [Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).

The engine keeps an append-only chat log and a binary tree of summaries.
A view is a fixed-budget summary of the whole log.
Each new pi turn starts with that view instead of the previous conversation.
The `zoom` tool opens a summary down to the original message. The `date` tool returns its time.

Rust owns storage, tree construction, scheduling, retry feedback, and view rendering.
The pi extension runs the model calls through pi's configured credentials.
It does not need another API key store or a database.

## Build and test

Install [Nix and devenv](https://devenv.sh/getting-started/).
The locked development environment supplies Rust, Cargo, rustfmt, Clippy, rust-analyzer, and Node.js.

From this repository, run:

```sh
devenv shell
cargo build --release
npm ci --ignore-scripts
cargo test
npm run check
npm test
```

`devenv test` runs formatting, Clippy, Rust tests, TypeScript checks, and adapter tests.
Tests use temporary memory directories and fake model responses. They do not use your chats or paid APIs.
The implementation targets Rust 1.89 or later and pi 1.0.2. Development and process-lock tests run on Linux.

## Use with pi

Build the binary before loading the extension.
Start pi from this repository with an explicit binary path:

```sh
OPTCHAT_BIN="$PWD/target/release/optchat" pi -e ./pi/index.ts
```

By default, the extension uses one memory directory across pi sessions.
Set `optchat.dir` in pi settings to select a different chat, or override it for one invocation:

```sh
OPTCHAT_BIN="$PWD/target/release/optchat" \
OPTCHAT_DIR="$HOME/.local/share/optchat/work-chat" \
pi -e ./pi/index.ts
```

Set `optchat.model` in pi settings, or `OPTCHAT_MODEL`, to `provider/model-id` to choose the compactor model.
The default is `anthropic/claude-sonnet-4-5`.
Use a model available through your pi configuration and credentials.
The compactor is the background worker that turns messages into summaries.
It needs a large context window for the default 128,000-byte view.

Do not open the same memory directory from two pi processes.
The second writer fails instead of risking the log.
Use another `OPTCHAT_DIR` for an independent chat.
Close pi before running CLI commands against its active memory directory.
Do not combine this extension with another extension that replaces the whole model conversation.

This command loads the extension for one invocation. It does not change your global pi configuration.
To use `optchat` directly from any directory, run `cargo install --path . --locked` inside `devenv shell`.
Add Cargo's binary directory to your `PATH` if it is not already present.

## Toggle memory and see reads

At the pi prompt, run `/optchat off` before a conversation that you do not want OptChat to save.
Run `/optchat on` to resume memory, or `/optchat` to see its current mode.
Switch only when the agent is idle and its message queue is empty.

While off, OptChat stops its background worker and disables its reads, writes, `zoom`, and `date`.
Pi uses its normal conversation history instead.
After `/optchat on`, OptChat does not copy off-period messages into its log or add them to the next memory context.
Existing memory stays on disk.

This is not a private pi session.
Pi still keeps its session history, and your model provider still receives prompts.
If you quote off-period content in a later on-period message, OptChat saves that new message.
The mode lasts until you change it, restart pi, or reload extensions.
Restart and reload default to on.

The footer shows `OptChat: on` or `OptChat: off`.
During a conversation-view read, `zoom`, or `date`, it shows `OptChat: reading memory` and the operation.
Afterward, it keeps the read count and last operation visible.
A conversation-view read appears as `context` and happens at the start of each on-period turn.
The footer also shows when OptChat waits for summaries or stops with an error.

## Configuration

Put OptChat settings under `optchat` in pi's existing JSON settings files.
The extension uses pi's `SettingsManager` to parse these files and apply project trust.
This follows pi's [configuration hierarchy](https://pi.dev/docs/latest/configuration) and the namespaced settings pattern in [pi-subagents](https://github.com/nicobailon/pi-subagents/blob/main/docs/configuration.md).

Settings apply in this order, from lowest to highest priority:

1. Built-in defaults.
2. User settings in `~/.pi/agent/settings.json`. `PI_CODING_AGENT_DIR` changes the agent directory.
3. Trusted project settings in `<working-directory>/.pi/settings.json`.
4. `OPTCHAT_BIN`, `OPTCHAT_DIR`, and `OPTCHAT_MODEL` environment variables.

Each field overrides only that field. No parent-directory search occurs.
Pi asks for project trust when it finds `.pi/settings.json`.
If you decline trust, OptChat does not read the project file.
For unattended runs, use pi's `--approve` to allow project settings or `--no-approve` to skip them.

For this repository, merge this section into `.pi/settings.json`:

```json
{
  "optchat": {
    "bin": "../target/release/optchat",
    "dir": "../.optchat",
    "model": "anthropic/claude-sonnet-4-5"
  }
}
```

Build the binary, then run `pi -e ./pi/index.ts` from the repository root.
Do not replace existing settings or commit the `.optchat/` memory directory. It can contain private conversation data.

All three fields are optional non-empty strings:

- `bin`: Binary path or executable name. Default: `optchat` on `PATH`.
- `dir`: Memory directory. Default: `~/.local/share/optchat/chat`.
- `model`: Summary model in `provider/model-id` form. Default: `anthropic/claude-sonnet-4-5`.

Relative file paths resolve from the directory containing their settings file.
Thus `../.optchat` in project settings selects `<working-directory>/.optchat`.
Relative environment paths resolve from the working directory.
Paths support `~` and `~/`. A bare binary name uses `PATH` rather than a settings-relative path.
Credentials stay in pi's configuration. `model` does not change pi's main model.

Restart pi after changes. The extension holds its configuration until shutdown and releases its writer lock while off.
Malformed settings files, unknown `optchat` fields, and invalid values stop OptChat instead of selecting a different memory directory.
The Rust CLI does not read pi settings. Pass its directory with `--dir` or `OPTCHAT_DIR`.

## Call the binary

The default CLI directory is `./chat`. Use `--dir` or `OPTCHAT_DIR` to select another directory.
These examples use a separate test chat:

```sh
optchat --dir /tmp/optchat-example append user 'Prefer Rust and small changes.'
optchat --dir /tmp/optchat-example append talk 'I will use Rust.'
optchat --dir /tmp/optchat-example view
optchat --dir /tmp/optchat-example zoom 0 2
optchat --dir /tmp/optchat-example zoom 0 1
optchat --dir /tmp/optchat-example date 0
optchat --dir /tmp/optchat-example status
optchat --dir /tmp/optchat-example export /tmp/optchat-example.html
```

Export refuses to overwrite an existing file.
`append KIND` without text reads all of stdin.
For long messages, the CLI stores the complete text but needs model-generated summaries before `view` succeeds.
`view --display` shows pending markers for human inspection. Do not send those markers to a model.

For programmatic use, run `optchat --dir PATH serve`.
It accepts newline-delimited JSON and holds the writer lock for its lifetime.
The [protocol reference](docs/protocol.md) describes every action and the compactor loop.

## Import and backup

`optchat --dir PATH import FILE` reads JSONL message records.
Each record contains `i`, `kind`, `text`, `size`, and an RFC3339 `date`.
Ids must continue the existing log without gaps. `size` counts UTF-8 bytes of `kind + ": " + text`.
Use kind `note` for older memories. Import preserves the supplied text and dates.
Existing pi sessions are not imported automatically.

Every accepted message and summary is written and synchronized to disk before the operation returns.
Back up the whole memory directory, including both `main/` and `tree/`.
Stop pi before copying it for a consistent backup.
Keep backups private because the log can contain source code, tool output, and secrets from your conversations.
There is no automatic git commit or remote backup.

At startup, the engine reports and skips malformed JSON lines.
It adds a missing final newline without changing old bytes.
It rebuilds invalid tree records. Tree records load by level, so a clock that moved backwards across midnight does not orphan a parent.
When one node was saved twice, the latest valid record wins.
A gap in message ids stops startup because renumbering would change history.
Restore damaged message logs from a backup.
If a write fails, the engine rejects further writes until restart.

## Design and limits

The implementation follows the specification's pure binary tree, free short nodes, 512-byte summary target, and 128,000-byte view budget.
It schedules at most eight model jobs, tries up to five summaries per node, and retries failures after ten seconds.
The view only appends and merges while the process runs. It never splits an old summary.
Restart rebuilds the view with the specification's append-and-fit replay, which can change the exact tiling when summaries originally arrived late.

A few choices differ from the reference harness:

- The engine uses the standard library's operating-system file lock instead of a Unix socket. A crash releases the lock without stale-file deletion.
- Pi retains its own session files and UI. The adapter replaces model context, not pi's visible transcript.
- Model access stays in pi so existing providers and credentials remain usable. Rust supplies the compactor prompts and validates every reply.
- The extension stays inactive in `pi-subagents` child processes. Only reports delivered to the parent enter its memory, not child tool loops.
- Tree scans are linear per pump. Very large histories need an indexed ready queue if measured latency becomes a problem.

The summary target is not a hard bound. After five attempts, Rust keeps the shortest reply and measures its actual size.
The view can temporarily exceed its budget while parent summaries are pending.
Tool results keep at most 30,000 Unicode characters, with their head, tail, and an omission notice.
`zoom` and `date` results reach the model whole, so `zoom(id, 1)` returns the complete message. Their log copies are capped like other tool results.
Nested tool calls made by other tools, for example from codemode scripts, are logged as `tool` and `echo` entries too.
Messages you queue while the agent works are written to the log when you send them, before delivery.
If you cancel the run and pi discards its queue, the log still has them.
Assistant messages that ended in a provider error are not logged. Pi retries them, and the retry's reply is logged.
Reasoning is not written to the memory log. Native reasoning signatures remain intact inside the current tool loop.
Image attachments remain available in the current turn and pi's session files, but this text-only memory does not archive image data.

Anthropic requests use up to three view cache marks plus the automatic request-end mark, all with short retention.
`node tests/live-cache-probe.ts` sends two small paid requests and fails unless the second request reads the view from the cache.
OpenAI Responses models that support explicit prompt cache breakpoints get the same view breakpoints and `reasoning.context: "all_turns"`.
Other providers use pi's native request conversion and caching.
While on, the adapter disables pi's compaction and idle cache-warming calls.
It freezes pi's memory system prompt for the session. Explicit tool changes can still invalidate the cache.

The current tests prove protocol and context behavior with deterministic model responses.
They do not prove summary quality. The live probe above is the only paid check, and it covers Anthropic only.
The optional remote terminal, computer-use service, and custom subagent harness from the gist are not part of this package.

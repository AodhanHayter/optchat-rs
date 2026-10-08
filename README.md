# optchat-rs

OptChat is a Rust memory engine with a pi extension, based on [Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).

The engine keeps an append-only chat log and a binary tree of summaries.
A view is a fixed-budget summary of the whole log.
Each new pi turn starts with that view instead of the previous conversation.
The `zoom` tool opens a summary down to the original message. The `date` tool returns its time.

Rust owns storage, tree construction, scheduling, retry feedback, and view rendering.
The pi extension runs the model calls through pi's configured credentials.
It does not need another API key store or a database.
The extension uses [Effect](https://effect.website/) 4 for configuration validation, error handling, and background work.
Closing the extension cancels model calls and retry waits before closing the Rust process.
Effect is installed as a runtime dependency. Pi supplies the pi SDK and TypeBox tool schemas.

## Install the pi extension

For a published release, install the package and restart pi:

```sh
pi install npm:pi-optchat-rs
```

The npm package includes Rust binaries for Linux, macOS, and Windows, on x64 and ARM64.
You do not need Cargo, a separate binary download, or npm install scripts.
The extension selects the binary for the architecture of the Node.js process running pi.
Use Node.js 22.19 or later and pi 1.0.2 or later. The adapter is tested against pi 1.0.2.
Linux binaries require glibc 2.35 or later, such as Ubuntu 22.04. Alpine Linux is not supported by these binaries.
The macOS binaries target macOS 11 or later. Windows binaries use MSVC with a statically linked C runtime.

OptChat saves messages by default. Read [Toggle memory and see reads](#toggle-memory-and-see-reads) before using it with private content.
Choose a compactor model available through your pi credentials, as described in [Use with pi](#use-with-pi).
For an unreleased checkout, build from source using the instructions below.
Maintainers can follow the [release procedure](docs/releasing.md).

## Build and test

Install [Nix and devenv](https://devenv.sh/getting-started/).
The locked development environment supplies Rust, Cargo, rustfmt, Clippy, rust-analyzer, Node.js, pnpm, and TypeScript tools.

From this repository, run:

```sh
devenv shell
cargo build --release
pnpm install --frozen-lockfile --ignore-scripts
cargo test
lint
typecheck
pnpm test
```

Dependency installation is explicit, not automatic on shell entry. Use pnpm to update dependencies and commit `pnpm-lock.yaml`.
The shell commands `lint`, `lint-fix`, and `typecheck` work from any project subdirectory and accept extra arguments.
TypeScript checks use the compiler pinned in `package.json`.

`devenv test` installs the locked dependencies with lifecycle scripts disabled, then runs lint, TypeScript checks, and adapter tests.
It also runs Rust formatting, Clippy, and Rust tests.
Tests use temporary memory directories and fake model responses. They do not use your chats or paid APIs.
The implementation targets Rust 1.89 or later and pi 1.0.2.
GitHub Actions runs Rust tests and installed-package smoke tests on all six release platforms.
Run `cargo bench --locked --bench history` for large-history benchmarks. See [benchmark workloads and results](docs/benchmarks.md).

## Use with pi

The npm installation uses its bundled binary. You do not need to set `OPTCHAT_BIN`.
For source development, build the binary and start pi from this repository with an explicit path:

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
The default is `anthropic/claude-haiku-4-5`.
Use a model available through your pi configuration and credentials.
The compactor is the background worker that turns messages into summaries.
The design uses Claude Haiku at the highest effort the model supports. Each compaction reads a 16-32 KB view.

Do not open the same memory directory from two pi processes.
The second writer fails instead of risking the log.
Use another `OPTCHAT_DIR` for an independent chat.
Close pi before running CLI commands against its active memory directory.
Do not combine this extension with another extension that replaces the whole model conversation.

The source command using `pi -e` loads the extension for one invocation. It does not change your global pi configuration.
The `pi install` command saves the npm package in your pi configuration.
To use `optchat` directly from any directory, run `cargo install --path . --locked` inside `devenv shell`.
Add Cargo's binary directory to your `PATH` if it is not already present.

## Toggle memory and see reads

At the pi prompt, run `/optchat off` before a conversation that you do not want OptChat to save.
Run `/optchat on` to resume memory, or `/optchat` to see its current mode.
Switch only when the agent is idle and its message queue is empty.

While off, OptChat stops its background worker and disables its reads, writes, `zoom`, `date`, and `memory_search`.
Pi uses its normal conversation history instead.
After `/optchat on`, OptChat does not copy off-period messages into its log or add them to the next memory context.
Existing memory stays on disk.

This is not a private pi session.
Pi still keeps its session history, and your model provider still receives prompts.
If you quote off-period content in a later on-period message, OptChat saves that new message.
The mode lasts until you change it, restart pi, or reload extensions.
Restart and reload default to on.

The footer shows `OptChat: on` or `OptChat: off`.
During a conversation-view read, `zoom`, `date`, or `memory_search`, it shows `OptChat: reading memory` and the operation.
Afterward, it keeps the read count and last operation visible.
A conversation-view read appears as `context` and happens at the start of each on-period turn.
The footer also shows when OptChat waits for summaries or stops with an error.

## Inspect status and compactor usage

While OptChat is on, run these commands in Pi:

```text
/optchat status
/optchat usage
```

`status` shows the store path, message count, view size and budget, pending jobs, active provider attempts, and retries awaiting cooldown.
`usage` shows compactor totals across sessions in this store, including every provider attempt and corrective retry.
It reports token counts, cache reads/writes, summed request duration, and estimated USD cost. Concurrent request durations overlap, so their sum is not elapsed time.
Both commands use the existing memory process. Neither calls a provider. When OptChat is off, both refuse without starting a writer.
Without a terminal UI, output goes to stderr.

The private, append-only ledger is `compactor-usage.jsonl` inside the memory directory, separate from model memory.
It stores session and attempt IDs, provider/model, summary job coordinates, timing, outcomes, tokens, and estimated cost.
It does not store prompts, response text, or credentials. Unix file permissions are `0600`. Windows access depends on directory permissions.
Old attempts from before this feature are unavailable. Main-agent usage remains Pi's responsibility.

Unknown usage or pricing is not free. The report separates known cost from unpriced attempts and retains token counts when cost is unavailable.
Malformed records produce `file:line` warnings and incomplete totals. Repeated attempt IDs count once.
A ledger write failure warns without stopping chat. Shutdown drains queued records, but writes do not use `fsync`, so power loss can lose recent measurements.
The report scans the ledger on demand without retaining every record. It keeps attempt IDs for deduplication and displays at most 20 warnings.
It does not rotate or truncate the file.

## Search original messages

To expose `memory_search` to the model, merge this into your pi settings and restart pi:

```json
{"optchat":{"search":true}}
```

Search is off by default. It searches original user, assistant, and note text, not summaries.
The model can set `include_tools: true` to also search tool calls and results.
Results contain up to 20 matches, newest first, with IDs, dates, short snippets, and their current covering view lines.
Pass `next_before` as `before` for the next page. A null cursor means no older matches remain.
Use `zoom(id, 1)` to read an entire original message.

Queries are literal, with ASCII case-insensitive matching and exact non-ASCII matching. There is no regex or Unicode normalization.
The query must contain 1–256 UTF-8 bytes and cannot contain NUL or only whitespace.
Search works while summaries are pending. It scans stored text without an index.
If you use pi's explicit tool allowlist, include `memory_search` to expose it to the model.
See the [search protocol](docs/protocol.md#search) for bounds and error behavior.

## Browse a memory snapshot

Keep snapshots private. Each file contains all saved original text and summaries, including tool records.
While OptChat is on, run this at the pi prompt:

```text
/optchat browse memory.html
```

Open the reported file in your browser. The command does not launch a browser or a second memory process.
The locked Rust process streams the snapshot to disk. Pi receives only the path, not the full HTML document.
Other memory requests wait until the export finishes. Streaming does not change the saved history or avoid parsing it in the browser.
Relative paths use pi's working directory. `~/` and paths with spaces work. The parent directory must exist.
The command refuses existing files and symlinks. New files use mode `0600` on Unix.
After a write failure, a partial file can remain. Inspect it before removing it or choosing another destination.
While OptChat is off, the command refuses without starting a process.

The snapshot shows the model view and a tree that expands from summaries to exact original text.
Missing summaries are marked as pending. Use Tab and Enter to navigate and expand the tree.
Search works offline without enabling the model's `memory_search` tool. It retains one page of up to 20 results.
Search matches literal text with ASCII case folding, with an option to include tool records.
Use **Show older results** for the next page and **Reveal original and its summaries** to open a result in the tree.

Snapshots contain no external assets and make no network requests. Editing a snapshot does not change saved memory.
They do not update when new messages arrive. Generate another file for a newer snapshot.
Lazy tree expansion limits visible elements, but the browser still loads all embedded data.
After parsing, it releases duplicate summary-entry arrays. Original text remains available for search, expansion, and saving the page.
A measured 100k-message snapshot was about 211 MiB. See [export measurements](docs/benchmarks.md#export-measurements) before exporting large histories.
With pi closed, `optchat --dir PATH export memory.html` produces the same snapshot through the CLI.

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
    "model": "anthropic/claude-haiku-4-5"
  }
}
```

Build the binary, then run `pi -e ./pi/index.ts` from the repository root.
Do not replace existing settings or commit the `.optchat/` memory directory. It can contain private conversation data.

All fields are optional. `bin`, `dir`, and `model` must be non-empty strings:

- `bin`: Binary path or executable name. Default: the bundled binary for your platform. Source checkouts without a bundled binary use `optchat` on `PATH`.
- `dir`: Memory directory. Default: `~/.local/share/optchat/chat`.
- `model`: Summary model in `provider/model-id` form. Default: `anthropic/claude-haiku-4-5`.
- `search`: Boolean that exposes `memory_search`. Default: `false`. No environment override.

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
optchat --dir /tmp/optchat-example search Rust
optchat --dir /tmp/optchat-example search Rust --before 1 --include-tools
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
On Unix, the engine also synchronizes directory entries. Windows has no equivalent directory synchronization in this implementation.
A Windows power loss can therefore lose newly created files or directories even after file contents were synchronized.
On Windows, files inherit directory permissions. Store memories in a private user directory.
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

The implementation follows the [current OptChat design](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) (revision `3c190e0`). [docs/gist-v3-alignment.md](docs/gist-v3-alignment.md) lists what changed from the first revision.

- The tree is purely binary, with free short nodes and a 512-byte summary target.
- Each message appends one view line. Past 128,000 bytes, one batch merges the most due pairs down to 64,000 bytes. A pair is due by how long ago it ended, in its own line size. This reproduces Taelin's rollback push.
- The view is saved to `view.json` and loaded at start. It never splits an old summary, and a restart does not rebuild it.
- Compactions see the chat view merged further, to 16-32 KB. They use the same system prompt and tools as turns.
- At most eight model jobs run at once. Each node gets up to five tries, and a failed call is tried again at the next message.
- A text over 30,000 characters, other than a tool result, is logged whole as several messages in a row.

A few choices differ from the reference harness:

- The engine uses the standard library's operating-system file lock instead of a Unix socket. A crash releases the lock without stale-file deletion.
- Pi retains its own session files and UI. The adapter replaces model context, not pi's visible transcript.
- Model access stays in pi so existing providers and credentials remain usable. Rust supplies the compactor prompts and validates every reply.
- The extension stays inactive in `pi-subagents` child processes. Only reports delivered to the parent enter its memory, not child tool loops.
- Agent replies keep the log kind `talk`, the name the existing logs use. The design names that kind after the agent.
- The prompt leaves out `zoom("Name")` and the device paragraph. This package has no subagent chat logs or device tools.
- With `optchat.search` on, the prompt allows `memory_search` to find lines to zoom. Without it, the design's "zoom only" rule stands.

The summary target is not a hard bound. After five attempts, Rust keeps the shortest reply and measures its actual size.
The view can temporarily exceed its budget while parent summaries are pending.
Tool results keep at most 30,000 Unicode characters, with their head, tail, and an omission notice.
`zoom`, `date`, and bounded `memory_search` results reach the model whole, so `zoom(id, 1)` returns the complete message. Their log copies are capped like other tool results.
Messages from other extensions, such as subagent reports, are logged as `work`, not as the user's words.
Nested tool calls made by other tools, for example from codemode scripts, are logged as `tool` and `echo` entries too.
Messages you queue while the agent works are written to the log when you send them, before delivery.
If you cancel the run and pi discards its queue, the log still has them.
Assistant messages that ended in a provider error are not logged. Pi retries them, and the retry's reply is logged.
Reasoning is not written to the memory log. Native reasoning signatures remain intact inside the current tool loop.
Image attachments remain available in the current turn and pi's session files, but this text-only memory does not archive image data.
OptChat records one text notice per image, including image-only messages and tool results. It does not store image bytes or metadata.

The view goes in blocks of four lines. Anthropic requests mark the last whole block plus the automatic request end, all with short retention.
A compaction whose marked prefix another compaction is writing waits until that call's response starts.
`node tests/live-cache-probe.ts` sends two small paid requests and fails unless the second request reads the view from the cache.
OpenAI Responses models that support explicit prompt cache breakpoints get the same view breakpoints and `reasoning.context: "all_turns"`.
Other providers use pi's native request conversion and caching.
While on, the adapter disables pi's compaction and idle cache-warming calls.
It freezes pi's memory system prompt for the session. Explicit tool changes can still invalidate the cache.

The current tests prove protocol and context behavior with deterministic model responses.
They do not prove summary quality. The live probe above is the only paid check, and it covers Anthropic only.
The optional remote terminal, computer-use service, and custom subagent harness from the gist are not part of this package.

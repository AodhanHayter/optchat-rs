# Alignment with the current OptChat design

This project began from the first revision of Victor Taelin's
[OptChat gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
(`26ad107`, 2026-10-04). Revision `f51fe5c` changed only the title.
Revision `3c190e0` (2026-10-08) rewrote the design and corrected several
mistakes in it. This page lists each difference from that revision, and what
the code does now.

## Changes made

| Design (revision `3c190e0`) | Before | Now |
|---|---|---|
| A pair is due by `(T - last) / 2^l`, measured from its **last** message | Measured from its first message, the bug the gist names | `last` rule. A test checks that it picks exactly the merges of Taelin's rollback `push` at every step, t = 0 to 20,000. The old rule fails at t = 9 |
| Batch merges: past 128 KB, merge down to 64 KB at once; if parents are missing, continue at each new message | Merged at every message and at every saved node, to stay under 128 KB | Sawtooth between 64 KB and 128 KB. Merges happen only when a message is appended |
| Save the view to `view.json`; never rebuild it from the log | Rebuilt by replay at every start | Saved atomically after every merge, loaded at start. A missing or invalid file is reported, with its path and line, and folded once |
| Compactions see the chat view merged further, to 16-32 KB, with the same sawtooth | Saw the full 128 KB chat view | A second view, derived from the chat view at each chat batch, holds `budget/8` to `budget/4` bytes |
| A compaction's view stops at its node and at the first unbuilt line | Skipped unbuilt lines and kept going | Stops at the first unbuilt line |
| One system prompt for turns and compactions, with the same tools, never called | Separate compactor prompt, no tools | One prompt (`prompts/system.txt`). The driver sends the turns' system prompt and active tools with tool choice `none` |
| Task text verbatim: message or line ids, a ruler of 512 dashes, `<input>` tags | No ids, a 512-byte sample line as the scale | Verbatim task and "Too long" feedback |
| A message's node starts once fewer than 8 lines before it are unbuilt; a merge once both halves are built | Only the first unbuilt message, and merges only up to it | Both rules, still from queues |
| A failed call is tried again at the next message | Retried after 10 seconds | Retried at the next message. The 10-second timer stays as a fallback, so a turn that waits for summaries cannot hang |
| View cache blocks of 4 lines; one mark on the last whole block, one on the request end | Marks at 50,000, 80,000 and 100,000 characters | 4-line blocks, one mark |
| A call whose marked prefix another call is writing waits until that call's response starts | Up to 8 calls wrote the same prefix | The driver holds later calls until the writer's response starts |
| Kind `work` for an agent's report | Reports logged as `user` | Extension messages, such as subagent reports, are logged as `work` |
| Long non-tool text is never cut; it is logged as several messages in a row | Logged as one message of any size | Split into messages of at most 30,000 characters. Tool results are still clipped to head and tail |
| Compactor model: a cheap one, Claude Haiku at xhigh effort | Claude Sonnet 4.5 at medium effort | Default `anthropic/claude-haiku-4-5`, effort `xhigh`. Pi clamps the effort to what the model supports |

## Intended differences

- **Reply kind `talk`.** The design names the reply kind after the agent
  (`unii`). The log is append-only and already holds `talk` records, so the
  kind keeps that name, and the prompt describes it.
- **Prompt lines left out.** `zoom("Name")` and the paragraph about devices are
  not in the prompt. This package has no subagent chat logs and no device
  tools. The prompt also says `zoom(id, 1)` gives the message whole, without
  "with its images", because memory stores a notice in place of image bytes.
- **`memory_search`.** The design forbids searching memory. Search stays off
  by default. When `optchat.search` is on, the prompt says that
  `memory_search` only finds lines to zoom.
- **Imports keep one record per message.** Import must keep the supplied ids,
  so it does not split long text.
- **One chat per project by default.** The design keeps one chat for
  everything. The default memory directory is
  `~/.local/share/optchat/--<working-directory>--`, so separate projects run
  in parallel. Setting a fixed `optchat.dir` in user settings restores one
  chat. Two sessions on one directory still collide on the writer lock.
- **Shared cache across models.** Turns and compactions share a cache prefix
  only when they use the same model. With a cheaper compactor model, the
  compactions still share their prefix with each other.

## Verification

- `devenv test`: `cargo fmt --check`, clippy with `-D warnings`, the Rust tests,
  oxlint, `tsc`, and the Node tests all pass.
- New tests cover the `push` equivalence, the sawtooth, the compaction view,
  restart from `view.json`, invalid `view.json` files, crash recovery after a
  log write, splitting long text, the `work` kind, the 8-message window,
  retry at the next message, the verbatim task, the 4-line cache blocks, and
  the wait for a prefix writer.
- `cargo bench --bench history` at 100,000 messages: `memory_open` 352 ms
  (395 ms before), `append` about 13 ms (19 ms before).

Not verified: summary quality and real cache hit rates with a paid model.
`tests/live-cache-probe.ts` is the paid check for cache reads.
`scripts/compare-engines.mjs` compares this engine with the pre-change
baseline. Its replies now differ by design, so it no longer applies to this
change.

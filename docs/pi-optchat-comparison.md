# Comparison and implementation plan

Status: package published as `@aodhanhayter/pi-optchat-rs`. Phases 1, 2, and 3a (status and usage) are implemented on `feat/memory-retrieval`. Cache experiments and imports remain proposed. Reviewed on 2026-10-06.

Phase 1 passed 26 Rust tests, 36 Node tests, lint/type checks, and Rust 1.89 tests and Clippy.
An adversarial review found three issues. Regression tests reproduced them, fixes passed, and focused re-review approved the changes.
See the [search protocol](protocol.md#search) and [search measurements](benchmarks.md#search-measurements). Cross-platform execution remains a CI check.

Compare our commit `6344598` with [jonaslsaa/pi-optchat at `e4af09a`][upstream].
This review used source code, tests, package metadata, and the npm registry.
The other project's tests and live provider behavior were not run.

Keep our Rust engine and Effect lifecycle management. Adopt useful memory features, not a second agent framework.
The recommended order is package naming, retrieval, inspection, compactor measurements, then imports.
Profiles and previous-exchange replay are separate, deferred choices.

## Package name

Our npm package is now the scoped `@aodhanhayter/pi-optchat-rs`. Install it with `pi install npm:@aodhanhayter/pi-optchat-rs` once published.
The previous name, `pi-optchat`, belongs to the other project. The registry reports version `0.7.0`, matching its [package metadata][package].
The registry returned 404 for `pi-optchat-rs` on 2026-10-06. This does not reserve the name or guarantee publishing permission.
Keep the Rust executable named `optchat` and the `/optchat` command unchanged.
Do not load both extensions in one Pi session because their tools and context handlers overlap.

The registry observation is reproducible with:

```bash
npm view pi-optchat name version repository.url --json
```

## What adds value

| Addition | Other project's implementation | Our behavior at comparison base | Decision |
| --- | --- | --- | --- |
| Search original messages | Literal, case-insensitive search, newest first, 20-hit pages, snippets, and the covering summary range. [Source][search] | `zoom` and `date` require a known ID. | High value. Build a bounded Rust search, not its all-hits collection. |
| Inspect the summary tree | Offline HTML with expandable summaries, original messages, search, and a view-shape diagram. [Source][browser] | HTML export lists the view, originals, and levels separately. | High value. Extend our exporter, without a server or UI framework. |
| Compactor usage and cache coordination | A durable usage ledger and one initial request per cold Anthropic prefix. [Usage][usage], [compactor][compactor] | Cache breakpoints exist, but no usage ledger or coordination between parallel requests. | High value. Measure first, then add the cache gate if useful. |
| Import external histories | Claude Code, Codex, ChatGPT, and Claude memories. Preview, stable identities, resumable staging, and activation after summarization. [Sources][import-sources], [staging][import-job] | Native JSONL import preserves text and dates, but has no source adapters or deduplication. | Valuable, largest change. Add one format first. |
| Named profiles | Global memories, profile instructions, model settings, selection, and session switching. [Source][profiles] | `optchat.dir` already selects an independent store. No picker or named profiles. | Defer. Directory selection already provides isolation. |
| Previous-exchange replay | Includes the last successful request/answer, up to 16 KB by default. [Source][transcript] | Completed turns leave the native model context. Recall uses the memory view and `zoom`. | Experiment only. It changes context size, privacy boundaries, and cache behavior. |
| Attachment notices | Records that an image existed without storing image bytes. [Source][transcript] | Images stay in the current turn and Pi session, but `textOf` omits them from memory. | Small useful addition alongside retrieval. |

Our comparison points are [the engine](../src/lib.rs), [protocol and HTML exporter](../src/protocol.rs),
[Pi context hooks](../pi/index.ts), [driver](../pi/memory.ts), and [configuration](../pi/config.ts).
Our [documented limits](../README.md#design-and-limits) already cover many shared features.
Cache breakpoints, bounded tool output, background summaries, durable writes, and configurable model selection are not new additions.

## Implementation sequence

Each phase is a separate reviewable change. Do not add a dependency unless the existing libraries cannot meet a measured need.
Keep JSONL message records as the source of truth. Never regenerate original text from summaries.
Use the existing 1k, 10k, and 100k fixtures to measure changes that scan or export history.

### Phase 0: resolve the package name

Chosen name: `pi-optchat-rs`. Updated `package.json`, release artifact paths, installation instructions, release instructions, and installed-package smoke test paths.
The Rust crate and executable remain unchanged.
Configure npm publishing for the new name only after account ownership is established.

Acceptance: packing produces the expected filename, the installed extension loads, and workflow validation passes.
Search for unintended old installation and artifact references.
Nothing in this phase publishes a package or creates a release tag.

### Phase 1: bounded memory retrieval

Implemented. The requirements below describe the delivered scope.
Matching folds ASCII case only. Queries allow 1–256 UTF-8 bytes, snippets allow 240 bytes, and serialized result pages allow 32,768 bytes.
An individually oversized hit returns an error naming the message ID. It never silently disappears from pagination.

Add a `search` RPC and Rust CLI subcommand, backed by the loaded original records.
Expose it in Pi as `memory_search` to avoid the generic `search` name used by other tools.
Make model exposure opt-in with `optchat.search`, defaulting to false, so the existing zoom/date contract remains unchanged.
CLI search remains available without enabling the model tool.

Define the initial contract before coding:

1. Match literal text, not regex or semantic similarity. Specify case matching explicitly and test non-ASCII text.
2. Return at most 20 hits, newest ID first, with an exclusive `before` cursor for older results.
3. Include each ID, date, kind, bounded snippet, and the current covering summary range when available.
4. Return a continuation cursor, not a total-hit count. Stop after one extra hit rather than collecting every match.
5. Search `user`, `talk`, and `note` by default. An explicit option includes `tool` and `echo` records.
6. Bound query length and serialized response size. Never cut inside a UTF-8 character. Leave originals unchanged.

The default kinds avoid most retrieved-text duplicates. Our echoes do not reliably carry the tool-name prefix used by their exclusion heuristic.
Do not copy that heuristic and claim it removes all duplicates. Tool-inclusive search can contain repeated retrieved text.
Use the Rust library, protocol, CLI, and existing Pi read wrapper. No search database or persistent index in the first version.
Search must work during pending compaction because it reads originals, not a settled model view.

Add a separate recorded-text path for image notices. Do not modify image blocks sent to the current provider request.
A notice states that Pi's session retains the attachment but OptChat text memory does not retain its bytes.
Do not add OCR, automatic captions, or image storage.

Acceptance: test pagination during appends, empty and invalid queries, multiline matches, Unicode boundaries, role filtering, and unsummarized messages.
Test disabled/off behavior and interactions with other tool names through the real Pi SDK.
Test image-only input and queued images without duplicate logging.
Benchmark common hits, rare hits, and misses at all three history sizes. A miss can still require a full scan.
Do not add an index until those measurements justify one.

### Phase 2: inspect memory without a server

Extend `optchat export` into a self-contained, read-only HTML snapshot.
Start with the actual view. Let readers open each summary into its children, down to the original records.
Link search hits to their IDs and containing summaries. Show pending nodes explicitly.
Use lazy DOM creation, meaning elements appear only when opened, instead of rendering 100k messages immediately.

Add `/optchat browse` through the existing Rust process and export RPC.
Do not launch a second writer against the active memory directory.
Write a private snapshot to an explicit destination and report its path. Opening a browser is optional.
Keep the no-overwrite behavior unless the user explicitly requests replacement.

Acceptance: test HTML and script escaping, malicious message text, non-ASCII content, unfinished summaries, and exact original text.
The page must make no network requests and must not execute text from history.
Test keyboard operation and expansion/search in a browser.
Measure export size, generation time, initial load, and search responsiveness at 100k messages.
Lazy DOM creation does not reduce the embedded data size. Report that limit rather than hiding it.
Generate snapshots on request, never on every message.

Phase 2 is implemented with the existing export RPC and `/optchat browse PATH`.
Adversarial review found unsafe failed-write cleanup, accumulated search results, and split Unicode snippets. All three have passing regressions and approved fixes.
The integrated suite passes 29 Rust tests, 39 Node tests, lint/types, and Rust 1.89 tests and Clippy.
Chromium checks cover 100k messages, offline search, exact originals, pagination, and keyboard expansion.
See [snapshot usage](../README.md#browse-a-memory-snapshot) and [export measurements](benchmarks.md#export-measurements).
Cross-platform execution and other browsers remain unverified locally.

### Phase 3: measure compactor cost, then coordinate cache use

Phase 3a is implemented: `/optchat status`, `/optchat usage`, and a private compactor ledger.
Adversarial review found seven issues in ownership, file safety, pricing, and failure reporting. Regressions cover the fixes, including a shutdown race found during re-review.
The final re-review approved integration. The integrated suite passes 29 Rust tests, 60 Node tests, lint, and type checks.
Windows runtime checks remain for CI. No paid provider calls ran, and cache behavior is unchanged.
See [status and usage](../README.md#inspect-status-and-compactor-usage) for accounting limits and file behavior.
The requirements below retain the delivered scope and proposed experiments.

First add `/optchat status` with store path, message count, view bytes, active jobs, and retry state.
Reuse the Rust `status` RPC where possible. Extend it only for missing fields.
Add `/optchat usage` for compactor token counts, cache reads/writes, request duration, retry count, and estimated API cost.
Count every provider attempt, including oversized-summary retries, not only accepted summaries.
Pi already reports main-agent usage, so leave cross-agent accounting and a custom usage inspector out of this phase.

Persist compactor measurements in a private, append-only file outside model memory.
Include the session, provider/model, job key, and attempt identity. Do not store prompts, credentials, or response text there.
Unavailable pricing must show as unknown, not free. A telemetry write failure reports a warning without losing chat data.
Malformed telemetry reports its file and line, and marks totals incomplete.

Then compare concurrent cold-cache compaction with and without a cache gate.
Their gate starts one request for a shared Anthropic prefix, then releases peers when the response begins. [Source and tests][compactor-tests]
Implement any adopted gate with our existing Effect scopes and deferred values.
Keep it local to one driver and key it by the actual cached prefix, model, and request settings.
Cancellation, failure, expiry, and shutdown must release or interrupt every waiter.
Do not serialize unrelated prefixes or providers.

Also test their explicit SSE transport and shared compactor cache key against our Pi SDK's OpenAI Responses path.
Treat this as a compatibility experiment, not a confirmed defect or guaranteed cost saving.
Do not add a global shared session key without testing separation between concurrent histories.

Acceptance: deterministic stream tests cover warm/cold prefixes, retries, failures, cancellation, and shutdown.
Restart does not duplicate persisted usage. Status and usage work without a terminal UI.
Any paid provider comparison requires separate approval. Record both token costs and turn latency before enabling a gate by default.
Our existing paid cache probe alone does not demonstrate parallel-cache savings.

### Phase 4: safe external-history import

Start with Codex JSONL as one proposed source, followed by Claude Code conversations and memory notes.
Add ChatGPT JSON and ZIP only after the import contract is stable.
Use Node's existing file, JSON, readline, and crypto APIs for source conversion, and Rust for durable memory writes.
Do not introduce a generic parser framework or archive dependency for the first source.
Keep the existing native `import FILE` interface intact.

Deliver the first source in two changes:

1. Build a read-only scanner and preview. Show source paths, message counts, dates, duplicate counts, exclusions, and estimated text volume.
2. Add resumable application under the memory writer lock, with durable staging and an explicit activation step.

Preserve existing internal IDs, dates, and text. External IDs can overlap between systems, so store them as source metadata alongside new internal IDs.
Keep source timestamps verbatim in metadata when normalization is needed. Missing or invalid dates require an explicit policy, not a silent current-time substitution.
Add optional provenance and receipt fields with defaults for old records. A receipt is a stable identity used to skip repeated imports.
Do not promise that old binaries can read records containing new fields. Document the migration and rollback boundary.

Archive source bytes privately before applying extraction rules. Unsupported records and excluded tool/commentary text remain in that archive.
Reference it from an import manifest. Every parse warning names its source file and line, or JSON path for non-JSONL input.
Do not include secrets or private transcripts in repository fixtures.
Re-importing an unchanged source adds nothing. An edited source message becomes a new historical version, not an overwrite.

Borrow their staged-generation approach: build beside the active memory, preserve old summaries for append mode, and activate only when ready.
Keep the previous generation intact. Define pointer replacement, locking, and recovery on Linux, macOS, and Windows before implementation.
Block chat in that store during import. Resume must reuse completed summaries rather than repeat paid work.
Mark imported content as historical when building prompts without rewriting its stored original text.

Do not adopt chronological rebuild. Their [implementation][import-job] assigns fresh indices after sorting and regenerates the summary tree.
That conflicts with stable existing IDs and makes old references ambiguous.
Append new imports instead, even when their dates precede existing messages.

Acceptance: repeat import, moved source files, edited messages, malformed records, duplicate external IDs, and missing dates have explicit tests.
Inject failure before and after durable writes, summary completion, activation, and cleanup.
Resume must neither duplicate messages nor alter the prior generation.
`zoom` must still return prior messages unchanged. Source files must remain byte-for-byte unchanged.
Preview performs no model calls. Applying summaries requires explicit confirmation after displaying the estimate.

## Deferred choices

Named profiles become useful when switching directories manually becomes a repeated problem.
If added, resolve a name to a store directory first. Keep the existing default path and never move memories automatically.
Require idle sessions and an empty queue before switching. Start a fresh context and retain the Rust file lock.
Do not adopt their Unix-socket lock because our standard-library lock already supports the six release platforms.

Previous-exchange replay needs a quality evaluation before adoption.
Test pronouns, exact snippets, corrections, and follow-up requests against the current zoom-first approach.
Keep it opt-in with a strict byte cap if the evaluation shows a benefit.
Test resume, fork, cancellation, and `/optchat off` boundaries so private turns never return through replay.
Their 16 KB default is an example, not evidence that it fits our budget.

Do not add their subagent runner, connected windows, or agent inspector.
Pi and installed extensions already provide delegation. Our child-process exclusion prevents competing memory writers.
A second orchestration system adds tool collisions, lifecycle complexity, and maintenance outside the memory engine's purpose.

Do not add automatic Git checkpoints on every turn.
Their [checkpoint function][checkpoint] initializes a repository and commits staged changes, but a local Git history is not an off-machine backup.
Keep backup explicit and private. Also keep our existing summary-size policy until usage measurements justify changing it.

## Validation and delivery

Run `devenv test` for each implementation phase and keep Rust 1.89 compatibility.
Changes to persisted data, export behavior, or package loading also need all six release-platform tests.
Use installed-package smoke tests after changing dependencies, names, or packaged files.
Record large-history timing and allocation changes using [the benchmark procedure](benchmarks.md).

This review changes documentation only. It does not claim runtime validation of the proposed features.
Feature implementation starts with Phase 1. Imports are a separate, larger milestone after the smaller additions.
If implementation copies source rather than independently implementing an idea, retain the applicable notices from their [MIT license][license].

[upstream]: https://github.com/jonaslsaa/pi-optchat/tree/e4af09a8833ed606c09132d3c0c3bccac8a80392
[package]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/package.json
[search]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/src/tools.ts
[browser]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/src/browser.ts
[usage]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/src/usage.ts
[compactor]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/src/compactor.ts
[compactor-tests]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/test/compactor.test.ts
[import-sources]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/src/import/sources.ts
[import-job]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/src/import/job.ts
[profiles]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/src/profiles.ts
[transcript]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/src/transcript.ts
[checkpoint]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/src/checkpoint.ts
[license]: https://github.com/jonaslsaa/pi-optchat/blob/e4af09a8833ed606c09132d3c0c3bccac8a80392/LICENSE

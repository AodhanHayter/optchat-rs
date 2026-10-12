# Pi compaction integration comparison

Reviewed on 2026-10-12. This note compares ways to keep long tool loops within the model context window.
The comparison below records the original recommendation. The implementation status follows.

Sources are our branch at `e8bc29e`, `jonaslsaa/pi-optchat` at `5942874` (version 0.8.4), and Pi 1.0.2.
The earlier [feature comparison](pi-optchat-comparison.md) used upstream `e4af09a` and does not cover its new mid-turn refresh.

## Implementation status

Implemented for version `0.3.0`:

- `session_before_compact` saves delivered instructions, waits for the Rust tree, and returns a memory snapshot at Pi's retained boundary.
- Pi persists that snapshot and resumes the loop. The adapter resets offsets and uses the saved summary once.
- `optchat.cursor` entries track consumed session entry IDs across restart. A crash between writes to the two stores can still cause duplication.
- Optional `max_bytes` on Rust `view` and `prepare` merges a request-local copy without changing `view.json` or removing original coverage.
- Pi owns compaction timing and output clamping. A safety check pauses requests that still cannot fit, including recognized routed provider payloads.
- Current system instructions survive other extensions' changes. Later payload changes can still invalidate the safety check.

Real SDK tests with mock providers cover automatic and repeated compaction, virtual routes, manual compaction, restart, recall, and one-time logging.
They also cover cancellation, failed summaries, disabled compaction, oversized batches and inputs, images, and the six original routing regressions.
OpenAI Completions and Anthropic Messages tests observe HTTP dispatch. Unknown payloads stop before dispatch.
Existing steering, queued-report, and goal-continuation tests remain in the suite.
No paid provider calls were made. See the [README context limits](../README.md#context-limits) for the current contract.

## Original recommendation

Use Pi's compaction lifecycle for active session history. Keep OptChat's Rust tree for permanent memory and retrieval.
Compaction reduces the history sent to the model. It does not require deleting original records.
Pi already supports long tool loops, retained tool-call pairs, saved compaction entries, and overflow recovery.
Its extension interface accepts a replacement summary, so integration does not require abandoning OptChat memory. [Pi compaction reference][pi-compaction]

The proposed design uses an OptChat memory snapshot as the replacement summary.
Pi controls the retained session entries and continuation after compaction.
The adapter must recognize the saved summary instead of injecting a second copy of the same memory view.
Start with a focused SDK experiment before replacing the current adapter behavior.

This is preferable to expanding our independent request-size policy in PR #9.
It is more integration work than upstream's local refresh, but reuses Pi's session lifecycle instead of maintaining a competing one.

## What the other implementation does

The main agent still returns `{ cancel: true }` from `session_before_compact`.
It does not demonstrate native Pi compaction for the main chat. [Hook][upstream-hook]

Instead, its `context_with_system` handler refreshes memory during a long run:

1. Estimate the size of the active turn's messages.
2. Flush those messages to memory and wait for summaries.
3. Render a fresh memory view.
4. Keep the original task and the latest assistant step, including its tool calls and results, verbatim.
5. Replace earlier steps in the request with the memory view and a continuation notice.

The default threshold is 30% of the selected model's window. Setting it to zero disables refresh.
Subagents use native Pi compaction because their transcripts do not enter the main summary tree.
These are separate policies. [Refresh handler][upstream-refresh], [helpers][upstream-helpers], [subagents][upstream-agents], [README][upstream-readme]

The refresh is a heuristic, not a strict request budget.
It estimates characters at four per token and counts images separately.
It measures the turn rather than the complete request, so system instructions, tools, and the memory view need additional room.
It defers refresh when the task and latest step exceed half the refresh budget.
The helper also uses `ctx.model`, which Pi defines as the selected model, not necessarily the routed physical model. [Helpers][upstream-helpers], [virtual models][pi-virtual]

Its regression test exercises repeated refreshes, task preservation, the last tool step, and one-time logging.
That test disables Pi auto-compaction. It is evidence for the local refresh strategy, not native compaction integration. [Test][upstream-test]

## What Pi already supplies

Pi checks the projected session context between completed tool batches.
It can split a single user-message span at an assistant message without separating a tool result from its call.
The saved compaction entry identifies the first retained entry through `firstKeptEntryId`.
Pi rebuilds the active context from the summary and retained messages. Original session entries remain stored. [Compaction][pi-compaction], [sessions][pi-sessions]

The `session_before_compact` hook can return `compaction` with `summary`, `firstKeptEntryId`, `tokensBefore`, and optional metadata.
It receives `turnPrefixMessages` when compaction cuts within a long user-message span.
It also receives a cancellation signal and the reason: manual, threshold, or overflow. [Hook contract][pi-compaction]

Pi checks virtual requests against the routed physical model's window before dispatch.
Our proposed guard instead reads `ctx.model`, which remains the virtual selection.
This makes Pi's lifecycle a better integration point for routing. [Virtual model contract][pi-virtual]

Native compaction is not a guarantee that every final request fits.
Its threshold uses the session projection, while extensions can alter the outgoing request afterward.
A huge task, memory view, system prompt, or indivisible tool batch can still require a safe refusal.
Compaction can also fail or be disabled. Tests must cover these cases rather than assume native compaction solves them.

## Required adapter changes

Removing the veto alone is insufficient.
Our `compose()` keeps array-index state in `anchor` and `cursor`, and assumes a user or custom message starts the current turn.
Pi can replace that prefix with a `compactionSummary` message followed by an assistant/tool sequence.
The adapter must understand that shape and rebuild its state after compaction. [Current adapter][ours]

The integration needs these properties:

- Original records are durable before their raw session messages leave active context.
- The prepared summary covers the removed prefix, including `turnPrefixMessages` and delivered instructions.
- The retained suffix keeps complete tool-call/result groups.
- Saved compaction metadata supports restart and avoids logging originals twice.
- The outgoing request includes the memory snapshot once, not as both a summary and a separately injected view.
- A failed or canceled refresh keeps history intact and either continues safely or stops with an explanation.
- Later extensions retain their system-prompt and context changes.

The Rust store and retrieval tools do not need replacement.
The primary work is in the Pi adapter's context construction and compaction state.
A token-aware limit for the supplied memory snapshot still needs a design, especially for small-context models.

## Verification before merging

Use the real Pi SDK with mock providers to cover these behaviors:

- A continuous tool loop compacts and finishes without another user message.
- Repeated compaction, manual `/compact`, and restart preserve recall and log each original once.
- Parallel tool batches remain paired, including when a batch cannot fit.
- Steering, goal continuations, and queued reports keep the issue #6 behavior.
- Virtual routes, small-context models, forced prompts, and later extensions exercise the six current routing failures.
- Compaction cancellation, disabled compaction, failed summaries, and oversized inputs stop safely when needed.

This review read source and tests. It did not run upstream's tests or make paid provider calls.
The installed Pi compaction and virtual-model docs match the Git blobs at the pinned Pi commit below.
As of this review, PR #9 remains open at `e8bc29e`. Its CI `checks` job failed, while all six binary builds passed.
Only this research note was added during the comparison. Runtime code and the user's `.pi/settings.json` were not changed.

[ours]: https://github.com/AodhanHayter/optchat-rs/blob/e8bc29eac30206391422731efbbece54e0d08086/pi/index.ts#L338-L510
[upstream-hook]: https://github.com/jonaslsaa/pi-optchat/blob/594287450ee37cd630f29ffbb4e6ba862f9259f4/src/index.ts#L475-L478
[upstream-refresh]: https://github.com/jonaslsaa/pi-optchat/blob/594287450ee37cd630f29ffbb4e6ba862f9259f4/src/index.ts#L429-L464
[upstream-helpers]: https://github.com/jonaslsaa/pi-optchat/blob/594287450ee37cd630f29ffbb4e6ba862f9259f4/src/transcript.ts#L182-L223
[upstream-agents]: https://github.com/jonaslsaa/pi-optchat/blob/594287450ee37cd630f29ffbb4e6ba862f9259f4/src/agents.ts#L82-L89
[upstream-readme]: https://github.com/jonaslsaa/pi-optchat/blob/594287450ee37cd630f29ffbb4e6ba862f9259f4/README.md#good-to-know
[upstream-test]: https://github.com/jonaslsaa/pi-optchat/blob/594287450ee37cd630f29ffbb4e6ba862f9259f4/test/mid-turn-refresh.test.ts
[pi-compaction]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/docs/compaction.md
[pi-virtual]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/docs/virtual-models.md
[pi-sessions]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/docs/sessions.md

# Data structures and algorithms review

Assessment date: 2026-10-07. Code baseline: `337df2b`.
The assessment below describes that baseline. The implementation status records the subsequent work approved by the user.
The scope is a local, single-writer memory store, including its Rust engine, Pi driver, and offline browser.

## Implementation status

The behavior-preserving work is implemented on `perf/incremental-memory`:

1. Permanent benchmarks cover empty and sparse summary trees, repetitive search, bulk import, large usage ledgers, and full export transport.
2. The scheduler tracks the first missing leaf and ordered candidates. It preserves job order, cooldowns, and context boundaries.
3. Per-level merge candidates preserve the original score and leftmost tie-break. The view byte count updates incrementally.
4. The view RPC renders once. The Pi text cap no longer builds a full character array.
5. The CLI and `/optchat browse` stream HTML through the existing Rust writer. The new `export_file` RPC returns only a path.
6. Usage reports aggregate records while reading, retaining IDs for exact deduplication and only the first 20 warning strings.
7. Literal search reuses the existing `memchr` matcher with a byte filter and bounded ASCII-folded buffers. Query and result semantics stay unchanged.
8. The offline viewer releases duplicate summary-entry arrays after initialization. Its serialized history remains intact for saving the page.

[Measured results and reproduction commands](benchmarks.md#incremental-scheduling-and-merge-tracking) include comparisons against `337df2b`.
At 100k messages, sparse startup changed from 6.62 seconds to 225 milliseconds.
The pending-tail scheduling case changed from 12.9 milliseconds to 53.4 microseconds.
Tests preserve original IDs, dates, text, summary decisions, and job context. No log format, durability policy, or dependency changed.

The initial export measurement found a 1,202 MiB Node peak for a 125 MiB pending snapshot over RPC.
A side-by-side measurement now includes durable file writes in both paths.
Streaming reduces Node peak memory from 1,325 MiB to 186 MiB and median export time from 1.35 seconds to 343 milliseconds.
Snapshot text, private creation, overwrite refusal, and writer-lock ownership are unchanged. The buffered `export` RPC remains compatible.
At 100k attempts, usage-report Node peak memory changed from 310 MiB to 166 MiB.
The repetitive middle-mismatch search changed from 10.8 milliseconds to 12.6 microseconds. A 100k-message miss changed from 24.2 to 5.70 milliseconds.
A 100k-message Chromium snapshot retained about 7.6 MiB less JavaScript heap after cleanup. It still loads all originals and summaries.

This completes the measured, behavior-preserving pass. The following proposals remain deliberately unimplemented:

| Experiment | Gate before implementation |
| --- | --- |
| Dense summaries, lazy originals, recovery checkpoints | A restart-time or retained-memory target that the current implementation misses, plus recovery-equivalence tests |
| Indexed search | A workload whose query frequency or size makes the remaining scan cost unacceptable |
| Paged or compressed snapshots | An agreed offline loading format and browser memory target |
| Staged bulk import | A recovery and acknowledgment contract that preserves source IDs, dates, text, and ordinary append durability |
| Query-aware recall, cache-policy changes | Quality and cost evaluation, with approval before paid provider calls |
| Alternative JSON parser | Profiling that identifies parsing, not replay or retained text, as the limiting cost |

These are experiments or behavior changes, not unfinished pieces of this optimization pass.
No storage format, durability policy, search semantics, or dependency changed. No paid model calls were made.

## Original assessment

The architecture fits this workload. The implementation is not optimal across large, incomplete histories.
Improve repeated work before replacing the storage format or introducing semantic indexes.
Newer memory research is most useful for retrieval quality and evaluation, not as a reason to replace every collection.

## Evidence and limits

This assessment combines source inspection, the existing [benchmark results](benchmarks.md), new synthetic probes, and primary sources.
The new probes use temporary stores, not the active chat. They make no compactor requests.
No production code or dependencies changed. Cross-platform performance, cold-disk startup, peak memory, and model-answer quality remain unmeasured here.

The existing 100k-message results provide this baseline:

| Operation | Recorded result | Interpretation |
| --- | ---: | --- |
| Open the store | 361 ms | Parse and recover originals and summaries |
| Open memory | 811 ms | Also reconstruct the visible summary selection |
| Render | 29.5 µs, one allocation | Already inexpensive |
| Schedule pending work | 13.1 ms | Still scans the incomplete tree |
| Durable append | 27.8 ms | Includes synchronization and scheduling |
| Search, common match | 9.4 µs | Stops near the newest messages |
| Search, no match | 25.9 ms | Scans eligible originals |
| Generate HTML | 373 ms, 220.7 MB output | Excludes pipe transfer and browser loading |

These figures come from the saved benchmark runs, not a fresh run of every case against this baseline.
Requested allocation bytes are not retained memory or peak memory.
The existing fixtures mostly contain complete summary trees. The pending-work case leaves only 32 messages unsummarized.

### New incomplete-history probe

The scratch probe links the current optimized Rust library. It measures three opens per fixture and reports the median.
Each original contains 1,024 ASCII bytes. Each available summary contains 430 ASCII bytes.
IDs are contiguous, dates are fixed, and the view budget is 128,000 bytes.
The partial fixture contains only summary `0:0`. The complete fixture contains every valid tree node.
Fixture generation and result destruction are outside the open measurement. Store opening still includes its normal directory synchronization.

| Messages | Open, one summary | Open, complete tree |
| --- | ---: | ---: |
| 1,000 | 12.6 ms | 10.1 ms |
| 5,000 | 13.9 ms | 26.9 ms |
| 10,000 | 68.1 ms | 51.1 ms |
| 20,000 | 259.7 ms | 107.3 ms |

Doubling the partial history from 10k to 20k increased time about 3.8 times.
This supports the source-level concern about repeated failed merge scans. It is not a production latency guarantee.
A completely empty summary tree was faster than the sparse nonempty tree. Both belong in future benchmarks.

At 20k, the partial view contained 20,000 parts and 580,401 summary bytes.
Its rendered form occupied 749,305 bytes. Even the complete view rendered 130,583 bytes from 127,710 summary bytes.
The configured budget therefore measures summary text, not complete rendered bytes or model tokens.
Pending summaries can also prevent the view from fitting. The model-view interface rejects unsettled views, so this does not demonstrate an oversized model request.

The probe also searched one MiB of repeated `a` bytes with a 256-byte query containing one `b`.
A middle mismatch took 11.26 ms. A last-byte mismatch took 5.11 ms. A first-byte mismatch took 0.014 ms.
These are seven-run medians for the matcher alone. They expose sensitivity to repetitive text, not an end-to-end search regression.

The scratch source and results are in `/tmp/optchat-algorithms.24iDUY/probe.rs` and `results.csv` on the assessment machine.
These temporary artifacts are not distributed with the project.
The host used Linux x86-64, Rust 1.98.1, and an ext4 temporary directory. Three startup samples do not establish confidence intervals.

## Structures that fit the workload

The source of truth remains the append-only original log. Any future index must be disposable and reconstructable from that log.
Keep original IDs, dates, and text. Do not exchange those guarantees for faster queries.

| Structure | Current use | Assessment |
| --- | --- | --- |
| `Vec<Message>` | Originals indexed by contiguous ID | Correct for direct lookup and chronological iteration |
| Binary summary tree | Power-of-two chronological ranges | Compact addressing, predictable descent, no stored child pointers |
| `BTreeMap<Key, Node>` | Sparse and complete summaries | Reasonable starting point, but dense levels offer a measured experiment |
| `Vec<Key>` | Ordered view parts | Good locality while the view remains small |
| Small ordered map | Active jobs | Active work is capped at eight, so changing its map has little value |
| Exclusive search cursor | Older pages by message ID | Stable when new messages append, unlike numbered offsets |
| Effect scopes and deferred wakeups | Cancellation and progress | Preserve these lifecycle guarantees during optimization |

For `N` originals, a complete tree contains `sum(floor(N / 2^l))` nodes, including leaves.
That count is below `2N`. The tree is not exponentially large.
An original lookup is constant-time. Descending one summary to an original takes logarithmic tree depth.
The current two-child `zoom` operation does not traverse the whole tree.

Relevant implementation: [store.rs](../src/store.rs), [lib.rs](../src/lib.rs), and [memory.ts](../pi/memory.ts).

## Highest-value changes

### Track ready work instead of scanning old nodes

`Memory::free()` and `jobs()` enumerate possible tree keys while a tree is incomplete.
`ready()` also checks the first unresolved view part. Appending one message can revisit the entire old tree.
The complete-tree shortcut fixes idle work, but not normal progress through an incomplete tree.

Use an incremental ready set: a collection of jobs whose prerequisites are satisfied.
Update it after append, accepted summary, retry expiry, and recovery.
Track the unresolved frontier rather than rediscovering it repeatedly.
A child completion can enable its parent. Frontier movement can also enable previously blocked work, so parent-only notifications are insufficient.

Preserve current level/ID ordering, failure cooldowns, and the no-future-context rule.
The readiness rule intentionally serializes some work. A wholly unsummarized history initially schedules one long leaf, despite the eight-job cap.
A faster scheduler does not remove that dependency. Parallelizing those leaves changes the summarization algorithm and requires separate quality tests.

Start with cached frontier information and ordered candidates using existing standard collections.
There is no evidence that a lock-free queue or a new async runtime helps.
The target is work proportional to changed candidates, rather than total historical nodes on every pump.

### Track merge candidates without changing merge decisions

`Memory::fit()` scans adjacent view parts to select every merge, then shifts the vector with `splice`.
Startup calls it throughout replay. Sparse histories can repeatedly scan large views without finding any possible merge.
This is the strongest new scaling problem observed in the probes.

The merge score is `age / width`. For a node at level `l` and index `i`, it equals `total / 2^l - i`.
At one level, the earliest eligible pair always has the best score.
An ordered candidate collection per level can therefore expose one contender per level, rather than rescanning all visible pairs.
Adjacent changes only require local candidate updates. Measure that approach before replacing the small settled-view vector.

Do not put scores in a static heap and assume they remain valid.
As `total` grows, priorities at different levels change at different rates.
Preserve the current leftmost tie-break, merge order, and behavior for summaries that exceed their requested size.
Use the replay oracle in [tests/history.rs](../tests/history.rs), extended to much larger incomplete histories.

Define the budget separately from this optimization.
A hard model-token limit is a different requirement from the current summary-byte target.
It needs space for IDs, separators, system instructions, and new user input, as well as tokenizer-aware accounting or a conservative bound.

### Reduce data copies before changing the parser

`Request::View` calls `mem.render()` twice. Reusing one result is a direct, low-risk improvement.
It is small in absolute time, so it does not replace the scheduling work.

The Rust text helpers already avoid character vectors, but `capText()` in [transport.ts](../pi/transport.ts) still uses `Array.from(text)`.
That allocates an entry for every Unicode code point before deciding whether truncation is necessary.
A code-point scan can retain the current head/tail behavior without constructing the full array. Test supplementary characters and omission counts.

HTML export is a larger copy problem. It constructs the full document, serializes it into a JSON response, and parses it in Node.
The browser then parses all embedded originals and summaries, despite creating tree elements on demand.
Its parsed tree array and summary lookup map also retain separate containers for the same records.
Lazy elements do not make data loading lazy.

First measure peak memory and complete RPC latency for export.
If those are unacceptable, stream a consistent snapshot through the process that already holds the writer lock.
Do not start a second writer or remove create-new file protection.
A compressed snapshot reduces file size but does not, by itself, remove the full decoded history from browser memory.

## Changes to benchmark before adopting

### Dense summary storage

Tree keys are numeric coordinates, not arbitrary strings.
Per-level arrays such as `Vec<Vec<Option<Node>>>` offer direct lookup and better locality than ordered map lookup.
They also retain simple traversal order without hashing.

This is a candidate, not a demonstrated win. Sparse histories need empty slots, and eager allocation wastes memory before summaries exist.
A representation change must preserve latest-valid-record recovery, child validation, and deterministic ordering.
Benchmark complete, sparse, and mixed trees before choosing arrays over the current map.
Replacing `BTreeMap` with `HashMap` is not automatically better.

### Lazy originals and recovery checkpoints

`Store::open()` reads every original and summary into memory, then `Memory::open()` replays the view.
This is acceptable at the measured scale, but it makes startup and retained memory grow with total history.
The saved 100k startup benchmark performs about 1.13 million allocation requests.

For substantially larger stores, an offset index can map each original ID to its file, byte position, length, and source line.
Load original text on demand and retain only recent or frequently accessed records.
Keep the active log tail separate from sealed historical files. Memory mapping a file that recovery can modify needs additional safety analysis.
JSON escapes also prevent treating every raw byte range as decoded message text without parsing.

A recovery checkpoint stores validated derived state plus log positions.
A valid checkpoint can avoid replaying the entire prefix. A missing, stale, or corrupt checkpoint must fall back to the authoritative logs.
Do not make a second format authoritative or lose file-and-line diagnostics.
Introduce this only after measurements establish that restart time or retained memory is a problem.

### Indexed literal search

The current reverse scan is a good default for small stores and common recent matches.
A 25.9 ms miss at 100k messages alone does not justify maintaining another database.
Repetitive text deserves additional benchmarks because candidate checks can repeatedly compare much of the query.
The query cap bounds the damage, but it does not eliminate the cost.

The existing `memchr` dependency provides a reusable [`memmem::Finder`](https://docs.rs/memchr/latest/memchr/memmem/struct.Finder.html) with a worst-case linear-time guarantee.
It is byte-exact, not ASCII-case-insensitive. It is not a drop-in replacement for the current search contract.
A compatible implementation or derived folded representation needs differential tests and memory measurements.

If larger histories or frequent misses justify an index, use trigrams: overlapping sequences of three characters or bytes.
Intersect candidate message lists, then run the current exact matcher on the originals.
This preserves literal matching even when the index returns false positives.
Queries shorter than the indexed unit still need a fallback scan.

[SQLite FTS5](https://sqlite.org/fts5.html#the_trigram_tokenizer) provides a standard trigram option.
Its Unicode matching, query syntax, and wildcard rules differ from this project's ASCII-only literal interface.
Do not pass user text directly as an FTS expression or silently change search semantics.
A standard index is preferable to a custom search engine once the dependency earns its maintenance cost.

### Large imports and usage reports

Import validates a batch, then routes each record through ordinary append, synchronization, and scheduling.
That repeats work during bulk ingestion. A staged importer can preserve source text and IDs while avoiding a full scheduling pass per record.
Batching durable writes changes failure and acknowledgment semantics. Keep ordinary append durability unchanged and specify recovery before adding group commits.

The usage ledger reads, splits, parses, and deduplicates its entire file for every report.
That is appropriate for an occasional command. For large ledgers, stream aggregation before adding a database or a persistent totals cache.
Deduplication still requires attempt identity tracking. Keep unknown pricing and malformed-record warnings intact.

## Newer approaches worth testing

### Query-aware recall alongside the chronological tree

The current view selects detail by age and range width, not by relevance to the current question.
Recursive summaries can lose old details even when their storage and traversal are fast.
There is no answer-quality benchmark here that establishes the best summarization or retrieval policy.

[RAPTOR](https://arxiv.org/abs/2401.18059) retrieves from a hierarchy built through embedding, clustering, and recursive summarization.
OptChat already shares the hierarchical-summary idea, but its hierarchy is chronological, not semantic.
Replacing that hierarchy would disrupt interval IDs, stable `zoom`, and temporal interpretation.

A safer experiment keeps the chronological tree and adds a separate recall path.
Rank existing summaries or originals for the question, then expand selected ranges and cite original IDs.
Begin with lexical retrieval. Add embeddings only if paraphrase tests show a real gap.
Do not silently replace the exact `memory_search` tool with approximate semantic results.

[EverMemOS](https://arxiv.org/abs/2601.02163), a 2026 research system, separates episodic records, consolidated semantic memory, and query-time reconstruction.
The applicable idea is a derived layer for facts and changing decisions, not a replacement for original records.
Any extracted fact needs source IDs and temporal provenance. A newer conflicting statement must not erase the earlier statement.
Its reported benchmark gains do not establish a gain for this repository.

Use [LongMemEval](https://arxiv.org/abs/2410.10813) as an evaluation reference for extraction, temporal reasoning, updates, cross-session reasoning, and abstention.
The 2026 [EvoMemBench](https://arxiv.org/abs/2605.18421) reports that no single memory form wins across all settings.
For this project, add old decisions, renamed identifiers, contradictory updates, and unanswerable questions with known source IDs.
Measure answer accuracy, source accuracy, tokens, cost, and latency together.
Do not run paid evaluation without explicit approval.

### Cache-aware scheduling and view stability

Provider prompt caching reuses work for identical prompt prefixes.
[Claude's documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) says a cache entry becomes available after the first response begins.
A shared-prefix gate can therefore delay matching concurrent requests until one request starts its response.

That is not a reason to serialize all compactor jobs.
Measure actual prefix overlap and cache writes first. Key any gate by provider, model, and exact effective prefix.
Release waiters on failure, cancellation, and shutdown. The current usage ledger supports the cost side of this experiment.

Tree merges can also change early prompt text and invalidate later cached prefixes.
A cache-aware merge policy can trade prompt stability against detail and recency, but that changes behavior.
It belongs in the answer-quality and cost experiment, not the behavior-preserving scheduler optimization.

[CacheBlend](https://arxiv.org/abs/2405.16444) reuses internal model attention state across non-prefix chunks.
It requires control over inference and that internal state. OptChat cannot implement it solely through hosted text-generation requests.
It is relevant only if the project later controls a compatible local or self-hosted inference server.

### SIMD parsing and other specialized structures

SIMD handles multiple bytes per instruction. The project already uses it through `memchr`.
A [`simd-json` parser](https://docs.rs/simd-json/latest/simd_json/serde/fn.from_slice.html) is an experiment only after replay and allocation costs are separated.
Its input buffer is mutable and rewritten during parsing. Switching parsers does not remove owned strings, validation, sorting, or view reconstruction.
Keep the current parser until an end-to-end benchmark and malformed-log tests justify a replacement.

Learned indexes offer little for IDs that already map directly to vector positions.
A CRDT solves concurrent replicated updates, which this single-writer store does not require.
An LSM database, graph database, GPU search engine, or custom SIMD implementation is not supported by the present measurements.

## Recommended order

1. Add permanent benchmarks for sparse and incomplete trees, bulk import, repetitive search, large usage ledgers, and full export transport.
2. Improve the unresolved frontier and ready-work tracking without changing job order or compactor context.
3. Track merge candidates incrementally, using replay equivalence tests to preserve decisions.
4. Remove repeated rendering and the Pi-side character array. Measure export peak memory before designing a streaming interface.
5. Compare dense summary storage and recovery checkpoints only against measured startup and memory targets.
6. Evaluate query-aware recall and shared-prefix caching separately from behavior-preserving optimizations.

Keep durability, original text, IDs, dates, and retrieval semantics fixed throughout the first four steps.
Use deterministic mocked summaries to test scheduling without provider calls.
The largest near-term gains are avoiding repeated work and testing missing workloads, not adopting the newest data structure.

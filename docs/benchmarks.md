# Rust benchmarks

Measure large-history performance before changing the Rust engine. The benchmark uses synthetic histories, not private chat data or model calls.

## Run the benchmarks

From the repository root, enter `devenv shell`. Run the optimized benchmark build:

```sh
cargo bench --locked --bench history > /tmp/optchat-bench.csv
```

The default run covers 1,000, 10,000, and 100,000 messages. Temporary fixtures are removed when the run finishes. Allow several minutes when testing the old implementation with incomplete histories.

Fixtures use the system temporary directory, including `TMPDIR` when set. Check its filesystem before comparing durable-write timings. A memory-backed filesystem does not measure physical-disk synchronization.

To select history sizes and filter case names, run:

```sh
OPTCHAT_BENCH_SIZES=1000,10000 cargo bench --locked --bench history -- memory_open
cargo bench --locked --bench history -- cache_blocks
cargo bench --locked --bench history -- search
OPTCHAT_BENCH_SIZES=0 cargo bench --locked --bench history -- pending_jobs
```

A size of zero measures an empty history. Its pending-job case returns no work.

Read the CSV output for each case. `median_us` measures microseconds per operation, including destruction of its returned value. `samples` counts timing batches. `iterations_per_sample` records operations per batch.

The harness warms each case before timing. It collects at least five samples over at least 200 ms, including setup time. Short operations use batches to reduce clock overhead. Setup and state destruction are excluded from each timed sample. Allocation counting uses a separate pass through the same operation.

`allocations` counts allocation and reallocation requests per operation. `allocated_bytes` sums their requested sizes, including reallocated buffers. It does not measure peak memory or retained memory. The benchmark allocator forwards all operations to Rust's system allocator.

## Workloads

Histories contain alternating user, assistant, tool, and tool-result messages. Each source message contains about 1 KiB of mixed ASCII, Unicode, and newlines. Completed tree nodes contain roughly 430-byte synthetic summaries.

| Case | Measured work |
| --- | --- |
| `store_open/N` | Read and validate messages and the complete summary tree, then close the store |
| `memory_open/N` | Open the store, reconstruct the bounded view, and close memory |
| `render/N` | Render an already loaded, settled view |
| `export/N` | Generate the complete HTML snapshot, including embedded originals and summaries |
| `idle_jobs/N` | Ask a fully summarized history for work |
| `append/N` | Append one short message and build its free leaf, including file synchronization |
| `pending_jobs/N` | Schedule work with the final 32 messages unsummarized |
| `incomplete_open_empty/N`, `incomplete_open_sparse/N` | Open histories with no summaries or only summary `0:0` |
| `incomplete_jobs_empty/N`, `incomplete_jobs_sparse/N` | Schedule the first eligible job from those histories |
| `search_repetitive/0`, `/128`, `/255` | Search one MiB of `a` bytes for a 256-byte query with one `b` at the named position |
| `search_periodic` | Search one MiB of repeated `ab` for a 256-byte query with a swapped middle pair |
| `search_common/N` | Find one full page near the newest end of an already loaded history |
| `search_rare/N` | Scan all eligible originals for a match at ID 4 |
| `search_miss/N` | Scan all eligible originals for absent text |
| `cache_blocks/ascii`, `cache_blocks/unicode` | Split a large view at character-based cache boundaries |
| `cap/ascii`, `cap/unicode` | Cap a large tool result without splitting Unicode characters |
| `flatten/ascii`, `flatten/unicode` | Replace line endings with spaces |

Fixture creation is outside measurements. Append samples restore the fixture and reopen it before timing. Pending-job samples reopen the same incomplete fixture before timing. Startup results use warm filesystem pages, not cold disk reads. These Rust cases do not measure model latency or full RPC serialization. The incomplete cases include completely unsummarized 100,000-message histories.

## First optimization results

Measured on 2026-10-05 with a Ryzen 9 5900X, Linux x86-64, Rust 1.98.1, and an ext4 filesystem on NVMe. Builds use Cargo's default benchmark profile, without `target-cpu=native`. The baseline is commit `8ce648a` with the same benchmark harness added. The optimized results cover the changes described below.

Raw measurements are in [`baseline.csv`](../benches/results/baseline.csv) and [`optimized.csv`](../benches/results/optimized.csv). Times below are medians from one run per build, not confidence intervals. Repeat runs before drawing conclusions about small differences.

| Case | Baseline | Optimized |
| --- | ---: | ---: |
| Open memory, 1k messages | 9.46 ms | 4.18 ms |
| Open memory, 10k messages | 152 ms | 58.5 ms |
| Open memory, 100k messages | 2.16 s | 0.811 s |
| Render, 100k messages | 180 µs | 29.5 µs |
| Idle jobs, 100k messages | 12.0 ms | Less than 1 µs |
| Pending jobs, 100k messages | 13.6 ms | 13.1 ms |
| Durable append, 100k messages | 29.6 ms | 27.8 ms |
| Cache blocks, ASCII | 190 µs | 3.94 µs |
| Cache blocks, Unicode | 238 µs | 64.3 µs |
| Tool-result cap, ASCII | 92.0 µs | 15.2 µs |
| Tool-result cap, Unicode | 140 µs | 24.5 µs |

In that version, rendering dropped from 1,600 allocation requests to one at 100k messages. Idle scheduling dropped from 16.8 MB of requested allocations to zero. Pending-job scheduling dropped from 18.9 MB to 0.88 MB, but still scanned the incomplete tree. Durable append also included a scheduler scan across tree keys. The incremental work below removes those scans. Filesystem synchronization adds timing variance. No durability guarantee changed.

The idle case now measures a small node-count calculation. Its timing is not an end-to-end RPC latency claim. Small timing differences for append, store loading, and pending jobs are not evidence of a reliable speedup.

## Search measurements

Measured on 2026-10-06 on the same machine with Rust 1.98.1. Raw results are in [`search.csv`](../benches/results/search.csv).
These are library calls over loaded histories, not startup or full RPC timings. JSON size accounting is included, but final result serialization is not.

| History size | Common match | Rare match | No match |
| --- | ---: | ---: | ---: |
| 1k messages | 8.59 µs | 18.7 µs | 169 µs |
| 10k messages | 9.43 µs | 193 µs | 1.73 ms |
| 100k messages | 9.40 µs | 8.19 ms | 25.9 ms |

Default filtering searches only user and assistant records in this fixture. Common matches stop after one extra hit beyond the 20-hit page.
Rare matches and misses scan the whole eligible history. Misses allocate nothing. Common pages make 124 allocation requests totaling 29,440 bytes.
Search uses `memchr` to find candidate bytes, then compares ASCII-folded bytes without allocating a lowercase copy of each message.
There is no index. Repetitive text and long queries can cost more than these fixtures. These figures are single-run medians, not latency guarantees.

## Export measurements

Run `cargo bench --locked --bench history -- export` to measure snapshot generation.
Measured on 2026-10-06 on the same machine with Rust 1.98.1. Raw results are in [`export.csv`](../benches/results/export.csv).
The `# export_bytes/N` rows record file size. Generation excludes memory startup, destination writes, and browser loading.

| History size | Snapshot size | Generation median | Allocations |
| --- | ---: | ---: | ---: |
| 1k messages | 2,337,316 bytes | 2.93 ms | 14 |
| 10k messages | 22,140,368 bytes | 28.5 ms | 13 |
| 100k messages | 220,698,208 bytes | 373 ms | 13 |

A separate 100k-message fixture in local Chromium loaded a 211 MiB snapshot in about 2.7 seconds.
It contained roughly 1 KiB per original, a complete summary tree, and literal hostile markup in one original.
The initial page created two tree groups. Revealing one original produced 226 details elements and took about 31 ms.
Common search took 0.8 ms. A rare search and a miss each took about 24 ms.
Pagination retained 20, then 20, then one result for 41 matches. Original text survived unchanged, and no external requests occurred.
These are single-run observations, not cross-browser latency guarantees. Browser memory use was not reliably measured.

The tree creates elements on demand, but all original text and summaries remain embedded in the file.
The browser must load and parse them all. Larger histories need more memory and can block the page during loading or search.
The legacy `export` RPC also holds the HTML response in the Pi process. The CLI and `/optchat browse` now stream to a file instead.
No automatic size limit or background export is provided. See the [streaming measurements](#streaming-export) below.

## Incremental scheduling and merge tracking

Measured on 2026-10-07 on the same machine and filesystem, with Rust 1.98.1.
The baseline is `337df2b` with the expanded harness. The new build is the implementation on `perf/incremental-memory`.
Raw results are in [`incremental-before.csv`](../benches/results/incremental-before.csv) and [`incremental-after.csv`](../benches/results/incremental-after.csv).
These are single-run medians, not confidence intervals.

| Case, 100k messages | Baseline | Incremental |
| --- | ---: | ---: |
| Open memory, complete tree | 829 ms | 395 ms |
| Open memory, no summaries | 282 ms | 265 ms |
| Open memory, only summary `0:0` | 6.62 s | 225 ms |
| Schedule work, final 32 messages pending | 12.9 ms | 53.4 µs |
| Schedule work, only summary `0:0` | 2.93 ms | 9.45 µs |
| Render | 29.5 µs | 21.8 µs |

The scheduler remembers the first missing leaf and separates automatic summaries from provider jobs.
It updates candidates after append, completion, recovery, and retry expiry.
Recovered candidates beyond the first missing leaf remain blocked until earlier summaries finish.
The job order, eight-job limit, retry delays, and context boundaries stay unchanged.

The view keeps eligible merge pairs grouped by level. Each level exposes its leftmost pair.
The engine compares those pairs using the current history length, with the original leftmost tie-break.
The byte count stays current after append, summary insertion, and merge.
The view remains a vector, so a merge still shifts later entries.

Complete-tree startup adds about 25,600 allocation requests and 3.54 MB of requested allocations at 100k messages.
That is the cost of maintaining the ordered candidate sets, not a reduction in storage memory.
The byte budget still counts summary text. It is not a hard limit on rendered text or model tokens.

The expanded replay oracle covers complete and sparse histories through 2,049 messages, including oversized summaries.
Scheduler tests cover recovered gaps, out-of-order completion, automatic parents, new appends, and retry expiry without sleeping.
The current differential run matches 4,952 RPC responses across eight seeded histories and four budgets.
To repeat it, keep an executable built from `337df2b` at `BASELINE_BINARY` and build the candidate:

```sh
cargo build --locked --release
node scripts/compare-engines.mjs BASELINE_BINARY target/release/optchat
```

Replace `BASELINE_BINARY` with that executable's path. Both processes use disposable synthetic stores, never your active memory directory.
The trace compares jobs, retry prompts, views, status, failures, appends, search, and reopen behavior.
It also compares embedded snapshot data byte for byte with the baseline HTML. Viewer JavaScript is excluded because its memory handling changed.
It makes no provider calls.

## Driver and transport measurements

From the repository root in `devenv shell`, build the release executable before running the Node harness:

```sh
cargo build --locked --release
node --expose-gc benches/driver.mjs import
OPTCHAT_BENCH_SIZES=100000 node --expose-gc benches/driver.mjs usage
OPTCHAT_BENCH_SIZES=100000 node --expose-gc benches/driver.mjs export
OPTCHAT_BENCH_SIZES=100000 node --expose-gc benches/driver.mjs export_file
OPTCHAT_BENCH_SIZES=1000000 node --expose-gc benches/driver.mjs capText
```

The harness creates private temporary fixtures and deletes them afterward. It never loads a Pi session or calls a provider.
`OPTCHAT_BENCH_SAMPLES` sets the sample count, with three by default. `OPTCHAT_BENCH_BIN` selects an alternative engine executable.
Import defaults to 100 records because each append retains its normal durable-write behavior.
Other modes default to 1k, 10k, and 100k records or code points.

The Node timings exclude fixture generation and engine startup. Import includes the full RPC and every durable append.
Both export modes now include HTML generation, destination writes, and file synchronization, but exclude browser loading.
`export` reproduces the old browse path through a JSON response and Node file writes.
`export_file` streams through Rust and returns only a path. File validation reads only the header and tail, outside the timing.
Usage includes the private ledger read, parsing, deduplication, and formatted report.
The harness asks Node to collect garbage before each sample when `--expose-gc` is present.

Resident memory is memory currently held in RAM. Peak resident memory columns are process high-water marks, not per-operation allocations.
Node's peak includes module loading, fixtures, and earlier samples or sizes within the same invocation.
Rust's peak comes from Linux `/proc` and is blank on other systems.
Run one size per invocation when comparing peaks. Peaks from different processes do not necessarily occur at the same time.

Measured on 2026-10-07 with Node 24.20.0. Raw results are in [`driver.csv`](../benches/results/driver.csv).
This initial export baseline excludes destination writes. The newer side-by-side run below includes them.
The export fixture contains 100k originals and no summaries, unlike the complete-tree export fixture above.

| Case | Median | Node peak | Rust peak |
| --- | ---: | ---: | ---: |
| Import 100 records | 678 ms | 117 MiB | 3.63 MiB |
| Report 100k usage records | 291 ms | 308 MiB | Not used |
| Export 100k originals over RPC | 1.05 s | 1,202 MiB | 388 MiB |

That export produces 130,981,268 bytes of HTML. It confirms substantial memory amplification in the buffered transport.
The streaming paths below address export and usage aggregation costs.

The Pi text cap now scans code points without retaining a character array. It preserves the same head, tail, and omission count.
For one million supplementary Unicode characters, its median changed from 14.9 ms to 12.5 ms.
Whole-process Node peak changed from 168 MiB to 137 MiB in separate runs.
Raw results are in [`cap-before.csv`](../benches/results/cap-before.csv) and [`cap-after.csv`](../benches/results/cap-after.csv).
The view RPC also reuses one rendered string instead of rendering twice.

## Streaming export

Measured on the same host with Node 24.20.0 and Rust 1.98.1, using 100k originals and no summaries.
Both paths use the current Rust build and produce the same 130,981,268-byte HTML snapshot.
Each measurement uses a separate Node process and three samples. Both include destination writes and file synchronization.
Raw results are in [`export-buffered.csv`](../benches/results/export-buffered.csv) and [`export-streamed.csv`](../benches/results/export-streamed.csv).

| Path | Median | Node peak | Rust peak |
| --- | ---: | ---: | ---: |
| Buffered RPC, then Node writes the file | 1.35 s | 1,325 MiB | 389 MiB |
| Rust streams the file, RPC returns its path | 343 ms | 186 MiB | 249 MiB |

The new `export_file` RPC and CLI share a buffered file writer. `/optchat browse` uses the new RPC.
The operation holds the existing writer lock and refuses to overwrite destinations, including symlinks.
The old `export` RPC still returns a full HTML string for compatibility.

Streaming avoids a complete HTML buffer and JSON transport copies. It still holds originals, summaries, the rendered view, and one serialized record in Rust.
Browser loading costs and file size are unchanged. Other RPC requests wait until the snapshot finishes.
Peaks include process startup and fixture generation, so they are not export-only allocation counts.

Tests cover unchanged Unicode and hostile markup, private permissions, short writes, and destination failures.
A Linux file-size-limit test forces a real write failure. The partial file remains and the live writer answers the next request.
The differential trace also compares eight embedded snapshot payloads byte for byte with `337df2b` output.

## Streaming usage reports

The report now reads 64 KiB chunks and aggregates records as it parses them.
It retains attempt IDs for exact deduplication, one unfinished line, totals, and at most 20 warning strings.
Memory still grows with unique IDs and the largest record, not with every decoded record or warning.
The reader uses the existing private-file checks and stops at the next read boundary after loss of store ownership.

Measured with the same 100k-attempt fixture, Node 24.20.0, separate processes, and three samples:

| Implementation | Median | Node peak |
| --- | ---: | ---: |
| Full file and record array | 326 ms | 310 MiB |
| Streaming aggregation | 271 ms | 166 MiB |

Raw results are in [`usage-before.csv`](../benches/results/usage-before.csv) and [`usage-after.csv`](../benches/results/usage-after.csv).
Run `OPTCHAT_BENCH_SIZES=100000 node --expose-gc benches/driver.mjs usage` to measure the current version.
Four 10k-line differential fixtures produced identical reports, including duplicate IDs, malformed lines, Unicode, and final lines without a newline.
Regression tests also cover loss of ownership during a read and an I/O failure after a successfully parsed prefix.
Read failures discard partial totals rather than report them as complete. Warning text still names the file and line.

## Literal search matching

Search prepares one ASCII-folded query and one reusable `memchr::memmem::Finder` per request.
A SIMD byte filter uses a low-frequency query byte. After 32 failed candidates, matching switches to overlapping 8 KiB folded buffers.
The fallback uses the existing library's linear-time matcher. RPC queries remain limited to 256 bytes.
No history index, retained folded copy, Unicode normalization, or new dependency is introduced.

Measured against `337df2b` with the expanded harness on the same host:

| Case | Before | After |
| --- | ---: | ---: |
| Common recent matches, 100k messages | 8.95 µs | 9.34 µs |
| Rare match, 100k messages | 8.25 ms | 8.28 ms |
| No match, 100k messages | 24.2 ms | 5.70 ms |
| Repetitive text, first-byte mismatch | 10.4 µs | 11.9 µs |
| Repetitive text, middle mismatch | 10.8 ms | 12.6 µs |
| Repetitive text, final-byte mismatch | 5.18 ms | 12.6 µs |
| Periodic text, swapped middle pair | 5.41 ms | 834 µs |

Raw results are in [`search-before.csv`](../benches/results/search-before.csv) and [`search-after.csv`](../benches/results/search-after.csv).
Run `cargo bench --locked --bench history -- search` to repeat these cases.
The new query preparation adds one allocation, at most 256 requested bytes per RPC query. It does not allocate per scanned message.
Common and rare-hit timings are roughly unchanged. Small absolute increases are visible above, not hidden by the repetitive-case gains.
Differential tests cover mixed ASCII case, raw non-ASCII bytes, overlapping matches, long helper queries, and buffer boundaries.

## Offline viewer memory

After parsing, the viewer releases duplicate summary-entry arrays. The lookup keeps the summary text.
The parsed originals remain available for search and expansion. The serialized JSON stays intact so saving the live page preserves its history.
One Chromium comparison used the same 100k-message, 211 MiB complete-tree snapshot from the earlier browser check.
After explicit garbage collection, JavaScript heap usage changed from 339,474,781 to 331,476,173 bytes, about 7.6 MiB less.
These are single observations, not peak renderer memory or confidence intervals. DOM storage and the browser's source cache are not included.
The viewer still parses the complete snapshot. This is not lazy data loading.

The check launched Chromium with `--js-flags=--expose-gc --enable-precise-memory-info`.
It read `performance.memory.usedJSHeapSize` after `gc()` in each loaded page.
Search for message 99999, reveal, keyboard focus on the original, and zero external resource requests passed after cleanup.
Raw observations are in [`browser-memory.csv`](../benches/results/browser-memory.csv).

## Changes and remaining costs

Tree keys use a lazy iterator instead of a temporary vector. Completed trees skip scheduler scans.
Incremental candidate sets now avoid rescanning incomplete histories on each pump.
Regression tests compare merge order with the original replay algorithm.

Text helpers slice UTF-8 strings without building `Vec<char>`. Cache boundaries use four stack slots. Rendering writes directly into one output buffer. Message-size validation no longer constructs a discarded source string. Equivalence tests cover exact cache boundaries, Unicode, CRLF, sparse newlines, and the character cap.

SIMD processes multiple bytes per CPU instruction. Newline searches use `memchr`, which was already a transitive dependency through `serde_json`. Its safe API selects supported CPU instructions at runtime and retains portable fallbacks. No custom CPU intrinsics or native-only compiler flags were added. In intermediate runs, this reduced rendering from about 69 µs to 29 µs and ASCII cache splitting from 59 µs to 4 µs.

Before incremental merge tracking, a Callgrind profile of the optimized 1k-message startup case attributed about 40% of executed instructions to `Memory::fit`. JSON loading and validation account for much of the remainder. That profile includes fixture construction and harness work, so these are instruction shares, not wall-clock shares.

The measured, behavior-preserving pass now covers scheduling, merging, text copies, export transport, usage aggregation, and repetitive search.
Retained originals and full browser parsing still grow with history size. No search semantics or parser changed.
Dense summary arrays, recovery checkpoints, indexes, and alternative parsers remain experiments, not pending implementation promises.
They need a measured startup or memory target and recovery tests before adoption. Batched import needs explicit durability and restart semantics.
Large source strings remain on the heap. Moving them onto the stack increases stack pressure without removing their storage cost.

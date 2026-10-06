# Rust benchmarks

Measure large-history performance before changing the Rust engine. The benchmark uses synthetic histories, not private chat data or model calls.

## Run the benchmarks

From the repository root, enter `devenv shell`. Run the optimized benchmark build:

```sh
cargo bench --locked --bench history > /tmp/optchat-bench.csv
```

The default run covers 1,000, 10,000, and 100,000 messages. Temporary fixtures are removed when the run finishes. Allow about a minute for the baseline implementation.

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
| `search_common/N` | Find one full page near the newest end of an already loaded history |
| `search_rare/N` | Scan all eligible originals for a match at ID 4 |
| `search_miss/N` | Scan all eligible originals for absent text |
| `cache_blocks/ascii`, `cache_blocks/unicode` | Split a large view at character-based cache boundaries |
| `cap/ascii`, `cap/unicode` | Cap a large tool result without splitting Unicode characters |
| `flatten/ascii`, `flatten/unicode` | Replace line endings with spaces |

Fixture creation is outside measurements. Append samples restore the fixture and reopen it before timing. Pending-job samples reopen the same incomplete fixture before timing. Startup results use warm filesystem pages, not cold disk reads. These cases do not measure model latency, full RPC serialization, or a completely unsummarized 100,000-message history.

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

At 100k messages, rendering drops from 1,600 allocation requests to one. Idle scheduling drops from 16.8 MB of requested allocations to zero. Pending-job scheduling drops from 18.9 MB to 0.88 MB, but still scans the incomplete tree. Durable append includes a scheduler scan across tree keys, so its cost also grows with history size. Filesystem synchronization adds timing variance. No durability guarantee changed.

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
The export RPC also holds the HTML response in the Pi process. No automatic size limit or background export is provided.

## Changes and remaining costs

Tree keys now use a lazy iterator instead of a temporary vector. Completed trees skip scheduler scans. Startup maintains the view's byte count locally during replay, rather than repeatedly summing every visible node. Regression tests compare merge order with the original replay algorithm.

Text helpers slice UTF-8 strings without building `Vec<char>`. Cache boundaries use four stack slots. Rendering writes directly into one output buffer. Message-size validation no longer constructs a discarded source string. Equivalence tests cover exact cache boundaries, Unicode, CRLF, sparse newlines, and the character cap.

SIMD processes multiple bytes per CPU instruction. Newline searches use `memchr`, which was already a transitive dependency through `serde_json`. Its safe API selects supported CPU instructions at runtime and retains portable fallbacks. No custom CPU intrinsics or native-only compiler flags were added. In intermediate runs, this reduced rendering from about 69 µs to 29 µs and ASCII cache splitting from 59 µs to 4 µs.

A Callgrind profile of the optimized 1k-message startup case attributed about 40% of executed instructions to `Memory::fit`. JSON loading and validation account for much of the remainder. That profile includes fixture construction and harness work, so these are instruction shares, not wall-clock shares.

Further work can target merge-candidate searches and incomplete-tree scheduling. Replacing the JSON parser or adding a ready queue needs separate measurements and recovery tests. Large source strings still belong on the heap. Moving them onto the stack would increase stack pressure without removing their storage cost.

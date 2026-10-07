# Binary protocol

`optchat --dir PATH serve` holds one writer lock until stdin closes or the process exits.
It accepts one JSON object per line on stdin.
It writes one response per line to stdout.
Diagnostics go to stderr.

Every request accepts an optional `request_id` value.
The response returns that value unchanged, or `null` when absent.
Requests run in order.

```json
{"request_id":1,"op":"append","kind":"user","text":"Use Rust."}
{"request_id":1,"ok":true,"result":{"i":0,"kind":"user","text":"Use Rust.","size":15,"date":"2026-01-01T12:00:00+00:00"}}
```

The date above is illustrative. New messages use the local clock.
An error returns `{"request_id":1,"ok":false,"error":"..."}`.
Malformed requests, including invalid UTF-8 lines, do not stop the server.
Do not retry an append after a lost response. Inspect the log first because the write can already be durable.

## Actions

| `op` | Fields | Result |
|---|---|---|
| `append` | `kind`, `text`, optional RFC3339 `date` | Saved message |
| `status` | None | Message/node/part counts, bytes, budget, `settled`, busy job count |
| `view` | Optional `display` boolean, default false | `view`, `blocks`, `settled` |
| `prepare` | Nonempty `texts` array of strings | Previous `view`, cache `blocks`, joined `text`, new message `ids` |
| `jobs` | None | Newly issued compactor jobs, at most eight active |
| `submit` | `l`, `i`, `text` | `retry`: next job payload or `null` when saved |
| `fail` | `l`, `i` | `retry_after_ms`: 10000 |
| `zoom` | `id`, `n` | Two child lines, or the whole original message for `n=1` |
| `date` | `id` | Local RFC3339 time |
| `search` | `text`, optional `before`, optional `include_tools` | Bounded `hits` and `next_before` |
| `import` | `messages` array | `imported` count |
| `export` | None | HTML snapshot as a string (buffered, for compatibility) |
| `export_file` | `file`: destination path | `file`: saved path, after flush and file sync |
| `prompts` | None | Constant `master` and `view` instructions |

Message kinds are `user`, `talk`, `tool`, `echo`, and `note`.
There is no reasoning/thought kind.
An `echo` over 30,000 Unicode characters keeps its head and tail, with an omission notice.
Other kinds are not truncated.

`view` rejects unsettled memory unless `display` is true.
Use `display` only for a human preview, never as model input.
`prepare` also rejects unsettled memory.
When settled, it captures the view before it appends the new user messages.
Each message is durable before its append returns.
A multi-message prepare or import is not an atomic disk transaction.
If a write fails halfway through a batch, earlier records remain in the log.
The process rejects further writes after a storage error. Restart it to recover.

## Export

Send `{"op":"export_file","file":"snapshot.html"}` to stream a snapshot directly to a new file.
The result is `{"file":"snapshot.html"}`, without transporting the HTML through JSON.
Relative paths use the server's working directory. The parent directory must exist.
The existing writer holds its lock throughout generation, buffer flush, and file synchronization. Other requests wait until export finishes.
The CLI and `/optchat browse PATH` use this same writer. Pi resolves relative paths against its own working directory first.

Creation refuses existing entries, including symlinks. New files use mode `0600` on Unix.
An export error names the destination. A partial file can remain after failure or interruption.
The exporter never unlinks a failed destination because another process could have replaced that path.
A destination failure does not poison the memory log or stop the server. File sync does not include parent-directory sync.

Both export modes work while summaries are pending and leave memory unchanged.
The snapshot contains the model view, every original record, and all stored summaries. It is not a filtered or redacted export.
The original `{"op":"export"}` remains available and returns the whole HTML string without writing a file.
Use it only when you need that buffered response. The streamed path avoids full-document copies in Rust and Pi.

Original text is embedded as inert JSON and displayed as text, never interpreted as HTML.
The page blocks network access and loads no external assets. JavaScript enables tree expansion and local search.
Without JavaScript, only the model view is visible. The snapshot does not update after export.
There is no export size cap. The file and browser data grow with the entire history, not just the visible tree.
Streaming uses scratch space for the rendered view, one serialized record, and the file buffer. Originals remain loaded in Rust.
See [snapshot usage](../README.md#browse-a-memory-snapshot) and [measurements](benchmarks.md#export-measurements).

## Search

Send `{"op":"search","text":"Rust"}` to search stored original text, even when summaries are pending.
Search does not change messages, IDs, or dates. It excludes summaries and the generated `kind: ` prefix.
It returns newest IDs first, with at most 20 hits. By default, it searches `user`, `talk`, and `note` records.
Set `include_tools: true` to include `tool` and `echo` records.

`text` must contain 1–256 UTF-8 bytes, without NUL, and cannot contain only whitespace.
Other whitespace stays part of the query. Matching folds ASCII letters only. Non-ASCII bytes must match exactly.
Search does not interpret regex syntax or normalize Unicode.

An illustrative result is:

```json
{"hits":[{"id":0,"date":"2026-01-01T12:00:00+00:00","kind":"user","snippet":"Use Rust.","covering":{"id":0,"n":1}}],"next_before":null}
```

Each snippet contains at most 240 UTF-8 bytes, with `…` marking clipped text. Snippets never split a code point.
`covering` identifies the current view line containing the hit, or is null when absent.
Use its `id` and `n` with `zoom` to expand that line. Use the hit's `id` with `zoom(id, 1)` for the full original.
An incomplete summary can still prevent expansion of a covering line.

When `next_before` is non-null, pass it as `before` to request older hits.
`before` is an exclusive, nonnegative integer ID. New appends do not duplicate records across older pages.
A null cursor means no older matches remain. Search scans only far enough to find one extra match and does not count all matches.

The serialized result, excluding the RPC envelope, is at most 32,768 bytes. JSON escape sequences count toward this limit.
A page can end before 20 hits when its remaining space is too small.
If one hit cannot fit an empty page, search returns an error naming the message ID rather than silently skipping it.
This can occur with an imported RFC3339 date containing an extreme number of fractional digits. Stored dates remain unchanged.

## Compactor driver

A compactor converts a long message or two child summaries into one summary.
The caller supplies model access. Rust supplies prompts, scheduling, byte counts, and retry feedback.
Keep the same server process for the whole job lifecycle.

1. Call `jobs` after startup, every append, and each completed job.
2. For each returned job, send its constant `system` and `messages` to a model without tools.
3. Submit the reply with the job's `l` and `i`.
4. If `retry` is a job, continue the same model conversation with its new feedback.
5. If a model call fails, call `fail`. After ten seconds, call `jobs` again.

Run at most eight jobs concurrently. Rust enforces this limit across requests.
The first message in a job contains two text blocks: prior context, then the compression step.
The context has no generated ids or placeholders.
The step contains the whole source and an exact 512-byte scale example.

Keep native assistant messages during retries, including reasoning signatures required by the provider.
Only submit their visible text to Rust.
Rust trims replies and keeps the shortest of up to five attempts.
After five attempts, a summary can exceed 512 bytes. The view uses actual byte sizes.
An empty reply fails the job and starts the ten-second delay.

Short sources produce free nodes without a model call.
Level-zero jobs run in message order. Ready merges can run alongside them.
The driver must bound model request time and return failures to Rust.
If the driver stops, close stdin first so the server finishes its current write, then terminate it if needed.

## Addresses and storage

A line `id+n` covers `n` messages starting at `id`.
`n` must be a power of two, `id` must align with `n`, and the range must exist.
Tree coordinates are `l=log2(n)` and `i=id/n`.

The directory contains:

```text
lock
main/YYYY-MM-DD.jsonl
tree/YYYY-MM-DD.jsonl
```

Messages have `{i,kind,text,size,date}`.
Nodes have `{l,i,text,size}`.
Sizes count UTF-8 bytes. Message size includes the `kind: ` prefix.
Files use the local day of the write, not the imported message date.

Import requires contiguous ids starting at the next unused id.
It validates the entire batch before writing and preserves supplied dates.
Oversized imported tool results are rejected rather than silently changed.
Do not edit ids, delete old records, or run another writer against the same directory.

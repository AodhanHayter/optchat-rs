pub mod protocol;
pub mod store;

use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write,
    path::Path,
    time::{Duration, Instant},
};
use store::{Key, Message, Store};

pub const NODE: usize = 512;
pub const VIEW: usize = 128_000;
pub const JOBS: usize = 8;
pub const TRIES: usize = 5;
pub const RETRY: Duration = Duration::from_secs(10);
pub const HITS: usize = 20;
pub const QUERY: usize = 256;
pub const SNIPPET: usize = 240;
pub const PAYLOAD: usize = 32_768;
pub const KINDS: [&str; 3] = ["user", "talk", "note"];
pub const TOOL_KINDS: [&str; 2] = ["tool", "echo"];
/// Room for `{"hits":[...],"next_before":<id>}` around the serialized hits.
const ENVELOPE: usize = 64;
/// Bytes of context kept before a match, so the hit is not flush against the clip.
const LEAD: usize = 48;
const ELLIPSIS: &str = "…";
pub const PLACEHOLDER: &str = "(not summarized yet: zoom it)";
pub const COMPACT: &str = include_str!("../prompts/compact.txt");
pub const MASTER: &str = include_str!("../prompts/master.txt");
pub const VIEW_DOC: &str = include_str!("../prompts/view.txt");
// A real-shaped byte ruler, not padding; checked in tests.
pub const SCALE: &str = "user: keep the parser small; errors must name the file and line; use standard tools over new dependencies. talk: traced the crash to an empty input reaching the index builder; fixed the shared guard and added a regression test. tool: read src/index.rs and ran cargo test. echo: index maps document names to byte offsets; all tests passed. user: next, import the old notes without changing their dates or ids; never discard original text. talk: import remains unstarted; the append-only log is the source of truth";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextMessage {
    pub role: String,
    pub content: Value,
}
/// The view part that currently covers a hit; readers expand it with `zoom(id, n)`.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Covering {
    pub id: usize,
    pub n: usize,
}
#[derive(Clone, Debug, Serialize)]
pub struct Hit {
    pub id: usize,
    pub date: String,
    pub kind: String,
    pub snippet: String,
    pub covering: Option<Covering>,
}
/// One bounded page of hits. `next_before` is the cursor for the next older page.
#[derive(Clone, Debug, Serialize)]
pub struct Page {
    pub hits: Vec<Hit>,
    pub next_before: Option<usize>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub l: u32,
    pub i: usize,
    pub system: &'static str,
    pub messages: Vec<TextMessage>,
}
struct Active {
    job: Job,
    tries: Vec<String>,
}

pub struct Memory {
    pub store: Store,
    pub view: Vec<Key>,
    budget: usize,
    busy: BTreeMap<Key, Active>,
    failed: BTreeMap<Key, Instant>,
    frontier: usize,
    automatic: BTreeSet<Key>,
    pending: BTreeSet<Key>,
    view_bytes: usize,
    merges: Vec<BTreeSet<usize>>,
}
impl Memory {
    pub fn open(path: &Path, budget: usize) -> Result<Self> {
        ensure!(budget > 0, "view budget must be positive");
        let store = Store::open(path)?;
        let mut mem = Self {
            store,
            view: Vec::new(),
            budget,
            busy: BTreeMap::new(),
            failed: BTreeMap::new(),
            frontier: 0,
            automatic: BTreeSet::new(),
            pending: BTreeSet::new(),
            view_bytes: 0,
            merges: Vec::new(),
        };
        for i in 0..mem.store.root.len() {
            let key = Key { l: 0, i };
            mem.view.push(key);
            mem.view_bytes += mem.text(key).len();
            mem.consider_merge(key);
            mem.fit(i + 1);
        }
        // Missing view parts are always leaves: a merge requires a saved parent.
        mem.frontier = mem
            .view
            .iter()
            .find(|k| !mem.store.nodes.contains_key(k))
            .map_or(mem.store.root.len(), |k| k.i);
        if !mem.complete() {
            mem.enqueue(Key {
                l: 0,
                i: mem.frontier,
            });
            for key in mem.keys().filter(|key| key.l > 0) {
                mem.enqueue(key);
            }
        }
        mem.free()?;
        Ok(mem)
    }
    fn text(&self, key: Key) -> &str {
        self.store
            .nodes
            .get(&key)
            .map_or(PLACEHOLDER, |n| n.text.as_str())
    }
    pub fn size(&self) -> usize {
        self.view_bytes
    }
    pub fn settled(&self) -> bool {
        self.frontier == self.store.root.len()
    }
    pub fn first(&self) -> usize {
        self.frontier
    }
    fn consider_merge(&mut self, key: Key) {
        let a = Key {
            i: key.i & !1,
            ..key
        };
        let parent = Key {
            l: a.l + 1,
            i: a.i / 2,
        };
        if !self.store.nodes.contains_key(&parent) {
            return;
        }
        let Ok(p) = self
            .view
            .binary_search_by_key(&a.start().unwrap(), |k| k.start().unwrap())
        else {
            return;
        };
        if self.view[p] != a || self.view.get(p + 1) != Some(&Key { i: a.i + 1, ..a }) {
            return;
        }
        self.merges
            .resize_with(self.merges.len().max(a.l as usize + 1), BTreeSet::new);
        self.merges[a.l as usize].insert(a.i);
    }
    fn fit(&mut self, total: usize) {
        while self.view_bytes > self.budget {
            let mut best: Option<Key> = None;
            // Within a level the leftmost pair always wins. Across levels the
            // score changes with total, so compare afresh rather than cache it.
            for (l, candidates) in self.merges.iter().enumerate() {
                let Some(&i) = candidates.first() else {
                    continue;
                };
                let a = Key { l: l as u32, i };
                if best.is_none_or(|b| {
                    let left = (total - a.start().unwrap()) as u128 * b.width().unwrap() as u128;
                    let right = (total - b.start().unwrap()) as u128 * a.width().unwrap() as u128;
                    left > right || (left == right && a.start() < b.start())
                }) {
                    best = Some(a);
                }
            }
            let Some(a) = best else { break };
            let p = self
                .view
                .binary_search_by_key(&a.start().unwrap(), |k| k.start().unwrap())
                .unwrap();
            let parent = Key {
                l: a.l + 1,
                i: a.i / 2,
            };
            self.view_bytes -= self.text(a).len() + self.text(self.view[p + 1]).len();
            self.view_bytes += self.text(parent).len();
            self.view.splice(p..p + 2, [parent]);
            self.merges[a.l as usize].remove(&a.i);
            self.consider_merge(parent);
        }
    }
    pub fn append(&mut self, kind: &str, text: &str, date: Option<&str>) -> Result<Message> {
        let m = self.store.append(kind, text, date)?;
        let key = Key { l: 0, i: m.i };
        self.view.push(key);
        self.view_bytes += self.text(key).len();
        self.consider_merge(key);
        self.fit(self.store.root.len());
        if m.i == self.frontier {
            self.enqueue(Key { l: 0, i: m.i });
        }
        self.free()?;
        Ok(m)
    }
    fn enqueue(&mut self, key: Key) {
        if key.end().is_none_or(|end| end > self.store.root.len())
            || self.store.nodes.contains_key(&key)
            || self.busy.contains_key(&key)
            || self.failed.contains_key(&key)
        {
            return;
        }
        let size = if key.l == 0 {
            self.store.root[key.i].size
        } else {
            let a = Key {
                l: key.l - 1,
                i: key.i * 2,
            };
            let b = Key { i: a.i + 1, ..a };
            let (Some(a), Some(b)) = (self.store.nodes.get(&a), self.store.nodes.get(&b)) else {
                return;
            };
            a.size + 1 + b.size
        };
        if size <= NODE {
            self.automatic.insert(key);
        } else {
            self.pending.insert(key);
        }
    }
    fn next_ready(&self, candidates: &BTreeSet<Key>) -> Option<Key> {
        // At each level, all eligible IDs precede the frontier. Skip whole blocked
        // ranges instead of walking recovered summaries from later in the log.
        for l in (0..usize::BITS).take_while(|l| (self.store.root.len() >> l) > 0) {
            if let Some(&key) = candidates
                .range(Key { l, i: 0 }..Key { l: l + 1, i: 0 })
                .next()
            {
                let end = if l == 0 { key.i } else { key.end().unwrap() };
                if end <= self.frontier {
                    return Some(key);
                }
            }
        }
        None
    }
    fn keys(&self) -> impl Iterator<Item = Key> + use<> {
        let len = self.store.root.len();
        (0..usize::BITS)
            .take_while(move |l| (len >> l) > 0)
            .flat_map(move |l| (0..(len >> l)).map(move |i| Key { l, i }))
    }
    fn source(&self, key: Key) -> String {
        if key.l == 0 {
            self.store.root[key.i].source()
        } else {
            format!(
                "{}\n{}",
                self.text(Key {
                    l: key.l - 1,
                    i: key.i * 2
                }),
                self.text(Key {
                    l: key.l - 1,
                    i: key.i * 2 + 1
                })
            )
        }
    }
    fn save(&mut self, key: Key, text: String) -> Result<()> {
        let visible = self
            .view
            .binary_search_by_key(&key.start().unwrap(), |k| k.start().unwrap())
            .is_ok_and(|p| self.view[p] == key);
        let old_size = self.text(key).len();
        self.store.save_node(key, text)?;
        self.failed.remove(&key);
        if visible {
            self.view_bytes = self.view_bytes - old_size + self.text(key).len();
        }
        if key.l > 0 {
            self.consider_merge(Key {
                l: key.l - 1,
                i: key.i * 2,
            });
        }
        self.fit(self.store.root.len());
        if key.l == 0 && key.i == self.frontier {
            while self.frontier < self.store.root.len()
                && self.store.nodes.contains_key(&Key {
                    l: 0,
                    i: self.frontier,
                })
            {
                self.frontier += 1;
            }
            self.enqueue(Key {
                l: 0,
                i: self.frontier,
            });
        }
        self.enqueue(Key {
            l: key.l + 1,
            i: key.i / 2,
        });
        Ok(())
    }
    fn complete(&self) -> bool {
        // A valid tree has floor(n / 2^l) nodes at each level, including leaves.
        let mut len = self.store.root.len();
        let mut total = 0;
        while len > 0 {
            total += len;
            len >>= 1;
        }
        // Store recovery and insertion must keep nodes within the valid key set.
        let complete = self.store.nodes.len() == total;
        debug_assert!(!complete || self.keys().all(|key| self.store.nodes.contains_key(&key)));
        complete
    }
    fn free(&mut self) -> Result<()> {
        if self.complete() {
            return Ok(());
        }
        let expired: Vec<_> = self
            .failed
            .iter()
            .filter(|(_, time)| time.elapsed() >= RETRY)
            .map(|(&key, _)| key)
            .collect();
        for key in expired {
            self.failed.remove(&key);
            self.enqueue(key);
        }
        while let Some(key) = self.next_ready(&self.automatic) {
            self.automatic.remove(&key);
            self.save(key, self.source(key))?;
        }
        Ok(())
    }
    pub fn jobs(&mut self) -> Result<Vec<Job>> {
        self.free()?;
        if self.complete() {
            return Ok(Vec::new());
        }
        let mut jobs = Vec::new();
        while self.busy.len() < JOBS {
            let Some(key) = self.next_ready(&self.pending) else {
                break;
            };
            self.pending.remove(&key);
            let end = if key.l == 0 {
                key.i
            } else {
                key.end().unwrap()
            };
            let context = self.render_context(end);
            let source = if key.l == 0 {
                self.source(key)
            } else {
                format!(
                    "{}\n{}",
                    flatten(self.text(Key {
                        l: key.l - 1,
                        i: key.i * 2
                    })),
                    flatten(self.text(Key {
                        l: key.l - 1,
                        i: key.i * 2 + 1
                    }))
                )
            };
            let action = if key.l == 0 {
                "Compress this message into one line"
            } else {
                "Merge these two lines into one"
            };
            let step = format!(
                "For scale, this line is exactly 512 bytes:\n{SCALE}\n\n{action}, in at most 512 bytes:\n{source}"
            );
            let job = Job {
                l: key.l,
                i: key.i,
                system: COMPACT,
                messages: vec![TextMessage {
                    role: "user".into(),
                    content: {
                        let mut blocks = cache_blocks(&context);
                        blocks.push(json!({"type":"text","text":step}));
                        json!(blocks)
                    },
                }],
            };
            self.busy.insert(
                key,
                Active {
                    job: job.clone(),
                    tries: Vec::new(),
                },
            );
            jobs.push(job);
        }
        Ok(jobs)
    }
    pub fn submit(&mut self, key: Key, reply: &str) -> Result<Option<Job>> {
        ensure!(self.busy.contains_key(&key), "node is not an active job");
        let text = reply.trim().to_owned();
        if text.is_empty() {
            self.fail(key)?;
            bail!("empty summary; retry in 10 seconds");
        }
        let active = self.busy.get_mut(&key).unwrap();
        active.tries.push(text.clone());
        if text.len() > NODE && active.tries.len() < TRIES {
            active.job.messages.push(TextMessage {
                role: "assistant".into(),
                content: json!(text),
            });
            active.job.messages.push(TextMessage { role:"user".into(),content:json!(format!("That line is {} bytes; the limit is 512. It must end where it is cut here:\n{}| ← LIMIT",text.len(),byte_prefix(&text,NODE))) });
            return Ok(Some(active.job.clone()));
        }
        let shortest = active.tries.iter().min_by_key(|t| t.len()).unwrap().clone();
        self.save(key, shortest)?;
        self.busy.remove(&key);
        self.free()?;
        Ok(None)
    }
    pub fn fail(&mut self, key: Key) -> Result<()> {
        ensure!(
            self.busy.remove(&key).is_some(),
            "node is not an active job"
        );
        self.failed.insert(key, Instant::now());
        Ok(())
    }
    pub fn render(&self) -> String {
        let mut out = String::with_capacity(self.size() + self.view.len() * 24 + 14);
        out.push_str("<chat>\n");
        for key in &self.view {
            write!(out, "{}+{}|", key.start().unwrap(), key.width().unwrap()).unwrap();
            flatten_into(&mut out, self.text(*key));
            out.push('\n');
        }
        out.push_str("</chat>");
        out
    }
    pub fn render_context(&self, end: usize) -> String {
        let mut out = String::from("<chat>\n");
        // Only complete view parts before the boundary; never expose placeholders or future text.
        for key in &self.view {
            if key.end().unwrap() > end {
                break;
            }
            if let Some(n) = self.store.nodes.get(key) {
                flatten_into(&mut out, &n.text);
                out.push('\n');
            }
        }
        out.push_str("</chat>");
        out
    }
    pub fn zoom(&self, id: usize, n: usize) -> Result<String> {
        ensure!(
            n.is_power_of_two()
                && id.is_multiple_of(n)
                && id
                    .checked_add(n)
                    .is_some_and(|end| end <= self.store.root.len()),
            "No line {id}+{n}."
        );
        if n == 1 {
            return Ok(format!("{id}+0|{}", self.store.root[id].source()));
        }
        let half = n / 2;
        let mut lines = Vec::new();
        for start in [id, id + half] {
            let key = Key {
                l: half.trailing_zeros(),
                i: start / half,
            };
            let node =
                self.store.nodes.get(&key).ok_or_else(|| {
                    anyhow::anyhow!("No line {id}+{n}: children not summarized yet.")
                })?;
            lines.push(format!("{start}+{half}|{}", flatten(&node.text)));
        }
        Ok(lines.join("\n"))
    }
    /// The view part covering `id`, or `None` when the view does not reach it.
    fn covering(&self, id: usize) -> Option<Covering> {
        // The view tiles the log in order, so the covering part is one binary search away.
        let at = self
            .view
            .partition_point(|k| k.end().is_some_and(|end| end <= id));
        let key = *self.view.get(at)?;
        let (start, n) = (key.start()?, key.width()?);
        (start <= id).then_some(Covering { id: start, n })
    }
    /// Literal, newest-first search over original text only. It reads the log, not the
    /// settled view, so it answers while compaction is still pending. `before` is an
    /// exclusive id, so appends can never duplicate a message onto an older page.
    pub fn search(&self, text: &str, before: Option<usize>, include_tools: bool) -> Result<Page> {
        // Bytes, not characters: the serialized payload and snippets are byte-bounded too.
        ensure!(
            !text.is_empty() && text.len() <= QUERY,
            "search text must be 1 to {QUERY} bytes"
        );
        ensure!(!text.contains('\0'), "search text must not contain NUL");
        ensure!(
            text.chars().any(|c| !c.is_whitespace()),
            "search text must not be whitespace only"
        );
        let end = before.unwrap_or(usize::MAX).min(self.store.root.len());
        let needle = text.as_bytes().to_ascii_lowercase();
        let finder = memchr::memmem::Finder::new(&needle);
        let pivot = pivot(&needle);
        let mut hits: Vec<Hit> = Vec::new();
        let mut room = PAYLOAD - ENVELOPE;
        let mut next_before = None;
        for m in self.store.root[..end].iter().rev() {
            if !(KINDS.contains(&m.kind.as_str())
                || (include_tools && TOOL_KINDS.contains(&m.kind.as_str())))
            {
                continue;
            }
            let Some(at) = find_folded(m.text.as_bytes(), &needle, pivot, &finder) else {
                continue;
            };
            // One extra match decides the cursor; matches are never counted or collected.
            if hits.len() == HITS {
                next_before = hits.last().map(|h| h.id);
                break;
            }
            let hit = Hit {
                id: m.i,
                date: m.date.clone(),
                kind: m.kind.clone(),
                snippet: snippet(&m.text, at),
                covering: self.covering(m.i),
            };
            // Measure the escaped form: control characters cost six bytes each, and an
            // imported RFC3339 date has no digit limit, so one record can fill the page.
            let size = serde_json::to_string(&hit)?.len() + usize::from(!hits.is_empty());
            if size > room {
                ensure!(
                    !hits.is_empty(),
                    "search hit for message {} exceeds the {PAYLOAD}-byte payload limit",
                    m.i
                );
                next_before = hits.last().map(|h| h.id);
                break;
            }
            room = room.saturating_sub(size);
            hits.push(hit);
        }
        Ok(Page { hits, next_before })
    }
    pub fn date(&self, id: usize) -> Result<String> {
        let m = self
            .store
            .root
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("No message {id}."))?;
        Ok(chrono::DateTime::parse_from_rfc3339(&m.date)?
            .with_timezone(&chrono::Local)
            .to_rfc3339())
    }
    pub fn status(&self) -> Value {
        json!({"messages":self.store.root.len(),"nodes":self.store.nodes.len(),"parts":self.view.len(),"bytes":self.size(),"budget":self.budget,"settled":self.settled(),"busy":self.busy.len()})
    }
}

pub fn flatten(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    flatten_into(&mut out, text);
    out
}
fn flatten_into(out: &mut String, text: &str) {
    let mut start = 0;
    for i in memchr::memchr2_iter(b'\r', b'\n', text.as_bytes()) {
        out.push_str(&text[start..i]);
        if text.as_bytes()[i] != b'\n' || i == 0 || text.as_bytes()[i - 1] != b'\r' {
            out.push(' ');
        }
        start = i + 1;
    }
    out.push_str(&text[start..]);
}
/// Literal search folding only ASCII case; every other byte must match exactly.
/// Memory::search prepares the folded query once, then scans without per-message allocation.
pub fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    let needle = needle.to_ascii_lowercase();
    find_folded(
        haystack,
        &needle,
        pivot(&needle),
        &memchr::memmem::Finder::new(&needle),
    )
}
fn pivot(needle: &[u8]) -> usize {
    // Prefer a rare byte within the query, breaking ties toward its end. This
    // avoids probing every position in runs such as aaaa...b...aaaa.
    let mut counts = [0usize; 256];
    for &byte in needle {
        counts[usize::from(byte)] += 1;
    }
    needle
        .iter()
        .enumerate()
        .rev()
        .min_by_key(|(_, byte)| counts[usize::from(**byte)])
        .map_or(0, |(at, _)| at)
}
fn find_folded(
    haystack: &[u8],
    needle: &[u8],
    pivot: usize,
    finder: &memchr::memmem::Finder<'_>,
) -> Option<usize> {
    let &byte = needle.get(pivot)?;
    let limit = haystack.len().checked_sub(needle.len())?;
    let mut from = 0;
    // A few SIMD-filtered candidates keep ordinary short messages cheap. If the
    // filter is ineffective, switch to the linear-time matcher instead of rescanning.
    for _ in 0..32 {
        if from > limit {
            return None;
        }
        let at = from
            + memchr::memchr2(
                byte,
                byte.to_ascii_uppercase(),
                &haystack[from + pivot..=limit + pivot],
            )?;
        if haystack[at..at + needle.len()].eq_ignore_ascii_case(needle) {
            return Some(at);
        }
        from = at + 1;
    }
    let mut buffer = [0; 8192];
    // The public byte helper also accepts needles beyond the RPC's 256-byte limit.
    if needle.len() > buffer.len() / 2 {
        return finder
            .find(&haystack[from..].to_ascii_lowercase())
            .map(|at| from + at);
    }
    while from <= limit {
        let len = buffer.len().min(haystack.len() - from);
        let chunk = &mut buffer[..len];
        chunk.copy_from_slice(&haystack[from..from + len]);
        chunk.make_ascii_lowercase();
        if let Some(at) = finder.find(chunk) {
            return Some(from + at);
        }
        // Overlap by needle length minus one, so matches may cross buffer boundaries.
        from += len - needle.len() + 1;
    }
    None
}
/// A bounded window around the first match. Clipping is marked within the bound,
/// never inside a code point, and the stored text itself is left untouched.
fn snippet(text: &str, at: usize) -> String {
    if text.len() <= SNIPPET {
        return text.to_owned();
    }
    let mut start = at.saturating_sub(LEAD);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let head = if start > 0 { ELLIPSIS } else { "" };
    let mut room = SNIPPET - head.len();
    let tail = if start + room < text.len() {
        ELLIPSIS
    } else {
        ""
    };
    room -= tail.len();
    let mut out = String::with_capacity(SNIPPET);
    out.push_str(head);
    out.push_str(byte_prefix(&text[start..], room));
    out.push_str(tail);
    out
}
pub fn byte_prefix(text: &str, limit: usize) -> &str {
    let mut end = limit.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn cache_blocks(view: &str) -> Vec<Value> {
    let mut cuts = [0; 4];
    let mut count = 1;
    let ascii = view.is_ascii();
    let mut chars = view.char_indices();
    let mut previous = 0;
    for mark in [50_000, 80_000, 100_000] {
        let byte = if ascii {
            if mark >= view.len() {
                break;
            }
            mark
        } else {
            let Some((byte, _)) = chars.nth(mark - previous) else {
                break;
            };
            previous = mark + 1;
            byte
        };
        if let Some(p) = memchr::memrchr(b'\n', &view.as_bytes()[..byte])
            && p + 1 > cuts[count - 1]
        {
            cuts[count] = p + 1;
            count += 1;
        }
    }
    let mut blocks = Vec::with_capacity(count);
    for pair in cuts[..count].windows(2) {
        blocks.push(json!({"type":"text","text":&view[pair[0]..pair[1]],"cache_control":{"type":"ephemeral"}}));
    }
    blocks.push(json!({"type":"text","text":&view[cuts[count - 1]..]}));
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_failures_reenter_the_ordered_queue_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut mem = Memory::open(dir.path(), VIEW).unwrap();
        for _ in 0..8 {
            mem.append("user", &"x".repeat(300), None).unwrap();
        }
        let jobs = mem.jobs().unwrap();
        assert_eq!(jobs.len(), 4);
        for job in &jobs {
            mem.fail(Key { l: job.l, i: job.i }).unwrap();
        }
        assert!(mem.jobs().unwrap().is_empty());
        // Advance only the failure timestamps, not wall time or scheduler state.
        for time in mem.failed.values_mut() {
            *time = Instant::now() - RETRY;
        }
        let retried = mem.jobs().unwrap();
        assert_eq!(
            retried.iter().map(|j| (j.l, j.i)).collect::<Vec<_>>(),
            jobs.iter().map(|j| (j.l, j.i)).collect::<Vec<_>>()
        );
        assert!(mem.jobs().unwrap().is_empty());
        for job in retried {
            assert!(
                mem.submit(Key { l: job.l, i: job.i }, "short")
                    .unwrap()
                    .is_none()
            );
        }
        assert!(mem.jobs().unwrap().is_empty());
        assert_eq!(mem.store.nodes.len(), 15);
    }
}

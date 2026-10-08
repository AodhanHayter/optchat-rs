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
use store::{CAP, Key, Message, Node, Store};

pub const NODE: usize = 512;
/// The chat view's high mark. A batch merges it down to half of this.
pub const VIEW: usize = 128_000;
pub const JOBS: usize = 8;
/// A message's node starts once fewer than this many view lines before it are unbuilt.
pub const WINDOW: usize = 8;
pub const TRIES: usize = 5;
/// Fallback for a failed call when no new message arrives to retry it.
pub const RETRY: Duration = Duration::from_secs(10);
/// View lines per cache block.
pub const BLOCK: usize = 4;
pub const HITS: usize = 20;
pub const QUERY: usize = 256;
pub const SNIPPET: usize = 240;
pub const PAYLOAD: usize = 32_768;
pub const KINDS: [&str; 4] = ["user", "talk", "work", "note"];
pub const TOOL_KINDS: [&str; 2] = ["tool", "echo"];
/// Room for `{"hits":[...],"next_before":<id>}` around the serialized hits.
const ENVELOPE: usize = 64;
/// Bytes of context kept before a match, so the hit is not flush against the clip.
const LEAD: usize = 48;
const ELLIPSIS: &str = "…";
pub const PLACEHOLDER: &str = "(not summarized yet: zoom it)";
/// The one system prompt shared by turns and compactions.
pub const PROMPT: &str = include_str!("../prompts/system.txt");

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
/// A compaction. The caller sends it with the turns' own system prompt and tools.
#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub l: u32,
    pub i: usize,
    pub messages: Vec<TextMessage>,
}
struct Active {
    job: Job,
    tries: Vec<String>,
}

fn text_len(nodes: &BTreeMap<Key, Node>, key: Key) -> usize {
    nodes.get(&key).map_or(PLACEHOLDER.len(), |n| n.text.len())
}

/// Nodes covering messages `[0, end)` in order. Lines are appended one per message and
/// merged in batches: past `high` bytes, the most due pairs merge until `low`.
#[derive(Clone, Default)]
struct Tiling {
    keys: Vec<Key>,
    bytes: usize,
    /// Per level, the left index of each adjacent sibling pair whose parent is built.
    merges: Vec<BTreeSet<usize>>,
    /// A batch that could not reach its low mark continues at each new message.
    merging: bool,
}
impl Tiling {
    fn position(&self, key: Key) -> Option<usize> {
        let p = self
            .keys
            .binary_search_by_key(&key.start()?, |k| k.start().unwrap())
            .ok()?;
        (self.keys[p] == key).then_some(p)
    }
    fn push(&mut self, key: Key, nodes: &BTreeMap<Key, Node>) {
        self.keys.push(key);
        self.bytes += text_len(nodes, key);
        self.consider(key, nodes);
    }
    /// Records `key`'s sibling pair as a merge candidate if both lines are adjacent here
    /// and their parent is built.
    fn consider(&mut self, key: Key, nodes: &BTreeMap<Key, Node>) {
        let a = Key {
            i: key.i & !1,
            ..key
        };
        if !nodes.contains_key(&Key {
            l: a.l + 1,
            i: a.i / 2,
        }) {
            return;
        }
        let Some(p) = self.position(a) else { return };
        if self.keys.get(p + 1) != Some(&Key { i: a.i + 1, ..a }) {
            return;
        }
        self.merges
            .resize_with(self.merges.len().max(a.l as usize + 1), BTreeSet::new);
        self.merges[a.l as usize].insert(a.i);
    }
    fn resize(&mut self, key: Key, old: usize, new: usize) {
        if self.position(key).is_some() {
            self.bytes = self.bytes - old + new;
        }
    }
    /// Merges the most due pair, repeatedly, until `target` bytes or no built parent is
    /// left. A pair is due by how long ago it ended, in its own line size:
    /// `(total - last) / 2^l`, the oldest of equal pairs first. Returns whether it merged.
    fn merge_down(&mut self, total: usize, target: usize, nodes: &BTreeMap<Key, Node>) -> bool {
        let mut merged = false;
        while self.bytes > target {
            let mut best: Option<Key> = None;
            // Within a level the leftmost pair is the most due. Across levels the order
            // depends on total, so compare the level heads afresh.
            for (l, candidates) in self.merges.iter().enumerate() {
                let Some(&i) = candidates.first() else {
                    continue;
                };
                let a = Key { l: l as u32, i };
                if best.is_none_or(|b| {
                    let age = |k: Key| {
                        (total - (k.start().unwrap() + 2 * k.width().unwrap() - 1)) as u128
                    };
                    let left = age(a) * b.width().unwrap() as u128;
                    let right = age(b) * a.width().unwrap() as u128;
                    left > right || (left == right && a.start() < b.start())
                }) {
                    best = Some(a);
                }
            }
            let Some(a) = best else { break };
            let p = self.position(a).unwrap();
            let parent = Key {
                l: a.l + 1,
                i: a.i / 2,
            };
            self.bytes -= text_len(nodes, a) + text_len(nodes, self.keys[p + 1]);
            self.bytes += text_len(nodes, parent);
            self.keys.splice(p..p + 2, [parent]);
            self.merges[a.l as usize].remove(&a.i);
            self.consider(parent, nodes);
            merged = true;
        }
        merged
    }
    /// The sawtooth: nothing merges until `high` is passed, then one batch merges down
    /// to `low`, continuing at later messages if built parents run out first.
    fn step(&mut self, total: usize, high: usize, low: usize, nodes: &BTreeMap<Key, Node>) -> bool {
        if self.bytes > high {
            self.merging = true;
        }
        if !self.merging {
            return false;
        }
        let merged = self.merge_down(total, low, nodes);
        if self.bytes <= low {
            self.merging = false;
        }
        merged
    }
}

pub struct Memory {
    pub store: Store,
    /// The chat view every turn sees. Saved to view.json and never rebuilt from the log.
    view: Tiling,
    /// The compactions' view: the chat view merged further, to a quarter of its size.
    context: Tiling,
    budget: usize,
    busy: BTreeMap<Key, Active>,
    failed: BTreeMap<Key, Instant>,
    /// Leaves not built yet. Only leaves can be unbuilt view lines.
    unbuilt: BTreeSet<usize>,
    automatic: BTreeSet<Key>,
    pending: BTreeSet<Key>,
}
impl Memory {
    /// `budget` is the chat view's high mark: batches merge it to `budget / 2`, and the
    /// compaction view lives between `budget / 8` and `budget / 4`.
    pub fn open(path: &Path, budget: usize) -> Result<Self> {
        ensure!(budget > 0, "view budget must be positive");
        let store = Store::open(path)?;
        let mut mem = Self {
            store,
            view: Tiling::default(),
            context: Tiling::default(),
            budget,
            busy: BTreeMap::new(),
            failed: BTreeMap::new(),
            unbuilt: BTreeSet::new(),
            automatic: BTreeSet::new(),
            pending: BTreeSet::new(),
        };
        let total = mem.store.root.len();
        mem.unbuilt = (0..total)
            .filter(|&i| !mem.store.nodes.contains_key(&Key { l: 0, i }))
            .collect();
        let saved = mem.store.load_view();
        let found = saved.is_some();
        for key in saved.unwrap_or_default() {
            mem.view.push(key, &mem.store.nodes);
        }
        let end = mem.view.keys.last().map_or(0, |k| k.end().unwrap());
        for i in end..total {
            mem.view.push(Key { l: 0, i }, &mem.store.nodes);
            // Every merge is saved, so messages after the save only appended their lines.
            // A store with no saved view is folded once, batching as it would have live.
            if !found {
                mem.view
                    .step(i + 1, mem.high(), mem.low(), &mem.store.nodes);
            }
        }
        if !found || end < total {
            mem.store.save_view(&mem.view.keys)?;
        }
        mem.derive_context(total);
        if !mem.complete() {
            for i in mem.unbuilt.clone() {
                mem.enqueue(Key { l: 0, i });
            }
            for key in mem.keys().filter(|key| key.l > 0) {
                mem.enqueue(key);
            }
        }
        mem.free()?;
        Ok(mem)
    }
    fn high(&self) -> usize {
        self.budget
    }
    fn low(&self) -> usize {
        self.budget / 2
    }
    /// Copies the chat view and merges it down to the compaction view's low mark.
    fn derive_context(&mut self, total: usize) {
        self.context = self.view.clone();
        self.context.merging = true;
        self.context
            .step(total, self.budget / 4, self.budget / 8, &self.store.nodes);
    }
    fn text(&self, key: Key) -> &str {
        self.store
            .nodes
            .get(&key)
            .map_or(PLACEHOLDER, |n| n.text.as_str())
    }
    pub fn view(&self) -> &[Key] {
        &self.view.keys
    }
    pub fn context_view(&self) -> &[Key] {
        &self.context.keys
    }
    pub fn size(&self) -> usize {
        self.view.bytes
    }
    pub fn context_size(&self) -> usize {
        self.context.bytes
    }
    pub fn settled(&self) -> bool {
        self.unbuilt.is_empty()
    }
    /// The first message whose view line is not built, or the message count.
    pub fn first(&self) -> usize {
        self.unbuilt
            .first()
            .copied()
            .unwrap_or(self.store.root.len())
    }
    /// Logs one text. A tool result was already clipped; any other text too long for
    /// one message is logged whole, as several messages in a row.
    pub fn log(&mut self, kind: &str, text: &str, date: Option<&str>) -> Result<Vec<Message>> {
        if kind == "echo" {
            return Ok(vec![self.append(kind, text, date)?]);
        }
        split(text)
            .into_iter()
            .map(|part| self.append(kind, part, date))
            .collect()
    }
    /// Logs one message, appends its line, and runs the view's batch rule.
    pub fn append(&mut self, kind: &str, text: &str, date: Option<&str>) -> Result<Message> {
        let m = self.store.append(kind, text, date)?;
        let total = self.store.root.len();
        // A failed call is tried again at the next message.
        for key in std::mem::take(&mut self.failed).into_keys() {
            self.enqueue(key);
        }
        let key = Key { l: 0, i: m.i };
        self.unbuilt.insert(m.i);
        self.view.push(key, &self.store.nodes);
        self.context.push(key, &self.store.nodes);
        if self
            .view
            .step(total, self.high(), self.low(), &self.store.nodes)
        {
            self.store.save_view(&self.view.keys)?;
            self.derive_context(total);
        } else {
            self.context
                .step(total, self.budget / 4, self.budget / 8, &self.store.nodes);
        }
        self.enqueue(key);
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
    /// The next node a call may build: a merge as soon as both halves are built, and a
    /// message once fewer than WINDOW lines before it are unbuilt. Lower levels first.
    fn next_ready(&self) -> Option<Key> {
        for l in (0..usize::BITS).take_while(|l| (self.store.root.len() >> l) > 0) {
            if let Some(&key) = self
                .pending
                .range(Key { l, i: 0 }..Key { l: l + 1, i: 0 })
                .next()
                && (l > 0 || self.unbuilt.range(..key.i).take(WINDOW).count() < WINDOW)
            {
                return Some(key);
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
    fn children(key: Key) -> [Key; 2] {
        let a = Key {
            l: key.l - 1,
            i: key.i * 2,
        };
        [a, Key { i: a.i + 1, ..a }]
    }
    fn source(&self, key: Key) -> String {
        if key.l == 0 {
            self.store.root[key.i].source()
        } else {
            let [a, b] = Self::children(key);
            format!("{}\n{}", self.text(a), self.text(b))
        }
    }
    fn save(&mut self, key: Key, text: String) -> Result<()> {
        let old = text_len(&self.store.nodes, key);
        self.store.save_node(key, text)?;
        self.failed.remove(&key);
        let new = text_len(&self.store.nodes, key);
        self.view.resize(key, old, new);
        self.context.resize(key, old, new);
        if key.l == 0 {
            self.unbuilt.remove(&key.i);
        } else {
            // The new parent makes its two children a merge candidate. Merges happen
            // only at the next message, in a batch.
            let [a, _] = Self::children(key);
            self.view.consider(a, &self.store.nodes);
            self.context.consider(a, &self.store.nodes);
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
    /// Retries expired failures and builds every node that needs no call.
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
        while let Some(key) = self.automatic.pop_first() {
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
            let Some(key) = self.next_ready() else {
                break;
            };
            self.pending.remove(&key);
            let job = Job {
                l: key.l,
                i: key.i,
                messages: vec![TextMessage {
                    role: "user".into(),
                    content: {
                        let end = if key.l == 0 {
                            key.i
                        } else {
                            key.end().unwrap()
                        };
                        let mut blocks = cache_blocks(&self.render_context(end));
                        blocks.push(json!({"type":"text","text":self.task(key)}));
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
    /// The compaction task, verbatim from the design; the ruler is NODE dashes.
    fn task(&self, key: Key) -> String {
        let ruler = "-".repeat(NODE);
        if key.l == 0 {
            return format!(
                "Compaction: compress message {} into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n{ruler}\n<input>\n{}\n</input>",
                key.i,
                self.source(key)
            );
        }
        let [a, b] = Self::children(key);
        let name = |k: Key| format!("{}+{}", k.start().unwrap(), k.width().unwrap());
        format!(
            "Compaction: merge lines {} and {}, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n{ruler}\n<chat> may hold their messages, {} to {}, in more detail: take details\nof them from there too.\n<input>\n{}\n{}\n</input>",
            name(a),
            name(b),
            key.start().unwrap(),
            key.end().unwrap() - 1,
            flatten(self.text(a)),
            flatten(self.text(b))
        )
    }
    pub fn submit(&mut self, key: Key, reply: &str) -> Result<Option<Job>> {
        ensure!(self.busy.contains_key(&key), "node is not an active job");
        let text = reply.trim().to_owned();
        if text.is_empty() {
            self.fail(key)?;
            bail!("empty summary; retried at the next message");
        }
        let active = self.busy.get_mut(&key).unwrap();
        active.tries.push(text.clone());
        if text.len() > NODE && active.tries.len() < TRIES {
            active.job.messages.push(TextMessage {
                role: "assistant".into(),
                content: json!(text),
            });
            active.job.messages.push(TextMessage {
                role: "user".into(),
                content: json!(format!(
                    "Too long: your line is {} bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n{}| ← LIMIT",
                    text.len(),
                    byte_prefix(&text, NODE)
                )),
            });
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
    fn render_keys<'a>(&self, out: &mut String, keys: impl Iterator<Item = &'a Key>) {
        for key in keys {
            write!(out, "{}+{}|", key.start().unwrap(), key.width().unwrap()).unwrap();
            flatten_into(out, self.text(*key));
            out.push('\n');
        }
    }
    pub fn render(&self) -> String {
        let mut out = String::with_capacity(self.size() + self.view.keys.len() * 24 + 14);
        out.push_str("<chat>\n");
        self.render_keys(&mut out, self.view.keys.iter());
        out.push_str("</chat>");
        out
    }
    /// The compaction view up to message `end`, stopping at its first unbuilt line, so
    /// no call sees a placeholder, half a message, or text after its node.
    pub fn render_context(&self, end: usize) -> String {
        let mut out = String::from("<chat>\n");
        let keys = self
            .context
            .keys
            .iter()
            .take_while(|k| k.end().unwrap() <= end && self.store.nodes.contains_key(k));
        self.render_keys(&mut out, keys);
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
            .keys
            .partition_point(|k| k.end().is_some_and(|end| end <= id));
        let key = *self.view.keys.get(at)?;
        let (start, n) = (key.start()?, key.width()?);
        (start <= id).then_some(Covering { id: start, n })
    }
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
        json!({"messages":self.store.root.len(),"nodes":self.store.nodes.len(),"parts":self.view.keys.len(),"bytes":self.size(),"context_bytes":self.context_size(),"budget":self.budget,"settled":self.settled(),"busy":self.busy.len()})
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

/// Splits a non-tool text into messages of at most CAP characters, losing nothing.
pub fn split(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut rest = text;
    while let Some((at, _)) = rest.char_indices().nth(CAP) {
        parts.push(&rest[..at]);
        rest = &rest[at..];
    }
    parts.push(rest);
    parts
}

/// The view as text blocks of BLOCK lines each, the `<chat>` line riding with the first.
/// Only the last whole block carries a cache mark: blocks never change once whole, so
/// the next call finds this mark by looking back from its own.
pub fn cache_blocks(view: &str) -> Vec<Value> {
    let mut cuts = vec![0];
    for (n, p) in memchr::memchr_iter(b'\n', view.as_bytes()).enumerate() {
        if n > 0 && n % BLOCK == 0 {
            cuts.push(p + 1);
        }
    }
    let marked = cuts.len() - 1;
    if cuts[marked] < view.len() || marked == 0 {
        cuts.push(view.len());
    }
    let mut blocks = Vec::with_capacity(cuts.len() - 1);
    for (n, pair) in cuts.windows(2).enumerate() {
        let text = &view[pair[0]..pair[1]];
        blocks.push(if n + 1 == marked {
            json!({"type":"text","text":text,"cache_control":{"type":"ephemeral"}})
        } else {
            json!({"type":"text","text":text})
        });
    }
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

    #[test]
    fn failed_jobs_retry_at_the_next_message() {
        let dir = tempfile::tempdir().unwrap();
        let mut mem = Memory::open(dir.path(), VIEW).unwrap();
        mem.append("user", &"x".repeat(600), None).unwrap();
        let job = mem.jobs().unwrap().remove(0);
        mem.fail(Key { l: job.l, i: job.i }).unwrap();
        assert!(mem.jobs().unwrap().is_empty());
        mem.append("user", "next", None).unwrap();
        assert_eq!(mem.jobs().unwrap()[0].i, 0);
    }

    /// Taelin's rollback `push` with `life` 0: newest first, each entry `(keep, state)`.
    fn push(states: &mut Vec<(bool, usize)>, mut value: usize) {
        for depth in 0.. {
            let Some(&(keep, state)) = states.get(depth) else {
                states.push((false, value));
                return;
            };
            if !keep {
                states[depth].0 = true;
                return;
            }
            states[depth] = (false, value);
            value = state;
        }
    }

    /// The design's check: with push's list length as the budget, the due rule picks
    /// exactly the merges push makes, at every step.
    #[test]
    fn due_rule_reproduces_taelins_push() {
        let mut states = Vec::new();
        let mut nodes = BTreeMap::new();
        let mut view = Tiling::default();
        for t in 0..=20_000usize {
            push(&mut states, t);
            let total = t + 1;
            // Build the leaf and every parent it completes, one byte each.
            let mut built = Vec::new();
            for l in 0..usize::BITS {
                let width = 1usize << l;
                if !total.is_multiple_of(width) {
                    break;
                }
                let key = Key {
                    l,
                    i: total / width - 1,
                };
                nodes.insert(
                    key,
                    Node {
                        l,
                        i: key.i,
                        text: "x".into(),
                        size: 1,
                    },
                );
                built.push(key);
            }
            view.push(Key { l: 0, i: t }, &nodes);
            for key in built.into_iter().skip(1) {
                view.consider(
                    Key {
                        l: key.l - 1,
                        i: key.i * 2,
                    },
                    &nodes,
                );
            }
            view.merge_down(total, states.len(), &nodes);
            let mut starts: Vec<usize> = states.iter().map(|&(_, s)| s).collect();
            starts.reverse();
            starts.push(total);
            let expected: Vec<Key> = starts
                .windows(2)
                .map(|w| {
                    let width = w[1] - w[0];
                    assert!(width.is_power_of_two() && w[0].is_multiple_of(width));
                    Key {
                        l: width.trailing_zeros(),
                        i: w[0] / width,
                    }
                })
                .collect();
            assert_eq!(view.keys, expected, "t={t}");
        }
    }
}

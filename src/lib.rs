pub mod protocol;
pub mod store;

use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
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
        };
        let mut size = 0;
        for i in 0..mem.store.root.len() {
            let key = Key { l: 0, i };
            mem.view.push(key);
            size += mem.text(key).len();
            size = mem.fit(i + 1, size);
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
        self.view.iter().map(|k| self.text(*k).len()).sum()
    }
    pub fn settled(&self) -> bool {
        self.view.iter().all(|k| self.store.nodes.contains_key(k))
    }
    pub fn first(&self) -> usize {
        self.view
            .iter()
            .find(|k| !self.store.nodes.contains_key(k))
            .and_then(|k| k.start())
            .unwrap_or(self.store.root.len())
    }
    fn fit(&mut self, total: usize, mut size: usize) -> usize {
        while size > self.budget {
            let mut best: Option<(usize, usize, usize)> = None;
            for (p, pair) in self.view.windows(2).enumerate() {
                let (a, b) = (pair[0], pair[1]);
                if a.l != b.l
                    || a.i % 2 != 0
                    || b.i != a.i + 1
                    || !self.store.nodes.contains_key(&Key {
                        l: a.l + 1,
                        i: a.i / 2,
                    })
                {
                    continue;
                }
                let age = total - a.start().unwrap();
                let width = a.width().unwrap();
                if best.is_none_or(|(_, ba, bw)| {
                    (age as u128) * (bw as u128) > (ba as u128) * (width as u128)
                }) {
                    best = Some((p, age, width));
                }
            }
            let Some((p, _, _)) = best else {
                break;
            };
            let a = self.view[p];
            let parent = Key {
                l: a.l + 1,
                i: a.i / 2,
            };
            size -= self.text(a).len() + self.text(self.view[p + 1]).len();
            size += self.text(parent).len();
            self.view.splice(p..p + 2, [parent]);
        }
        size
    }
    pub fn append(&mut self, kind: &str, text: &str, date: Option<&str>) -> Result<Message> {
        let m = self.store.append(kind, text, date)?;
        self.view.push(Key { l: 0, i: m.i });
        self.fit(self.store.root.len(), self.size());
        self.free()?;
        Ok(m)
    }
    fn ready(&self, key: Key) -> bool {
        if self.store.nodes.contains_key(&key)
            || self.busy.contains_key(&key)
            || self.failed.get(&key).is_some_and(|t| t.elapsed() < RETRY)
        {
            return false;
        }
        let end = if key.l == 0 {
            key.i
        } else {
            key.end().unwrap()
        };
        end <= self.first()
            && (key.l == 0
                || (0..2).all(|j| {
                    self.store.nodes.contains_key(&Key {
                        l: key.l - 1,
                        i: key.i * 2 + j,
                    })
                }))
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
        self.store.save_node(key, text)?;
        self.failed.remove(&key);
        self.fit(self.store.root.len(), self.size());
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
        // Incomplete trees still scan per pump; benchmark before adding a ready queue.
        loop {
            if self.complete() {
                return Ok(());
            }
            let mut changed = false;
            for key in self.keys() {
                if self.ready(key) {
                    let source = self.source(key);
                    if source.len() <= NODE {
                        self.save(key, source)?;
                        changed = true;
                    }
                }
            }
            if !changed {
                return Ok(());
            }
        }
    }
    pub fn jobs(&mut self) -> Result<Vec<Job>> {
        self.free()?;
        if self.complete() {
            return Ok(Vec::new());
        }
        let mut jobs = Vec::new();
        for key in self.keys() {
            if self.busy.len() >= JOBS {
                break;
            }
            if !self.ready(key) {
                continue;
            }
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

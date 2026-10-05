use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

pub const CAP: usize = 30_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub i: usize,
    pub kind: String,
    pub text: String,
    pub size: usize,
    pub date: String,
}
impl Message {
    pub fn source(&self) -> String {
        format!("{}: {}", self.kind, self.text)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            ["user", "talk", "tool", "echo", "note"].contains(&self.kind.as_str()),
            "invalid message kind: {}",
            self.kind
        );
        ensure!(
            self.size == self.source().len(),
            "incorrect message size at {}",
            self.i
        );
        DateTime::parse_from_rfc3339(&self.date).context("date must be RFC3339")?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct Key {
    pub l: u32,
    pub i: usize,
}
impl Key {
    pub fn width(self) -> Option<usize> {
        1usize.checked_shl(self.l)
    }
    pub fn start(self) -> Option<usize> {
        self.i.checked_mul(self.width()?)
    }
    pub fn end(self) -> Option<usize> {
        self.i.checked_add(1)?.checked_mul(self.width()?)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub l: u32,
    pub i: usize,
    pub text: String,
    pub size: usize,
}
impl Node {
    pub fn key(&self) -> Key {
        Key {
            l: self.l,
            i: self.i,
        }
    }
}

pub struct Store {
    pub root: Vec<Message>,
    pub nodes: BTreeMap<Key, Node>,
    dir: PathBuf,
    _lock: File,
    poisoned: bool,
}
impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        private_dir(dir)?;
        let lock = private_options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("lock"))?;
        lock.try_lock()
            .context("memory is already open by another process")?;
        // A crash between a file fsync and its directory fsync leaves a cached, unsynced entry.
        for sub in ["main", "tree"] {
            private_dir(&dir.join(sub))?;
            sync_dir(&dir.join(sub))?;
        }
        sync_dir(dir)?;
        let mut root: Vec<Message> = read_stream(&dir.join("main"))?;
        root.sort_by_key(|m| m.i);
        for (i, m) in root.iter().enumerate() {
            m.validate()?;
            ensure!(
                m.i == i,
                "non-contiguous or duplicate message id {}; expected {i}; restore log from backup",
                m.i
            );
        }
        let mut nodes = BTreeMap::new();
        // Day files are named by the local clock, so a parent can precede its children on disk.
        let mut stream = read_stream::<Node>(&dir.join("tree"))?;
        stream.sort_by_key(|n| n.l);
        for n in stream {
            let key = n.key();
            let valid = !n.text.trim().is_empty()
                && n.size == n.text.len()
                && key.end().is_some_and(|end| end <= root.len())
                && (key.l == 0
                    || (0..2).all(|j| {
                        nodes.contains_key(&Key {
                            l: key.l - 1,
                            i: key.i * 2 + j,
                        })
                    }));
            if valid {
                nodes.insert(key, n);
            } else {
                // Within a level the latest valid record wins: it is the one the live process used.
                eprintln!(
                    "skipped invalid, duplicate, or orphan tree node {}:{}",
                    key.l, key.i
                );
            }
        }
        Ok(Self {
            root,
            nodes,
            dir: dir.to_owned(),
            _lock: lock,
            poisoned: false,
        })
    }
    pub fn append(&mut self, kind: &str, text: &str, date: Option<&str>) -> Result<Message> {
        let text = if kind == "echo" {
            cap(text)
        } else {
            text.to_owned()
        };
        let m = Message {
            i: self.root.len(),
            size: kind.len() + 2 + text.len(),
            kind: kind.into(),
            text,
            date: date
                .map(str::to_owned)
                .unwrap_or_else(|| Local::now().to_rfc3339()),
        };
        m.validate()?;
        self.write("main", &m)?;
        self.root.push(m.clone());
        Ok(m)
    }
    pub fn save_node(&mut self, key: Key, text: String) -> Result<()> {
        ensure!(!self.nodes.contains_key(&key), "node already built");
        let node = Node {
            l: key.l,
            i: key.i,
            size: text.len(),
            text,
        };
        self.write("tree", &node)?;
        self.nodes.insert(key, node);
        Ok(())
    }
    fn write(&mut self, stream: &str, value: &impl Serialize) -> Result<()> {
        ensure!(
            !self.poisoned,
            "storage write failed earlier; restart to recover before writing again"
        );
        // A write or fsync error has an unknown durable outcome. Do not reuse its id.
        self.poisoned = true;
        let dir = self.dir.join(stream);
        let path = dir.join(format!("{}.jsonl", Local::now().format("%Y-%m-%d")));
        let new = !path.exists();
        let mut file = private_options().create(true).append(true).open(&path)?;
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        let written = file.write(&bytes)?;
        // A partial write is a torn record. Never update in-memory state after it.
        if written != bytes.len() {
            bail!("partial log write: restart to recover {}", path.display());
        }
        file.sync_all()?;
        if new {
            sync_dir(&dir)?;
        }
        self.poisoned = false;
        Ok(())
    }
}

// Windows does not support Unix directory fsync. File contents are still flushed,
// but a power loss can lose newly created directory entries on Windows.
fn sync_dir(_path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(_path)?.sync_all()?;
    Ok(())
}

fn private_dir(path: &Path) -> Result<()> {
    let absolute = std::path::absolute(path)?;
    let missing: Vec<_> = absolute
        .ancestors()
        .take_while(|p| !p.exists())
        .map(Path::to_owned)
        .collect();
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path)?;
    // Persist directory entries too, including newly created parents of the chat directory.
    for created in missing.iter().rev() {
        if let Some(parent) = created.parent() {
            sync_dir(parent)?;
        }
    }
    Ok(())
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    options.mode(0o600);
    options
}

fn read_stream<T: DeserializeOwned>(dir: &Path) -> Result<Vec<T>> {
    let mut paths = fs::read_dir(dir)?
        .map(|e| e.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    paths.retain(|p| p.extension().is_some_and(|e| e == "jsonl"));
    paths.sort();
    let mut result = Vec::new();
    for path in paths {
        let mut bytes = Vec::new();
        File::open(&path)?.read_to_end(&mut bytes)?;
        for (line, chunk) in bytes.split(|b| *b == b'\n').enumerate() {
            if chunk.is_empty() {
                continue;
            }
            match serde_json::from_slice(chunk) {
                Ok(value) => result.push(value),
                Err(e) => eprintln!(
                    "{}:{}: skipped torn/invalid JSON: {e}",
                    path.display(),
                    line + 1
                ),
            }
        }
        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            let mut file = OpenOptions::new().append(true).open(&path)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
        }
    }
    Ok(result)
}

pub fn cap(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= CAP {
        return text.into();
    }
    // Reserve room for the omission notice within the cap itself.
    let keep = CAP - 80;
    let head = keep / 2;
    let tail = keep - head;
    format!(
        "{}\n[... {} characters omitted ...]\n{}",
        chars[..head].iter().collect::<String>(),
        chars.len() - keep,
        chars[chars.len() - tail..].iter().collect::<String>()
    )
}

//! Deterministic large-history benchmarks. Fixture creation is outside measurements.
use optchat::{
    Memory, VIEW, cache_blocks, flatten,
    protocol::html,
    store::{CAP, Message, Node, Store, cap},
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    fs::{self, File},
    hint::black_box,
    io::{BufWriter, Write},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed},
    time::{Duration, Instant},
};
use tempfile::{TempDir, tempdir};

struct Allocator;
static COUNT: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every operation forwards the unchanged pointer/layout to System.
// Counters only observe allocation requests; no memory is inspected or retained.
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if COUNT.load(Relaxed) {
            ALLOCS.fetch_add(1, Relaxed);
            BYTES.fetch_add(layout.size(), Relaxed);
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if COUNT.load(Relaxed) {
            ALLOCS.fetch_add(1, Relaxed);
            BYTES.fetch_add(size, Relaxed);
        }
        unsafe { System.realloc(ptr, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Allocator = Allocator;

fn fixture(count: usize, summarized: usize) -> TempDir {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("main")).unwrap();
    fs::create_dir(dir.path().join("tree")).unwrap();
    let mut root = BufWriter::new(File::create(dir.path().join("main/2026-01-01.jsonl")).unwrap());
    let mut tree = BufWriter::new(File::create(dir.path().join("tree/2026-01-01.jsonl")).unwrap());
    for i in 0..count {
        let kind = ["user", "talk", "tool", "echo"][i % 4];
        let text = format!(
            "message {i}: {}",
            "source code, logs, and Unicode 🦀\n".repeat(32)
        );
        let message = Message {
            i,
            kind: kind.into(),
            size: kind.len() + 2 + text.len(),
            text,
            date: "2026-01-01T00:00:00Z".into(),
        };
        serde_json::to_writer(&mut root, &message).unwrap();
        root.write_all(b"\n").unwrap();
    }
    for l in 0..usize::BITS {
        let width = 1usize << l;
        if width > count {
            break;
        }
        for i in 0..summarized / width {
            let text = format!(
                "user: summary {l}:{i}: {}",
                "measured changes, tests, and outcomes; ".repeat(11)
            );
            let node = Node {
                l,
                i,
                size: text.len(),
                text,
            };
            serde_json::to_writer(&mut tree, &node).unwrap();
            tree.write_all(b"\n").unwrap();
        }
    }
    root.flush().unwrap();
    tree.flush().unwrap();
    dir
}

fn bench<T>(name: &str, mut run: impl FnMut() -> T) {
    let start = Instant::now();
    drop(black_box(run()));
    let iterations = (100_000 / start.elapsed().as_nanos().max(1)).clamp(1, 10_000) as usize;
    bench_with_setup(name, || (), |_| run(), iterations);
}

fn bench_with_setup<S, T>(
    name: &str,
    mut setup: impl FnMut() -> S,
    mut run: impl FnMut(&mut S) -> T,
    iterations: usize,
) {
    drop(black_box(run(&mut setup()))); // Warm filesystem pages and code before timing.
    let mut samples = Vec::new();
    let start = Instant::now();
    while samples.len() < 5 || start.elapsed() < Duration::from_millis(200) {
        let mut state = setup();
        let start = Instant::now();
        for _ in 0..iterations {
            drop(black_box(run(black_box(&mut state))));
        }
        samples.push(start.elapsed());
    }
    samples.sort_unstable();
    let mut state = setup();
    ALLOCS.store(0, Relaxed);
    BYTES.store(0, Relaxed);
    COUNT.store(true, Relaxed);
    for _ in 0..iterations {
        drop(black_box(run(black_box(&mut state))));
    }
    COUNT.store(false, Relaxed);
    println!(
        "{name},{:.3},{},{},{},{iterations}",
        samples[samples.len() / 2].as_secs_f64() * 1e6 / iterations as f64,
        ALLOCS.load(Relaxed) / iterations,
        BYTES.load(Relaxed) / iterations,
        samples.len()
    );
}

fn main() {
    let filter = std::env::args()
        .nth(1)
        .filter(|arg| arg != "--bench")
        .unwrap_or_default();
    let sizes = std::env::var("OPTCHAT_BENCH_SIZES").unwrap_or_else(|_| "1000,10000,100000".into());
    println!("case,median_us,allocations,allocated_bytes,samples,iterations_per_sample");
    for count in sizes.split(',').map(|s| s.parse::<usize>().unwrap()) {
        let name = |op: &str| format!("{op}/{count}");
        if ![
            "store_open",
            "memory_open",
            "render",
            "idle_jobs",
            "append",
            "pending_jobs",
            "search_common",
            "search_rare",
            "search_miss",
            "export",
        ]
        .iter()
        .any(|op| name(op).contains(&filter))
        {
            continue;
        }
        let dir = fixture(count, count);
        if name("store_open").contains(&filter) {
            bench(&name("store_open"), || Store::open(dir.path()).unwrap());
        }
        if name("memory_open").contains(&filter) {
            bench(&name("memory_open"), || {
                Memory::open(dir.path(), VIEW).unwrap()
            });
        }
        if [
            "render",
            "idle_jobs",
            "append",
            "search_common",
            "search_rare",
            "search_miss",
            "export",
        ]
        .iter()
        .any(|op| name(op).contains(&filter))
        {
            let mut mem = Memory::open(dir.path(), VIEW).unwrap();
            assert!(mem.settled());
            assert_eq!(mem.store.root.len(), count);
            if name("render").contains(&filter) {
                bench(&name("render"), || mem.render());
            }
            // A full page stops near the newest end; a rare hit and a miss scan everything.
            for (op, query, hits) in [
                (
                    "search_common",
                    "unicode \u{1f980}",
                    (count / 4 * 2 + (count % 4).min(2)).min(20),
                ),
                ("search_rare", "message 4:", usize::from(count > 4)),
                ("search_miss", "no such message text", 0),
            ] {
                if !name(op).contains(&filter) {
                    continue;
                }
                assert_eq!(mem.search(query, None, false).unwrap().hits.len(), hits);
                bench(&name(op), || {
                    mem.search(black_box(query), None, false).unwrap()
                });
            }
            if name("export").contains(&filter) {
                // Lazy rendering in the page does not shrink the embedded history, so the
                // snapshot size is reported next to its generation time, as a comment row.
                println!("# export_bytes/{count},{}", html(&mem).len());
                bench(&name("export"), || html(&mem));
            }
            if name("idle_jobs").contains(&filter) {
                bench(&name("idle_jobs"), || {
                    assert!(mem.jobs().unwrap().is_empty());
                });
            }
            drop(mem);
            if name("append").contains(&filter) {
                // Each sample starts at the same history size. Reopen and rollback are untimed.
                let main_path = dir.path().join(format!(
                    "main/{}.jsonl",
                    chrono::Local::now().format("%Y-%m-%d")
                ));
                let tree_path = dir.path().join(format!(
                    "tree/{}.jsonl",
                    chrono::Local::now().format("%Y-%m-%d")
                ));
                let main_len = fs::metadata(&main_path).map_or(0, |m| m.len());
                let tree_len = fs::metadata(&tree_path).map_or(0, |m| m.len());
                bench_with_setup(
                    &name("append"),
                    || {
                        for (path, len) in [(&main_path, main_len), (&tree_path, tree_len)] {
                            if path.exists() {
                                fs::OpenOptions::new()
                                    .write(true)
                                    .open(path)
                                    .unwrap()
                                    .set_len(len)
                                    .unwrap();
                            }
                        }
                        Memory::open(dir.path(), VIEW).unwrap()
                    },
                    |mem| mem.append("user", "next turn", None).unwrap(),
                    1,
                );
            }
        }
        if name("pending_jobs").contains(&filter) {
            let pending = fixture(count, count.saturating_sub(32));
            bench_with_setup(
                &name("pending_jobs"),
                || Memory::open(pending.path(), VIEW).unwrap(),
                |mem| {
                    let jobs = mem.jobs().unwrap();
                    assert_eq!(jobs.len(), usize::from(count > 0));
                    jobs
                },
                1,
            );
        }
    }
    let ascii = "a line of source code\n".repeat(6_000);
    let unicode = "🦀 café 東京\n".repeat(12_000);
    for (kind, text) in [("ascii", ascii), ("unicode", unicode)] {
        for op in ["cache_blocks", "cap", "flatten"] {
            let name = format!("{op}/{kind}");
            if !name.contains(&filter) {
                continue;
            }
            match op {
                "cache_blocks" => bench(&name, || cache_blocks(black_box(&text))),
                "cap" => {
                    assert!(cap(&text).chars().count() <= CAP);
                    bench(&name, || cap(black_box(&text)));
                }
                _ => bench(&name, || flatten(black_box(&text))),
            }
        }
    }
}

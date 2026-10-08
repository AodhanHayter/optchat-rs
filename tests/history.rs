use optchat::{
    Memory, PLACEHOLDER, VIEW,
    store::{Key, Message},
};
use serde_json::json;
use std::{
    fs::{self, File},
    io::{BufWriter, Write},
};
use tempfile::tempdir;

// A naive replay of the design's sawtooth: every message appends its line; past `high`
// bytes, the most due built pair merges, repeatedly, until `high / 2`. A pair is due by
// `(T - last) / 2^l`, the oldest of equal pairs first.
fn reference_view(mem: &Memory, high: usize) -> Vec<Key> {
    let mut view = Vec::new();
    let text_len = |key| {
        mem.store
            .nodes
            .get(&key)
            .map_or(PLACEHOLDER.len(), |n| n.text.len())
    };
    let mut merging = false;
    for i in 0..mem.store.root.len() {
        let total = i + 1;
        view.push(Key { l: 0, i });
        let size = |view: &Vec<Key>| view.iter().map(|k| text_len(*k)).sum::<usize>();
        merging |= size(&view) > high;
        if !merging {
            continue;
        }
        while size(&view) > high / 2 {
            let mut best: Option<(usize, usize, usize)> = None;
            for (p, pair) in view.windows(2).enumerate() {
                let (a, b) = (pair[0], pair[1]);
                if a.l != b.l
                    || a.i % 2 != 0
                    || b.i != a.i + 1
                    || !mem.store.nodes.contains_key(&Key {
                        l: a.l + 1,
                        i: a.i / 2,
                    })
                {
                    continue;
                }
                let age = total - (b.end().unwrap() - 1);
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
            let a = view[p];
            view.splice(
                p..p + 2,
                [Key {
                    l: a.l + 1,
                    i: a.i / 2,
                }],
            );
        }
        merging = size(&view) > high / 2;
    }
    view
}
#[test]
fn render_preserves_lines_and_flattens_crlf() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    assert_eq!(mem.render(), "<chat>\n</chat>");
    mem.append("user", "a\r\nb", None).unwrap();
    mem.append("talk", "c", None).unwrap();
    assert_eq!(mem.render(), "<chat>\n0+1|user: a b\n1+1|talk: c\n</chat>");
}

#[test]
fn message_validation_rejects_incorrect_byte_size() {
    let mut message = Message {
        i: 7,
        kind: "user".into(),
        text: "🦀".into(),
        size: "user: 🦀".len(),
        date: "2026-01-01T00:00:00Z".into(),
    };
    message.validate().unwrap();
    message.size -= 1;
    assert_eq!(
        message.validate().unwrap_err().to_string(),
        "incorrect message size at 7"
    );
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "assertion failed")]
fn complete_tree_assertion_rejects_invalid_key_substitution() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("user", "a", None).unwrap();
    let mut node = mem.store.nodes.remove(&Key { l: 0, i: 0 }).unwrap();
    node.i = 1;
    mem.store.nodes.insert(node.key(), node);
    let _ = mem.jobs();
}

#[test]
fn replay_preserves_merge_order_for_complete_and_incomplete_histories() {
    for (count, summarized) in [
        (257usize, 0usize),
        (257, 240),
        (257, 257),
        (2049, 1),
        (2049, 1536),
        (2049, 2049),
    ] {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("main")).unwrap();
        fs::create_dir(dir.path().join("tree")).unwrap();
        let mut root =
            BufWriter::new(File::create(dir.path().join("main/2026-01-01.jsonl")).unwrap());
        let mut tree =
            BufWriter::new(File::create(dir.path().join("tree/2026-01-01.jsonl")).unwrap());
        // Long leaves and a complete summary prefix keep free() from adding nodes
        // after replay, so the oracle sees the same tree that replay used.
        for i in 0..count {
            let text = "long source message 🦀\n".repeat(40);
            writeln!(root, "{}", json!({"i":i,"kind":"user","size":text.len()+6,"text":text,"date":"2026-01-01T00:00:00Z"})).unwrap();
        }
        for l in 0..=count.ilog2() {
            for i in 0..(summarized >> l) {
                let text = "x".repeat(100 + (i * 17 + l as usize * 97) % 470);
                writeln!(
                    tree,
                    "{}",
                    json!({"l":l,"i":i,"size":text.len(),"text":text})
                )
                .unwrap();
            }
        }
        root.flush().unwrap();
        tree.flush().unwrap();
        for budget in [1, 130, 1024, VIEW] {
            // Without a saved view, open refolds it once from the log, then saves it.
            let _ = fs::remove_file(dir.path().join("view.json"));
            let mut mem = Memory::open(dir.path(), budget).unwrap();
            assert_eq!(
                mem.view(),
                reference_view(&mem, budget),
                "{count}/{summarized}/{budget}"
            );
            assert_eq!(mem.jobs().unwrap().is_empty(), summarized == count);
        }
    }
}

fn summarize_all(mem: &mut Memory) {
    loop {
        let jobs = mem.jobs().unwrap();
        if jobs.is_empty() {
            break;
        }
        for job in jobs {
            mem.submit(Key { l: job.l, i: job.i }, &"s".repeat(300))
                .unwrap();
        }
    }
}

#[test]
fn saved_view_survives_restart_where_a_refold_would_differ() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), 2_000).unwrap();
    for i in 0..40 {
        mem.append("user", &format!("{i} {}", "x".repeat(600)), None)
            .unwrap();
        summarize_all(&mut mem);
    }
    let live = mem.view().to_vec();
    let rendered = mem.render();
    drop(mem);
    let mem = Memory::open(dir.path(), 2_000).unwrap();
    assert_eq!(mem.view(), live);
    assert_eq!(mem.render(), rendered);
    // A refold sees every parent built at once and merges differently: the live view
    // is the one to keep.
    assert_ne!(reference_view(&mem, 2_000), live);
}

#[test]
fn messages_after_the_last_save_append_their_lines_on_open() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("user", "first", None).unwrap();
    drop(mem);
    // Simulate a crash after the log write, before any later save of the view.
    let saved = fs::read(dir.path().join("view.json")).unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("talk", "second", None).unwrap();
    drop(mem);
    fs::write(dir.path().join("view.json"), saved).unwrap();
    let mem = Memory::open(dir.path(), VIEW).unwrap();
    assert_eq!(mem.view(), [Key { l: 0, i: 0 }, Key { l: 0, i: 1 }]);
    assert_eq!(
        fs::read_to_string(dir.path().join("view.json")).unwrap(),
        "[[0,0],[0,1]]"
    );
}

#[test]
fn invalid_saved_views_are_refolded_from_the_log() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    for text in ["a", "b", "c"] {
        mem.append("user", text, None).unwrap();
    }
    drop(mem);
    let leaves = [Key { l: 0, i: 0 }, Key { l: 0, i: 1 }, Key { l: 0, i: 2 }];
    // A torn file, a gap, a line past the log, and a parent never built.
    for bad in [
        "[[0,0],[0,",
        "[[0,0],[0,2]]",
        "[[0,0],[0,1],[0,2],[0,3]]",
        "[[2,0]]",
    ] {
        fs::write(dir.path().join("view.json"), bad).unwrap();
        let mem = Memory::open(dir.path(), VIEW).unwrap();
        assert_eq!(mem.view(), leaves, "{bad}");
    }
}

#[test]
fn the_view_is_a_sawtooth_between_half_and_full_budget() {
    let dir = tempdir().unwrap();
    let budget = 8_000;
    let mut mem = Memory::open(dir.path(), budget).unwrap();
    let mut batches = 0;
    let mut peak = 0;
    for i in 0..400 {
        let old = mem.view().to_vec();
        mem.append("user", &format!("{i} {}", "x".repeat(600)), None)
            .unwrap();
        if mem.view().len() == old.len() + 1 {
            // Between batches the view only grows at its end.
            assert_eq!(&mem.view()[..old.len()], old);
        } else {
            batches += 1;
            assert!(mem.size() <= budget / 2, "{i}: {}", mem.size());
        }
        // One placeholder line past the high mark at most, never more.
        assert!(mem.size() <= budget + 300, "{i}: {}", mem.size());
        summarize_all(&mut mem);
        peak = peak.max(mem.size());
    }
    assert!(batches > 3, "{batches}");
    assert!(peak > budget * 3 / 4, "{peak}");
    // The compaction view is the chat view merged further, within a quarter of it.
    assert!(
        mem.context_size() <= budget / 4 + 300,
        "{}",
        mem.context_size()
    );
    let context = mem.context_view();
    assert!(context.len() < mem.view().len());
    assert_eq!(context.last().unwrap().end(), Some(400));
}

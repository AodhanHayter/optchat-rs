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

// Keep the original replay algorithm as an oracle for incremental size accounting.
fn reference_view(mem: &Memory, budget: usize) -> Vec<Key> {
    let mut view = Vec::new();
    let text_len = |key| {
        mem.store
            .nodes
            .get(&key)
            .map_or(PLACEHOLDER.len(), |n| n.text.len())
    };
    for i in 0..mem.store.root.len() {
        view.push(Key { l: 0, i });
        while view.iter().map(|k| text_len(*k)).sum::<usize>() > budget {
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
                let age = i + 1 - a.start().unwrap();
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
    for summarized in [0, 240, 257] {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("main")).unwrap();
        fs::create_dir(dir.path().join("tree")).unwrap();
        let mut root =
            BufWriter::new(File::create(dir.path().join("main/2026-01-01.jsonl")).unwrap());
        let mut tree =
            BufWriter::new(File::create(dir.path().join("tree/2026-01-01.jsonl")).unwrap());
        // Long leaves and a complete summary prefix keep free() from adding nodes
        // after replay, so the oracle sees the same tree that replay used.
        for i in 0..257 {
            let text = "long source message 🦀\n".repeat(40);
            writeln!(root, "{}", json!({"i":i,"kind":"user","size":text.len()+6,"text":text,"date":"2026-01-01T00:00:00Z"})).unwrap();
        }
        for l in 0..9 {
            for i in 0..(summarized >> l) {
                let text = "x".repeat(100 + (i * 17 + l * 97) % 470);
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
            let mut mem = Memory::open(dir.path(), budget).unwrap();
            assert_eq!(
                mem.view,
                reference_view(&mem, budget),
                "{summarized}/{budget}"
            );
            assert_eq!(mem.jobs().unwrap().is_empty(), summarized == 257);
        }
    }
}

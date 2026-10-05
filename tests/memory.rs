use optchat::{
    Memory, NODE, PLACEHOLDER, SCALE, VIEW, cache_blocks,
    protocol::{Request, dispatch},
    store::{CAP, Key, cap},
};
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::Write,
};
use tempfile::tempdir;

fn finish(mem: &mut Memory) {
    loop {
        let jobs = mem.jobs().unwrap();
        if jobs.is_empty() {
            break;
        }
        for job in jobs {
            mem.submit(
                Key { l: job.l, i: job.i },
                &format!("user: summary of level {} item {}", job.l, job.i),
            )
            .unwrap();
        }
    }
}
fn tiled(mem: &Memory) {
    let mut pos = 0;
    for k in &mem.view {
        assert_eq!(k.start(), Some(pos));
        pos = k.end().unwrap();
    }
    assert_eq!(pos, mem.store.root.len());
}
#[test]
fn persistence_free_nodes_zoom_and_prepare() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    assert_eq!(SCALE.len(), NODE);
    let prepared = dispatch(
        &mut mem,
        Request::Prepare {
            texts: vec!["hello\nworld".into()],
        },
    )
    .unwrap();
    assert_eq!(prepared["view"], "<chat>\n</chat>");
    mem.append("talk", "remember me", Some("2026-01-01T12:00:00+00:00"))
        .unwrap();
    assert_eq!(mem.zoom(0, 1).unwrap(), "0+0|user: hello\nworld");
    assert_eq!(
        mem.zoom(0, 2).unwrap(),
        "0+1|user: hello world\n1+1|talk: remember me"
    );
    assert_eq!(
        mem.store.nodes[&Key { l: 1, i: 0 }].text,
        "user: hello\nworld\ntalk: remember me"
    );
    assert!(mem.zoom(1, 2).is_err());
    assert!(mem.zoom(0, 0).is_err());
    assert!(mem.zoom(0, 3).is_err());
    assert!(mem.zoom(usize::MAX, 1).is_err());
    assert!(mem.append("thought", "private", None).is_err());
    assert!(Memory::open(dir.path(), VIEW).is_err());
    let before = mem.render();
    drop(mem);
    let mem = Memory::open(dir.path(), VIEW).unwrap();
    assert_eq!(before, mem.render());
    assert_eq!(mem.store.root.len(), 2);
    assert!(mem.date(1).unwrap().contains("2026-01-01"));
}
#[test]
fn scheduler_context_retries_and_no_partial_views() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("user", &"a".repeat(700), None).unwrap();
    mem.append("user", &"b".repeat(700), None).unwrap();
    assert!(mem.render().contains(PLACEHOLDER));
    assert!(dispatch(&mut mem, Request::View { display: false }).is_err());
    assert!(
        dispatch(
            &mut mem,
            Request::Prepare {
                texts: vec!["new".into()]
            }
        )
        .is_err()
    );
    assert_eq!(mem.store.root.len(), 2);
    let jobs = mem.jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].i, 0);
    assert_eq!(jobs[0].messages[0].content[0]["text"], "<chat>\n</chat>");
    assert!(
        !jobs[0].messages[0].content[1]["text"]
            .as_str()
            .unwrap()
            .contains("0+1|")
    );
    assert!(mem.jobs().unwrap().is_empty());
    let key = Key { l: 0, i: 0 };
    for n in [600, 580, 590, 570] {
        let retry = mem.submit(key, &"é".repeat(n / 2)).unwrap().unwrap();
        assert!(
            retry
                .messages
                .last()
                .unwrap()
                .content
                .as_str()
                .unwrap()
                .contains("← LIMIT")
        );
    }
    assert!(mem.submit(key, &"é".repeat(290)).unwrap().is_none());
    assert_eq!(mem.store.nodes[&key].size, 570);
    let jobs = mem.jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].i, 1);
    assert!(
        !jobs[0].messages[0].content[0]["text"]
            .as_str()
            .unwrap()
            .contains(PLACEHOLDER)
    );
    mem.submit(Key { l: 0, i: 1 }, "user: second").unwrap();
    finish(&mut mem);
    assert!(mem.settled());
}
#[test]
fn incremental_view_never_splits_and_measures_actual_bytes() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), 130).unwrap();
    for i in 0..128 {
        let old = mem.view.clone();
        mem.append("user", &format!("message {i}: {}", "x".repeat(55)), None)
            .unwrap();
        finish(&mut mem);
        tiled(&mem);
        for part in old {
            assert!(
                mem.view
                    .iter()
                    .any(|p| p.start().unwrap() <= part.start().unwrap()
                        && p.end().unwrap() >= part.end().unwrap())
            );
        }
    }
    assert!(mem.view.iter().any(|k| k.l > 0));
    assert_eq!(
        mem.size(),
        mem.view
            .iter()
            .map(|k| mem.store.nodes[k].size)
            .sum::<usize>()
    );
    // A budget below a root summary is allowed to remain over budget, without spinning.
    let dir2 = tempdir().unwrap();
    let mut tiny = Memory::open(dir2.path(), 1).unwrap();
    tiny.append("user", "a", None).unwrap();
    tiny.append("talk", "b", None).unwrap();
    assert_eq!(tiny.view.len(), 1);
    assert!(tiny.size() > 1);
}
#[test]
fn failed_jobs_wait_and_empty_responses_are_not_saved() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("user", &"long".repeat(200), None).unwrap();
    mem.jobs().unwrap();
    assert!(mem.submit(Key { l: 0, i: 0 }, " \n").is_err());
    assert!(mem.jobs().unwrap().is_empty());
    assert!(mem.store.nodes.is_empty());
}
#[test]
fn torn_tail_is_preserved_repaired_and_reported_without_reusing_valid_ids() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("note", "first", None).unwrap();
    drop(mem);
    let path = fs::read_dir(dir.path().join("main"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{broken")
        .unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    assert_eq!(mem.append("note", "second", None).unwrap().i, 1);
    drop(mem);
    assert!(fs::read_to_string(path).unwrap().contains("{broken\n"));
    assert_eq!(Memory::open(dir.path(), VIEW).unwrap().store.root.len(), 2);
}
#[cfg(unix)]
#[test]
fn storage_failure_poison_prevents_reusing_an_uncertain_id() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    let path = dir.path().join(format!(
        "main/{}.jsonl",
        chrono::Local::now().format("%Y-%m-%d")
    ));
    std::os::unix::fs::symlink("/dev/full", &path).unwrap();
    assert!(mem.append("user", "disk full", None).is_err());
    fs::remove_file(&path).unwrap();
    assert!(
        mem.append("user", "must not write", None)
            .unwrap_err()
            .to_string()
            .contains("restart")
    );
    assert!(!path.exists());
    assert!(mem.store.root.is_empty());
}

#[test]
fn corrupt_tree_is_rebuilt_without_reviving_orphan_parents() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    for _ in 0..2 {
        mem.append("user", &"x".repeat(800), None).unwrap();
    }
    drop(mem);
    let leaf = "user: ".to_owned() + &"a".repeat(400);
    let fixture = format!(
        "{}\n{}\n{{broken\n{}\n",
        json!({"l":1,"i":0,"text":"stale parent","size":12}),
        json!({"l":0,"i":0,"text":leaf,"size":leaf.len()}),
        json!({"l":1,"i":0,"text":"stale parent","size":12})
    );
    fs::write(dir.path().join("tree/1999-01-01.jsonl"), fixture).unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    assert!(!mem.store.nodes.contains_key(&Key { l: 1, i: 0 }));
    assert_eq!(mem.jobs().unwrap()[0].i, 1);
    mem.submit(Key { l: 0, i: 1 }, &leaf).unwrap();
    assert_eq!(mem.jobs().unwrap()[0].l, 1);
    mem.submit(Key { l: 1, i: 0 }, "user: rebuilt parent")
        .unwrap();
    drop(mem);
    let mem = Memory::open(dir.path(), VIEW).unwrap();
    assert_eq!(
        mem.store.nodes[&Key { l: 1, i: 0 }].text,
        "user: rebuilt parent"
    );
}

#[test]
fn parents_saved_in_an_earlier_named_day_file_are_kept() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    for _ in 0..2 {
        mem.append("user", &"x".repeat(800), None).unwrap();
    }
    mem.jobs().unwrap();
    mem.submit(Key { l: 0, i: 0 }, &"user: first ".repeat(30))
        .unwrap();
    mem.jobs().unwrap();
    mem.submit(Key { l: 0, i: 1 }, &"user: second ".repeat(30))
        .unwrap();
    drop(mem);
    // Clock moved backwards across midnight: the parent lands in an earlier-sorting file.
    let parent = json!({"l":1,"i":0,"text":"user: both","size":10});
    fs::write(
        dir.path().join("tree/1999-01-01.jsonl"),
        format!("{parent}\n"),
    )
    .unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    assert_eq!(mem.store.nodes[&Key { l: 1, i: 0 }].text, "user: both");
    assert!(mem.jobs().unwrap().is_empty());
}

#[test]
fn jobs_bound_concurrency_and_never_use_future_context() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    for i in 0..32 {
        mem.append("user", &format!("marker-{i:02} {}", "a".repeat(450)), None)
            .unwrap();
    }
    let jobs = mem.jobs().unwrap();
    assert_eq!(jobs.len(), 8);
    assert!(mem.jobs().unwrap().is_empty());
    for job in jobs {
        assert_eq!(job.l, 1);
        let context = job.messages[0].content[0]["text"].as_str().unwrap();
        assert!(!context.contains(PLACEHOLDER));
        assert!(!context.contains(&format!("marker-{:02}", (job.i + 1) * 2)));
        mem.submit(Key { l: job.l, i: job.i }, "user: pair")
            .unwrap();
    }
    finish(&mut mem);
    assert_eq!(mem.store.nodes.len(), 63);
}

#[test]
fn cap_unicode_cache_boundaries_import_and_html_escape() {
    let text = format!("START{}END", "🦀".repeat(CAP));
    let capped = cap(&text);
    assert!(capped.chars().count() <= CAP);
    assert!(capped.starts_with("START"));
    assert!(capped.ends_with("END"));
    assert!(capped.contains("omitted"));
    let view = "🦀 line\n".repeat(20_000);
    let blocks = cache_blocks(&view);
    assert_eq!(blocks.len(), 4);
    assert_eq!(
        blocks
            .iter()
            .map(|b| b["text"].as_str().unwrap())
            .collect::<String>(),
        view
    );
    for block in &blocks[..3] {
        assert!(block["text"].as_str().unwrap().ends_with('\n'));
        assert_eq!(block["cache_control"], json!({"type":"ephemeral"}));
    }
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    let record = serde_json::from_value(
        json!({"i":0,"kind":"note","text":"<script>","size":14,"date":"2020-01-01T00:00:00Z"}),
    )
    .unwrap();
    dispatch(
        &mut mem,
        Request::Import {
            messages: vec![record],
        },
    )
    .unwrap();
    let export = dispatch(&mut mem, Request::Export).unwrap();
    assert!(export.as_str().unwrap().contains("&lt;script&gt;"));
    assert!(!export.as_str().unwrap().contains("<script>"));
    assert_eq!(mem.store.root[0].date, "2020-01-01T00:00:00Z");
}

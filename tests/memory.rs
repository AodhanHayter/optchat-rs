use optchat::{
    Memory, NODE, PLACEHOLDER, VIEW, cache_blocks,
    protocol::{Entry, Request, SNAPSHOT, dispatch, write_html},
    store::{CAP, Key, cap},
};
use serde_json::{Value, json};
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
/// The embedded data block, as raw text and as parsed JSON. The raw form is what a
/// browser's HTML parser sees; the parsed form is what the viewer receives.
fn snapshot(html: &str) -> (&str, Value) {
    let start = html.find(SNAPSHOT).unwrap() + SNAPSHOT.len();
    let end = start + html[start..].find("</script>").unwrap();
    (
        &html[start..end],
        serde_json::from_str(&html[start..end]).unwrap(),
    )
}
/// The compaction view a job carries: every block but the last, which is the task.
fn context(job: &optchat::Job) -> String {
    let blocks = job.messages[0].content.as_array().unwrap();
    blocks[..blocks.len() - 1]
        .iter()
        .map(|b| b["text"].as_str().unwrap())
        .collect()
}
fn task(job: &optchat::Job) -> &str {
    let blocks = job.messages[0].content.as_array().unwrap();
    blocks.last().unwrap()["text"].as_str().unwrap()
}
fn user(text: &str) -> Request {
    Request::Prepare {
        messages: vec![Entry {
            kind: "user".into(),
            text: text.into(),
        }],
    }
}
fn tiled(mem: &Memory) {
    let mut pos = 0;
    for k in mem.view() {
        assert_eq!(k.start(), Some(pos));
        pos = k.end().unwrap();
    }
    assert_eq!(pos, mem.store.root.len());
}
#[test]
fn persistence_free_nodes_zoom_and_prepare() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    let prepared = dispatch(&mut mem, user("hello\nworld")).unwrap();
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
    assert!(dispatch(&mut mem, user("new")).is_err());
    assert_eq!(mem.store.root.len(), 2);
    // Both messages start at once: fewer than WINDOW unbuilt lines precede each.
    let jobs = mem.jobs().unwrap();
    assert_eq!(
        jobs.iter().map(|j| (j.l, j.i)).collect::<Vec<_>>(),
        [(0, 0), (0, 1)]
    );
    // Each context stops at the first unbuilt line, so no call sees a placeholder.
    for job in &jobs {
        assert_eq!(context(job), "<chat>\n</chat>");
    }
    let ruler = "-".repeat(NODE);
    assert_eq!(
        task(&jobs[1]),
        format!(
            "Compaction: compress message 1 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n{ruler}\n<input>\nuser: {}\n</input>",
            "b".repeat(700)
        )
    );
    assert!(mem.jobs().unwrap().is_empty());
    mem.fail(Key { l: 0, i: 1 }).unwrap();
    let key = Key { l: 0, i: 0 };
    for n in [600, 580, 590, 570] {
        let retry = mem.submit(key, &"é".repeat(n / 2)).unwrap().unwrap();
        let feedback = retry.messages.last().unwrap().content.as_str().unwrap();
        assert!(feedback.starts_with(&format!(
            "Too long: your line is {n} bytes, over the 512-byte limit. Write\nthe whole line again"
        )));
        assert!(feedback.ends_with("| ← LIMIT"));
    }
    assert!(mem.submit(key, &"é".repeat(290)).unwrap().is_none());
    assert_eq!(mem.store.nodes[&key].size, 570);
    // The failed message retries at the next message, now with its context built.
    mem.append("talk", "next", None).unwrap();
    let jobs = mem.jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].i, 1);
    assert!(context(&jobs[0]).starts_with("<chat>\n0+1|"));
    assert!(!context(&jobs[0]).contains(PLACEHOLDER));
    mem.submit(Key { l: 0, i: 1 }, "user: second").unwrap();
    finish(&mut mem);
    assert!(mem.settled());
}
#[test]
fn incremental_view_never_splits_and_measures_actual_bytes() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), 130).unwrap();
    for i in 0..128 {
        let old = mem.view().to_vec();
        mem.append("user", &format!("message {i}: {}", "x".repeat(55)), None)
            .unwrap();
        finish(&mut mem);
        tiled(&mem);
        for part in old {
            assert!(
                mem.view()
                    .iter()
                    .any(|p| p.start().unwrap() <= part.start().unwrap()
                        && p.end().unwrap() >= part.end().unwrap())
            );
        }
    }
    assert!(mem.view().iter().any(|k| k.l > 0));
    assert_eq!(
        mem.size(),
        mem.view()
            .iter()
            .map(|k| mem.store.nodes[k].size)
            .sum::<usize>()
    );
    // A budget below a root summary is allowed to remain over budget, without spinning.
    let dir2 = tempdir().unwrap();
    let mut tiny = Memory::open(dir2.path(), 1).unwrap();
    tiny.append("user", "a", None).unwrap();
    tiny.append("talk", "b", None).unwrap();
    // The pair's parent was built after the second message: it merges at the next.
    assert_eq!(tiny.view().len(), 2);
    tiny.append("talk", "c", None).unwrap();
    assert_eq!(tiny.view(), [Key { l: 1, i: 0 }, Key { l: 0, i: 2 }]);
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
        let context = context(&job);
        assert!(!context.contains(PLACEHOLDER));
        let (a, b) = (job.i * 2, job.i * 2 + 1);
        assert!(task(&job).starts_with(&format!(
            "Compaction: merge lines {a}+1 and {b}+1, adjacent, into one line of at most\n"
        )));
        assert!(task(&job).contains(&format!("their messages, {a} to {b}, in more detail")));
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
    // Blocks of four lines, the <chat> line riding with the first; one mark, on the
    // last whole block.
    let view = format!("<chat>\n{}</chat>", "🦀 line\n".repeat(10));
    let blocks = cache_blocks(&view);
    let texts: Vec<&str> = blocks.iter().map(|b| b["text"].as_str().unwrap()).collect();
    assert_eq!(texts.concat(), view);
    assert_eq!(texts[0], format!("<chat>\n{}", "🦀 line\n".repeat(4)));
    assert_eq!(texts[1], "🦀 line\n".repeat(4));
    assert_eq!(texts[2], "🦀 line\n🦀 line\n</chat>");
    let marked: Vec<usize> = (0..blocks.len())
        .filter(|&n| blocks[n]["cache_control"] == json!({"type":"ephemeral"}))
        .collect();
    assert_eq!(marked, [1]);
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
    let export = export.as_str().unwrap();
    // The model view is server-rendered text, so its markup is entity-escaped.
    assert!(export.contains("&lt;script&gt;"));
    // Only the data block and the viewer are script elements.
    assert_eq!(export.matches("<script").count(), 2);
    assert_eq!(mem.store.root[0].date, "2020-01-01T00:00:00Z");
}

#[test]
fn export_embeds_original_text_without_executable_markup() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    // Script close tags, HTML comments, line separators, CRLF, and quoting, in text
    // and in an imported date string.
    let hostile = "</script ><img src=x onerror=alert(1)><!-- --> --> \u{2028}\u{2029}\r\nkeep\ttabs  \\\"'& \u{1f980}";
    let record = serde_json::from_value(json!({
        "i":0,"kind":"note","text":hostile,"size":hostile.len() + 6,
        "date":"2020-01-01T00:00:00.</script><!---->00000000000000000Z"
    }));
    // An invalid date is rejected before any export can embed it.
    assert!(
        dispatch(
            &mut mem,
            Request::Import {
                messages: vec![record.unwrap()]
            }
        )
        .is_err()
    );
    mem.append("user", hostile, Some("2026-01-01T00:00:00Z"))
        .unwrap();
    mem.append("note", "</script>", None).unwrap();
    let export = dispatch(&mut mem, Request::Export).unwrap();
    let export = export.as_str().unwrap();
    let (payload, data) = snapshot(export);
    // Nothing in the data block can close the script, open a comment, or end one.
    assert!(!payload.contains('<'));
    assert!(!payload.contains('>'));
    assert!(!payload.contains('\u{2028}'));
    assert!(!payload.contains('\u{2029}'));
    assert_eq!(export.matches("<script").count(), 2);
    assert_eq!(export.matches("</script>").count(), 2);
    // No external reference of any kind, so the page cannot fetch anything.
    assert!(!export.contains("://"));
    // Exact original text survives the round trip, including CRLF and tabs.
    assert_eq!(data["root"][0]["text"], hostile);
    assert_eq!(data["root"][0]["kind"], "user");
    assert_eq!(data["root"][0]["date"], "2026-01-01T00:00:00Z");
    assert_eq!(data["root"][0]["i"], 0);
    assert_eq!(data["root"][1]["text"], "</script>");
    assert_eq!(data["root"].as_array().unwrap().len(), 2);
}

#[test]
fn streamed_export_preserves_bytes_and_propagates_write_failures() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    let text = "</script> 🦀\u{2028}\u{2029} &\"'\r\n".repeat(3000);
    mem.append("user", &text, Some("2020-01-01T00:00:00Z"))
        .unwrap();
    mem.jobs().unwrap();
    mem.submit(Key { l: 0, i: 0 }, "user: <summary> 🦀")
        .unwrap();
    let expected = dispatch(&mut mem, Request::Export).unwrap();
    let expected = expected.as_str().unwrap();
    let before = mem.status();
    for size in [
        0,
        100,
        expected.find(SNAPSHOT).unwrap() + SNAPSHOT.len() + 50,
        expected.len() - 1,
    ] {
        let mut bytes = vec![0; size];
        let error = write_html(&mem, &mut bytes.as_mut_slice()).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::WriteZero);
        assert_eq!(bytes, expected.as_bytes()[..size]);
        assert_eq!(mem.status(), before);
    }
    let file = dir.path().join("streamed.html");
    dispatch(&mut mem, Request::ExportFile { file: file.clone() }).unwrap();
    let actual = fs::read_to_string(file).unwrap();
    assert_eq!(actual, expected);
    let (payload, data) = snapshot(&actual);
    assert!(!payload.contains(['<', '>', '\u{2028}', '\u{2029}']));
    assert_eq!(data["root"][0]["text"], text);
    assert_eq!(data["root"][0]["date"], "2020-01-01T00:00:00Z");
    assert_eq!(data["tree"][0][2], "user: <summary> 🦀");
    assert_eq!(mem.status(), before);
}

#[test]
fn export_of_empty_memory_is_valid_and_carries_no_history() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    let export = dispatch(&mut mem, Request::Export).unwrap();
    let export = export.as_str().unwrap();
    let (_, data) = snapshot(export);
    assert_eq!(data["settled"], true);
    assert!(data["root"].as_array().unwrap().is_empty());
    assert!(data["parts"].as_array().unwrap().is_empty());
    assert!(data["tree"].as_array().unwrap().is_empty());
    assert!(export.contains("<pre id=\"view\">&lt;chat&gt;\n&lt;/chat&gt;</pre>"));
    assert!(export.contains("<title>OptChat</title>"));
}

#[test]
fn export_shows_pending_summaries_and_reaches_every_message() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    for i in 0..4 {
        mem.append("user", &format!("message {i}: {}", "x".repeat(800)), None)
            .unwrap();
    }
    let export = dispatch(&mut mem, Request::Export).unwrap();
    let (_, data) = snapshot(export.as_str().unwrap());
    assert_eq!(data["settled"], false);
    assert!(data["tree"].as_array().unwrap().is_empty());
    assert!(export.as_str().unwrap().contains("summaries pending"));
    // The viewer labels a missing summary instead of hiding or inventing it.
    assert!(export.as_str().unwrap().contains("(not summarized yet)"));
    assert!(export.as_str().unwrap().contains("pending summary"));
    // Every original is reachable: the view parts tile the whole log in order.
    let mut pos = 0u64;
    for part in data["parts"].as_array().unwrap() {
        let (l, i) = (part[0].as_u64().unwrap(), part[1].as_u64().unwrap());
        assert_eq!(i << l, pos);
        pos = (i + 1) << l;
    }
    assert_eq!(pos, 4);
    // One finished summary appears; the unfinished ones stay absent, not empty.
    mem.jobs().unwrap();
    mem.submit(Key { l: 0, i: 0 }, "user: first line").unwrap();
    let export = dispatch(&mut mem, Request::Export).unwrap();
    let (_, data) = snapshot(export.as_str().unwrap());
    assert_eq!(data["settled"], false);
    assert_eq!(data["tree"], json!([[0, 0, "user: first line"]]));
}

#[test]
fn long_texts_are_logged_whole_over_several_messages_and_reports_are_work() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    let text = format!("{}TAIL", "🦀".repeat(CAP * 2));
    let logged = mem.log("user", &text, None).unwrap();
    assert_eq!(logged.iter().map(|m| m.i).collect::<Vec<_>>(), [0, 1, 2]);
    assert!(
        logged
            .iter()
            .all(|m| m.kind == "user" && m.text.chars().count() <= CAP)
    );
    assert_eq!(
        logged.iter().map(|m| m.text.as_str()).collect::<String>(),
        text
    );
    // A tool result is clipped to its head and tail instead.
    let echo = mem.log("echo", &text, None).unwrap();
    assert_eq!(echo.len(), 1);
    assert_eq!(echo[0].text, cap(&text));
    let prepared = dispatch(
        &mut mem,
        Request::Prepare {
            messages: vec![Entry {
                kind: "work".into(),
                text: "[scout] report".into(),
            }],
        },
    );
    // The view must be settled first; summarize, then start the turn.
    assert!(prepared.is_err());
    finish(&mut mem);
    let prepared = dispatch(
        &mut mem,
        Request::Prepare {
            messages: vec![Entry {
                kind: "work".into(),
                text: "[scout] report".into(),
            }],
        },
    )
    .unwrap();
    assert_eq!(prepared["ids"], json!([4]));
    assert_eq!(mem.store.root[4].kind, "work");
    let talk = Request::Prepare {
        messages: vec![Entry {
            kind: "talk".into(),
            text: "not a turn's opening".into(),
        }],
    };
    assert!(dispatch(&mut mem, talk).is_err());
}

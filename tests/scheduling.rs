use optchat::{JOBS, Memory, PLACEHOLDER, VIEW, store::Key};
use serde_json::json;
use std::{collections::BTreeSet, fs};
use tempfile::tempdir;

// Original scheduler rule, evaluated independently of the cached frontier/queues.
fn expected_jobs(mem: &Memory, active: &BTreeSet<Key>) -> Vec<Key> {
    let first = mem
        .view
        .iter()
        .find(|k| !mem.store.nodes.contains_key(k))
        .map_or(mem.store.root.len(), |k| k.start().unwrap());
    assert_eq!(mem.first(), first);
    assert_eq!(mem.settled(), first == mem.store.root.len());
    assert_eq!(
        mem.size(),
        mem.view
            .iter()
            .map(|k| mem.store.nodes.get(k).map_or(PLACEHOLDER.len(), |n| n.size))
            .sum::<usize>()
    );
    (0..usize::BITS)
        .take_while(|l| (mem.store.root.len() >> l) > 0)
        .flat_map(|l| (0..(mem.store.root.len() >> l)).map(move |i| Key { l, i }))
        .filter(|k| {
            !mem.store.nodes.contains_key(k)
                && !active.contains(k)
                && (if k.l == 0 { k.i } else { k.end().unwrap() }) <= first
                && (k.l == 0
                    || (0..2).all(|j| {
                        mem.store.nodes.contains_key(&Key {
                            l: k.l - 1,
                            i: k.i * 2 + j,
                        })
                    }))
        })
        .take(JOBS - active.len())
        .collect()
}

#[test]
fn recovered_future_candidates_unblock_in_order_as_the_frontier_moves() {
    for budget in [1, 700, VIEW] {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("main")).unwrap();
        fs::create_dir(dir.path().join("tree")).unwrap();
        let mut root = String::new();
        let mut tree = String::new();
        for i in 0..32 {
            let text = format!("original-{i:02}: {}", "🦀".repeat(200));
            root.push_str(&format!("{}\n", json!({"i":i,"kind":"user","text":text,"size":text.len()+6,"date":"2026-01-01T00:00:00Z"})));
            if ![0, 7, 19].contains(&i) {
                let text = format!("summary-{i:02}: {}", "x".repeat(290));
                tree.push_str(&format!(
                    "{}\n",
                    json!({"l":0,"i":i,"size":text.len(),"text":text})
                ));
            }
        }
        fs::write(dir.path().join("main/2026-01-01.jsonl"), root).unwrap();
        fs::write(dir.path().join("tree/2026-01-01.jsonl"), tree).unwrap();
        let mut mem = Memory::open(dir.path(), budget).unwrap();
        let mut active = BTreeSet::new();
        let mut rounds = 0;
        loop {
            let expected = expected_jobs(&mem, &active);
            let jobs = mem.jobs().unwrap();
            assert_eq!(
                jobs.iter()
                    .map(|j| Key { l: j.l, i: j.i })
                    .collect::<Vec<_>>(),
                expected
            );
            active.extend(expected);
            let Some(key) = active.pop_last() else { break };
            // Alternate automatic and provider-sized parents, complete out of order,
            // and exercise the fifth-response shortest-choice rule.
            if key.i % 3 == 0 {
                for _ in 0..4 {
                    assert!(mem.submit(key, &"oversize ".repeat(80)).unwrap().is_some());
                }
            }
            let text = if key.i % 2 == 0 {
                "brief".into()
            } else {
                "x".repeat(300)
            };
            assert!(mem.submit(key, &text).unwrap().is_none());
            if rounds == 3 {
                mem.append("note", "late append", Some("2026-01-02T00:00:00Z"))
                    .unwrap();
            }
            rounds += 1;
            assert!(rounds < 100);
        }
        assert!(mem.settled());
        assert_eq!(mem.store.nodes.len(), 64); // 33 leaves + 16 + 8 + 4 + 2 + 1.
        assert_eq!(mem.store.root[0].date, "2026-01-01T00:00:00Z");
    }
}

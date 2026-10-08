use optchat::{
    HITS, Memory, PAYLOAD, QUERY, SNIPPET, VIEW, find,
    protocol::{Request, dispatch},
    store::Key,
};
use serde_json::json;
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
fn import(mem: &mut Memory, i: usize, digits: usize) {
    let date = format!("2026-01-01T00:00:00.{}+05:30", "1".repeat(digits));
    let record = serde_json::from_value(
        json!({"i":i,"kind":"user","text":"huge needle","size":17,"date":date}),
    )
    .unwrap();
    dispatch(
        mem,
        Request::Import {
            messages: vec![record],
        },
    )
    .unwrap();
}
fn ids(mem: &Memory, text: &str, include_tools: bool) -> Vec<usize> {
    mem.search(text, None, include_tools)
        .unwrap()
        .hits
        .iter()
        .map(|h| h.id)
        .collect()
}

#[test]
fn query_bounds_count_bytes_and_keep_whitespace_exactly() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("user", "a  b", None).unwrap();
    for bad in ["", " ", "\t\n\r ", "a\0b", "\0"] {
        assert!(mem.search(bad, None, false).is_err(), "{bad:?}");
    }
    assert!(mem.search(&"a".repeat(QUERY), None, false).is_ok());
    assert!(mem.search(&"a".repeat(QUERY + 1), None, false).is_err());
    // 64 crabs are 256 bytes; 65 are 260 bytes but only 65 characters.
    assert!(mem.search(&"\u{1f980}".repeat(64), None, false).is_ok());
    assert!(mem.search(&"\u{1f980}".repeat(65), None, false).is_err());
    // Interior whitespace is part of the query: nothing is trimmed before matching.
    assert_eq!(ids(&mem, " b", false), [0]);
    assert_eq!(ids(&mem, "a  b", false), [0]);
    assert_eq!(ids(&mem, "a b", false), Vec::<usize>::new());
    assert_eq!(ids(&mem, " a", false), Vec::<usize>::new());
}

#[test]
fn find_matches_literally_at_every_boundary() {
    assert_eq!(find(b"aab", b"ab"), Some(1));
    assert_eq!(find(b"AAB", b"ab"), Some(1));
    assert_eq!(find(b"aab", b"AB"), Some(1));
    assert_eq!(find(b"abc", b"c"), Some(2));
    assert_eq!(find(b"abc", b"abc"), Some(0));
    assert_eq!(find(b"abc", b"abcd"), None);
    assert_eq!(find(b"", b"a"), None);
    assert_eq!(find(b"abc", b""), None);
    // Digits and punctuation have no case; non-ASCII bytes are compared exactly.
    assert_eq!(find(b"a1-b", b"1-B"), Some(1));
    assert_eq!(find("\u{e9}".as_bytes(), "\u{c9}".as_bytes()), None);
    assert_eq!(find("x\u{e9}y".as_bytes(), "\u{e9}Y".as_bytes()), Some(1));
}

#[test]
fn matcher_agrees_with_naive_ascii_folding_across_buffers_and_repeated_prefixes() {
    let reference = |haystack: &[u8], needle: &[u8]| {
        (!needle.is_empty())
            .then(|| {
                haystack
                    .windows(needle.len())
                    .position(|part| part.eq_ignore_ascii_case(needle))
            })
            .flatten()
    };
    let mut seed = 42u64;
    let mut next = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        (seed >> 32) as u8
    };
    // Includes raw bytes, overlapping candidates, and mixed-case matches. No Unicode folding.
    for n in 0..600 {
        let text: Vec<_> = (0..n)
            .map(|_| [b'a', b'A', b'b', b'B', 0, 0x80, 0xff][usize::from(next()) % 7])
            .collect();
        let len = usize::from(next()) % 40;
        let mut query: Vec<_> = (0..len).map(|_| next()).collect();
        if n >= len && n % 2 == 0 {
            let at = usize::from(next()) % (n - len + 1);
            query.copy_from_slice(&text[at..at + len]);
            query.make_ascii_uppercase();
        }
        assert_eq!(find(&text, &query), reference(&text, &query), "case {n}");
    }
    // A common pivot byte forces the bounded-buffer fallback, including its overlaps.
    for len in [QUERY, 8194] {
        let mut query = b"AB".repeat(len / 2);
        query.swap(len / 2, len / 2 + 1);
        let original = b"ab".repeat(16000);
        assert_eq!(find(&original, &query), None);
        for at in [8170, 8191, 8192, 16370, original.len() - len] {
            let mut text = original.clone();
            text[at..at + len].copy_from_slice(&query);
            assert_eq!(
                find(&text, &query),
                reference(&text, &query),
                "fallback length {len}, position {at}"
            );
        }
    }
    for len in [1, 2, 17, QUERY, 8193] {
        let mut query = vec![b'A'; len];
        query[len / 2] = b'B';
        let mut text = vec![b'a'; 24000];
        assert_eq!(find(&text, &query), None);
        for at in [0, 8180, 8192, text.len() - len] {
            text[at..at + len].copy_from_slice(&query);
            assert_eq!(
                find(&text, &query),
                reference(&text, &query),
                "length {len}, position {at}"
            );
            text[at..at + len].fill(b'a');
        }
    }
}

#[test]
fn kinds_filter_originals_only_and_return_newest_first() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    for kind in ["user", "talk", "work", "note", "tool", "echo"] {
        mem.append(kind, &format!("needle for {kind}"), None)
            .unwrap();
    }
    mem.append("user", "unrelated", None).unwrap();
    assert_eq!(ids(&mem, "needle", false), [3, 2, 1, 0]);
    assert_eq!(ids(&mem, "needle", true), [5, 4, 3, 2, 1, 0]);
    let page = mem.search("NEEDLE", None, true).unwrap();
    assert_eq!(
        page.hits
            .iter()
            .map(|h| h.kind.as_str())
            .collect::<Vec<_>>(),
        ["echo", "tool", "note", "work", "talk", "user"]
    );
    assert_eq!(page.next_before, None);
    assert!(page.hits.iter().all(|h| h.date.contains('T')));
    // Search reads original text, never the rendered "kind: text" source line.
    assert!(
        mem.search("user: needle", None, true)
            .unwrap()
            .hits
            .is_empty()
    );
    assert!(mem.search("missing", None, true).unwrap().hits.is_empty());
}

#[test]
fn pagination_is_exclusive_and_appends_never_duplicate_older_pages() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    for i in 0..25 {
        mem.append("user", &format!("match {i}"), None).unwrap();
    }
    let first = mem.search("match", None, false).unwrap();
    assert_eq!(first.hits.len(), HITS);
    assert_eq!(
        first.hits.iter().map(|h| h.id).collect::<Vec<_>>(),
        (5..25).rev().collect::<Vec<_>>()
    );
    assert_eq!(first.next_before, Some(5));
    // Newer messages arrive between pages; the exclusive cursor still walks backwards.
    for i in 25..28 {
        mem.append("user", &format!("match {i}"), None).unwrap();
    }
    let second = mem.search("match", first.next_before, false).unwrap();
    assert_eq!(
        second.hits.iter().map(|h| h.id).collect::<Vec<_>>(),
        (0..5).rev().collect::<Vec<_>>()
    );
    assert_eq!(second.next_before, None);
    // Exactly one page of matches reports no continuation, without counting them.
    let exact = mem.search("match", Some(20), false).unwrap();
    assert_eq!(exact.hits.len(), HITS);
    assert_eq!(exact.next_before, None);
    assert!(mem.search("match", Some(0), false).unwrap().hits.is_empty());
    assert_eq!(mem.search("match", Some(1), false).unwrap().hits.len(), 1);
    assert_eq!(
        mem.search("match", Some(usize::MAX), false)
            .unwrap()
            .hits
            .len(),
        HITS
    );
}

#[test]
fn matching_folds_ascii_case_only_and_spans_lines_and_controls() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("user", "alpha\nbeta from CAF\u{c9} and caf\u{e9}", None)
        .unwrap();
    mem.append("note", "tab\tand bell\u{7}end", None).unwrap();
    assert_eq!(ids(&mem, "FROM", false), [0]);
    assert_eq!(ids(&mem, "alpha\nbeta", false), [0]);
    assert_eq!(ids(&mem, "ALPHA\nBETA", false), [0]);
    assert_eq!(ids(&mem, "bell\u{7}end", false), [1]);
    assert_eq!(ids(&mem, "tab\tand", false), [1]);
    // ASCII folds; other bytes must match exactly, with no Unicode case or normalization.
    assert_eq!(ids(&mem, "caf\u{e9}", false), [0]);
    assert_eq!(ids(&mem, "CAF\u{e9}", false), [0]);
    assert_eq!(ids(&mem, "caf\u{c9}", false), [0]);
    assert_eq!(ids(&mem, "cafe\u{301}", false), Vec::<usize>::new());
    // Only the uppercase accent precedes " and": the folded bytes stay distinct.
    assert_eq!(ids(&mem, "\u{c9} and", false), [0]);
    assert_eq!(ids(&mem, "\u{e9} and", false), Vec::<usize>::new());
    let hit = &mem.search("beta", None, false).unwrap().hits[0];
    assert_eq!(hit.snippet, "alpha\nbeta from CAF\u{c9} and caf\u{e9}");
    assert_eq!(hit.id, 0);
}

#[test]
fn snippets_and_payloads_stay_within_their_byte_bounds() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    // Multi-byte padding puts the clip between code points on both sides.
    let pad = "\u{1f980}".repeat(400);
    mem.append("user", &format!("{pad}needle{pad}"), None)
        .unwrap();
    mem.append("user", &format!("needle{pad}"), None).unwrap();
    mem.append("user", &format!("{pad}needle"), None).unwrap();
    mem.append("user", &format!("{}needle", "x".repeat(SNIPPET - 6)), None)
        .unwrap();
    let page = mem.search("needle", None, false).unwrap();
    assert_eq!(page.hits.len(), 4);
    for hit in &page.hits {
        assert!(hit.snippet.len() <= SNIPPET, "{}", hit.snippet.len());
        assert!(hit.snippet.contains("needle") || hit.snippet.contains("needl"));
    }
    // Newest first: the exactly-bounded message is whole, the longer ones mark clipping.
    assert_eq!(page.hits[0].id, 3);
    assert_eq!(page.hits[0].snippet.len(), SNIPPET);
    assert!(!page.hits[0].snippet.contains('\u{2026}'));
    assert!(page.hits[1].snippet.starts_with('\u{2026}'));
    assert!(page.hits[1].snippet.ends_with("needle"));
    assert!(page.hits[2].snippet.starts_with("needle"));
    assert!(page.hits[2].snippet.ends_with('\u{2026}'));
    assert!(page.hits[3].snippet.starts_with('\u{2026}'));
    assert!(page.hits[3].snippet.ends_with('\u{2026}'));
    // Clipping never splits a crab, so every snippet stays decodable and in bound.
    for hit in &page.hits[1..] {
        assert!(
            hit.snippet
                .trim_matches('\u{2026}')
                .trim_matches('\u{1f980}')
                .contains("needle")
        );
    }
    // Worst-case escaping: every snippet byte is a control character costing six bytes.
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    let noise = "\u{1}".repeat(SNIPPET * 2);
    for _ in 0..HITS + 1 {
        mem.append(
            "user",
            &format!("{noise}needle{noise}"),
            Some("2026-01-01T00:00:00.123456789+05:30"),
        )
        .unwrap();
    }
    let page = mem.search("needle", None, false).unwrap();
    assert_eq!(page.hits.len(), HITS);
    assert_eq!(page.next_before, Some(1));
    let payload = serde_json::to_string(&page).unwrap();
    assert!(payload.contains("\\u0001"));
    assert!(payload.len() <= PAYLOAD, "{}", payload.len());
    assert!(payload.len() > PAYLOAD / 2, "{}", payload.len());
    assert_eq!(
        serde_json::to_string(
            &dispatch(
                &mut mem,
                Request::Search {
                    text: "needle".into(),
                    before: None,
                    include_tools: false
                }
            )
            .unwrap()
        )
        .unwrap()
        .len(),
        payload.len()
    );
}

#[test]
fn huge_imported_dates_error_instead_of_silently_skipping_matches() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("user", "older needle", None).unwrap();
    // RFC3339 does not bound fractional digits, and imported dates are kept verbatim.
    import(&mut mem, 1, PAYLOAD);
    let error = mem.search("needle", None, false).unwrap_err().to_string();
    assert_eq!(
        error,
        "search hit for message 1 exceeds the 32768-byte payload limit"
    );
    // Explicitly skipping a record remains possible, but search never does it silently.
    let older = mem.search("needle", Some(1), false).unwrap();
    assert_eq!(older.hits.len(), 1);
    assert_eq!(older.hits[0].id, 0);
    assert_eq!(older.next_before, None);
    // Large but returnable records end the page before the 20-hit limit.
    for i in 2..6 {
        import(&mut mem, i, PAYLOAD / 4);
    }
    let page = mem.search("needle", None, false).unwrap();
    assert!(!page.hits.is_empty() && page.hits.len() < HITS);
    assert_eq!(page.next_before, Some(page.hits.last().unwrap().id));
    assert!(serde_json::to_string(&page).unwrap().len() <= PAYLOAD);
}

#[test]
fn search_answers_during_compaction_and_reports_the_covering_view_part() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    for i in 0..4 {
        // Messages too long to summarize locally stay pending until a model answers.
        mem.append("user", &format!("needle {i}: {}", "x".repeat(700)), None)
            .unwrap();
    }
    // Unsummarized leaves block the model view, but originals are already searchable.
    assert!(!mem.settled());
    assert!(dispatch(&mut mem, Request::View { display: false }).is_err());
    let pending = mem.search("needle", None, false).unwrap();
    assert_eq!(pending.hits.len(), 4);
    assert!(
        pending
            .hits
            .iter()
            .all(|h| h.covering.map(|c| c.n) == Some(1))
    );
    // A tight budget merges the view, so hits report the wider range that covers them.
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), 130).unwrap();
    for i in 0..8 {
        mem.append("user", &format!("needle {i}: {}", "x".repeat(55)), None)
            .unwrap();
    }
    finish(&mut mem);
    assert!(mem.view().iter().any(|k| k.l > 0));
    let page = mem.search("needle", None, false).unwrap();
    for hit in &page.hits {
        let covering = hit.covering.unwrap();
        assert!(covering.id <= hit.id && hit.id < covering.id + covering.n);
        // The reported range is exactly what zoom expands.
        assert!(mem.zoom(covering.id, covering.n).is_ok());
    }
    assert!(page.hits.iter().any(|h| h.covering.unwrap().n > 1));
    // The view tiles the whole log, so a hit only loses its range if the view cannot reach it.
    assert!(page.hits.iter().all(|h| h.covering.is_some()));
}

#[test]
fn rpc_rejects_bad_requests_and_returns_the_documented_payload_shape() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    mem.append("user", "first needle", Some("2026-01-01T00:00:00Z"))
        .unwrap();
    mem.append("echo", "second needle", Some("2026-01-02T00:00:00Z"))
        .unwrap();
    let request = |value: serde_json::Value| serde_json::from_value::<Request>(value);
    let payload = dispatch(
        &mut mem,
        request(json!({"op":"search","text":"needle"})).unwrap(),
    )
    .unwrap();
    assert_eq!(
        payload,
        json!({"hits":[{"id":0,"date":"2026-01-01T00:00:00Z","kind":"user","snippet":"first needle","covering":{"id":0,"n":1}}],"next_before":null})
    );
    let tools = dispatch(
        &mut mem,
        request(json!({"op":"search","text":"needle","include_tools":true,"before":2})).unwrap(),
    )
    .unwrap();
    assert_eq!(tools["hits"].as_array().unwrap().len(), 2);
    assert_eq!(tools["hits"][0]["kind"], "echo");
    assert!(request(json!({"op":"search","text":"x","before":-1})).is_err());
    assert!(request(json!({"op":"search","text":"x","before":1.5})).is_err());
    assert!(request(json!({"op":"search","text":1})).is_err());
    assert!(request(json!({"op":"search"})).is_err());
    assert!(request(json!({"op":"search","text":"x","unknown":true})).is_err());
    assert!(
        dispatch(
            &mut mem,
            request(json!({"op":"search","text":" "})).unwrap()
        )
        .unwrap_err()
        .to_string()
        .contains("whitespace")
    );
}

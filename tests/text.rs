use optchat::{
    BLOCK, cache_blocks, flatten,
    store::{CAP, cap},
};
use serde_json::{Value, json};

// Groups whole lines: the first line plus BLOCK more, then BLOCK at a time; a trailing
// partial group follows unmarked. Only the last whole group carries the cache mark.
fn reference_blocks(view: &str) -> Vec<Value> {
    let mut groups: Vec<(String, bool)> = Vec::new();
    let mut current = String::new();
    let mut lines = 0;
    let mut need = BLOCK + 1;
    for line in view.split_inclusive('\n') {
        current.push_str(line);
        if line.ends_with('\n') {
            lines += 1;
            if lines == need {
                groups.push((std::mem::take(&mut current), true));
                lines = 0;
                need = BLOCK;
            }
        }
    }
    if !current.is_empty() || groups.is_empty() {
        groups.push((current, false));
    }
    let last_whole = groups.iter().rposition(|(_, whole)| *whole);
    groups
        .into_iter()
        .enumerate()
        .map(|(n, (text, _))| {
            if Some(n) == last_whole {
                json!({"type":"text","text":text,"cache_control":{"type":"ephemeral"}})
            } else {
                json!({"type":"text","text":text})
            }
        })
        .collect()
}

#[test]
fn cache_blocks_match_the_line_reference() {
    for unit in [
        "x\n",
        "\n",
        "🦀\r\ncafé 東京\n",
        "a\r\nb\rc\n",
        "0+1|user: hi\n",
    ] {
        for lines in [0, 1, 4, 5, 6, 8, 9, 10, 13, 400] {
            for tail in ["", "</chat>", "partial"] {
                let text = format!("<chat>\n{}{tail}", unit.repeat(lines));
                assert_eq!(
                    cache_blocks(&text),
                    reference_blocks(&text),
                    "{unit:?}/{lines}/{tail}"
                );
            }
        }
    }
    assert_eq!(cache_blocks(""), reference_blocks(""));
}

#[test]
fn cap_and_flatten_preserve_exact_text() {
    for unit in ["x", "🦀", "é", "東京", "\r\n", "\r\r\n\n", "a\r\nb\rc\n"] {
        let long = unit.repeat(CAP * 2);
        for length in [0, 1, CAP - 1, CAP, CAP + 1, CAP * 2] {
            let text: String = long.chars().take(length).collect();
            let chars: Vec<char> = text.chars().collect();
            let expected = if chars.len() <= CAP {
                text.clone()
            } else {
                let keep = CAP - 80;
                let head = keep / 2;
                let tail = keep - head;
                format!(
                    "{}\n[... {} characters omitted ...]\n{}",
                    chars[..head].iter().collect::<String>(),
                    chars.len() - keep,
                    chars[chars.len() - tail..].iter().collect::<String>()
                )
            };
            assert_eq!(cap(&text), expected, "{unit:?}/{length}");
            assert_eq!(
                flatten(&text),
                text.replace("\r\n", " ").replace(['\n', '\r'], " ")
            );
        }
    }
}

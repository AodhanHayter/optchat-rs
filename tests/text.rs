use optchat::{
    cache_blocks, flatten,
    store::{CAP, cap},
};
use serde_json::{Value, json};

// Original character-based implementation: a deliberately simple equivalence oracle.
fn reference_blocks(view: &str) -> Vec<Value> {
    let chars: Vec<char> = view.chars().collect();
    let mut cuts = vec![0];
    for mark in [50_000, 80_000, 100_000] {
        if mark < chars.len()
            && let Some(p) = chars[..mark].iter().rposition(|c| *c == '\n')
            && p + 1 > *cuts.last().unwrap()
        {
            cuts.push(p + 1);
        }
    }
    let mut blocks = Vec::new();
    for pair in cuts.windows(2) {
        blocks.push(json!({"type":"text","text":chars[pair[0]..pair[1]].iter().collect::<String>(),"cache_control":{"type":"ephemeral"}}));
    }
    blocks.push(
        json!({"type":"text","text":chars[*cuts.last().unwrap()..].iter().collect::<String>()}),
    );
    blocks
}

#[test]
fn cache_cuts_match_character_reference_at_unicode_and_line_boundaries() {
    for unit in ["x", "\n", "🦀\r\ncafé 東京\n", "a\r\nb\rc\n"] {
        let long = unit.repeat(100_001);
        for length in [
            0, 1, 49_999, 50_000, 50_001, 79_999, 80_000, 80_001, 99_999, 100_000, 100_001,
        ] {
            let text: String = long.chars().take(length).collect();
            assert_eq!(
                cache_blocks(&text),
                reference_blocks(&text),
                "{unit:?}/{length}"
            );
        }
    }
    // All three marks find the same newline: emit that cut only once.
    let sparse = format!("\n{}", "🦀".repeat(110_000));
    assert_eq!(cache_blocks(&sparse), reference_blocks(&sparse));
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

use crate::{
    MASTER, Memory, VIEW_DOC, cache_blocks,
    store::{Key, Message},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fmt::Write as _;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Append {
        kind: String,
        text: String,
        date: Option<String>,
    },
    View {
        #[serde(default)]
        display: bool,
    },
    Prepare {
        texts: Vec<String>,
    },
    Status,
    Jobs,
    Submit {
        l: u32,
        i: usize,
        text: String,
    },
    Fail {
        l: u32,
        i: usize,
    },
    Zoom {
        id: usize,
        n: usize,
    },
    Date {
        id: usize,
    },
    Search {
        text: String,
        before: Option<usize>,
        #[serde(default)]
        include_tools: bool,
    },
    Import {
        messages: Vec<Message>,
    },
    Export,
    Prompts,
}

pub fn dispatch(mem: &mut Memory, request: Request) -> Result<Value> {
    Ok(match request {
        Request::Append { kind, text, date } => json!(mem.append(&kind, &text, date.as_deref())?),
        Request::View { display } => {
            ensure!(
                display || mem.settled(),
                "memory not settled; run compactor jobs before requesting a model view"
            );
            json!({"view":mem.render(),"blocks":cache_blocks(&mem.render()),"settled":mem.settled()})
        }
        Request::Prepare { texts } => {
            ensure!(
                !texts.is_empty(),
                "prepare requires at least one user message"
            );
            ensure!(
                mem.settled(),
                "memory not settled; run compactor jobs before starting a turn"
            );
            let view = mem.render();
            let mut ids = Vec::new();
            for text in &texts {
                ids.push(mem.append("user", text, None)?.i);
            }
            json!({"view":view,"blocks":cache_blocks(&view),"text":texts.join("\n\n"),"ids":ids})
        }
        Request::Status => mem.status(),
        Request::Jobs => json!(mem.jobs()?),
        Request::Submit { l, i, text } => json!({"retry":mem.submit(Key { l,i }, &text)?}),
        Request::Fail { l, i } => {
            mem.fail(Key { l, i })?;
            json!({"retry_after_ms":10_000})
        }
        Request::Zoom { id, n } => json!(mem.zoom(id, n)?),
        Request::Date { id } => json!(mem.date(id)?),
        Request::Search {
            text,
            before,
            include_tools,
        } => json!(mem.search(&text, before, include_tools)?),
        Request::Import { messages } => {
            // Validate the entire batch before the first durable write.
            for (offset, m) in messages.iter().enumerate() {
                m.validate()?;
                ensure!(
                    m.i == mem.store.root.len() + offset,
                    "import ids must continue the log, expected {}",
                    mem.store.root.len() + offset
                );
                ensure!(
                    m.kind != "echo" || m.text.chars().count() <= crate::store::CAP,
                    "import tool result exceeds character cap"
                );
            }
            for m in &messages {
                mem.append(&m.kind, &m.text, Some(&m.date))?;
            }
            json!({"imported":messages.len()})
        }
        Request::Export => json!(html(mem)),
        Request::Prompts => json!({"master":MASTER,"view":VIEW_DOC}),
    })
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub const BROWSER_CSS: &str = include_str!("browser.css");
pub const BROWSER_JS: &str = include_str!("browser.js");
/// Marks the embedded history. Tests and readers locate the data block by this id.
pub const SNAPSHOT: &str = "<script type=\"application/json\" id=\"snapshot\">";

/// Appends `value` as JSON that is inert inside a script data block.
///
/// `<` and `>` cannot appear outside a JSON string, so escaping them keeps the JSON
/// valid while making `</script`, `<!--`, and `-->` unrepresentable in the output.
/// U+2028 and U+2029 are escaped too, so the payload stays safe if it is ever copied
/// into a JavaScript string literal. The viewer reads the block with `textContent`,
/// so the browser never parses history as markup.
fn push_json(out: &mut String, buf: &mut Vec<u8>, value: &impl Serialize) {
    // Serializing one record at a time through one reused buffer keeps peak memory at
    // the output plus one record. Strings and plain structs cannot fail to serialize.
    buf.clear();
    serde_json::to_writer(&mut *buf, value).expect("history records serialize as JSON");
    let text = std::str::from_utf8(buf).expect("serde_json emits UTF-8");
    let mut start = 0;
    for (at, c) in text.char_indices() {
        let escaped = match c {
            '<' => "\\u003c",
            '>' => "\\u003e",
            '\u{2028}' => "\\u2028",
            '\u{2029}' => "\\u2029",
            _ => continue,
        };
        out.push_str(&text[start..at]);
        out.push_str(escaped);
        start = at + c.len_utf8();
    }
    out.push_str(&text[start..]);
}

/// A self-contained, read-only snapshot: the actual model view, plus the whole summary
/// tree embedded once as data. The viewer expands summaries into their children down to
/// original records on demand, so no history element is created before it is opened.
pub fn html(mem: &Memory) -> String {
    // A hint covering each record's JSON framing, so ordinary text needs no regrowth.
    // Text made only of escaped control characters still exceeds it; that only costs a
    // reallocation, never correctness.
    let data: usize = mem.store.root.iter().map(|m| m.size + 128).sum::<usize>()
        + mem.store.nodes.values().map(|n| n.size + 48).sum::<usize>();
    let mut out = String::with_capacity(data + BROWSER_JS.len() + BROWSER_CSS.len() + 8192);
    out.push_str("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
    // The page is one inline script and one inline style over inline data. Everything
    // else, including every network request, is denied.
    out.push_str(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'\">",
    );
    out.push_str("<title>OptChat</title><style>");
    out.push_str(BROWSER_CSS);
    out.push_str("</style></head><body><h1>OptChat</h1>");
    out.push_str(
        "<p class=\"warn\" role=\"note\"><strong>Private snapshot.</strong> This file contains the complete original text of this memory directory. It is read-only: editing it changes nothing in memory. Store it like the chat history itself, and delete it when you are done.</p>",
    );
    out.push_str("<ul class=\"facts\">");
    write!(
        out,
        "<li>{} messages</li><li>{} summaries</li><li>{} view parts</li><li>{} view bytes</li><li>{}</li>",
        mem.store.root.len(),
        mem.store.nodes.len(),
        mem.view.len(),
        mem.size(),
        if mem.settled() {
            "settled"
        } else {
            "summaries pending"
        }
    )
    .unwrap();
    out.push_str("</ul><noscript><p class=\"warn\">JavaScript is disabled, so only the model view below is shown. The summary tree and search need scripting.</p></noscript>");
    out.push_str(
        "<h2>Model view</h2><p>The exact text this memory sends to the model.</p><pre id=\"view\">",
    );
    out.push_str(&escape(&mem.render()));
    out.push_str("</pre><h2>Search originals</h2><form id=\"search-form\"><label for=\"query\">Text</label><input id=\"query\" type=\"search\" autocomplete=\"off\" spellcheck=\"false\"><label><input type=\"checkbox\" id=\"tools\"> include tool records</label><button type=\"submit\">Search</button></form>");
    out.push_str("<p id=\"report\" role=\"status\" aria-live=\"polite\"></p><ol id=\"results\" class=\"results\"></ol><button id=\"older\" type=\"button\" hidden>Show older results</button>");
    out.push_str("<h2>Memory tree</h2><p>Each view part opens into its two summaries, down to original messages. Long views are split into groups of parts that open on demand.</p><div id=\"tree\"></div>");
    out.push_str(SNAPSHOT);
    out.push_str("{\"settled\":");
    out.push_str(if mem.settled() { "true" } else { "false" });
    out.push_str(",\"parts\":[");
    for (n, key) in mem.view.iter().enumerate() {
        write!(out, "{}[{},{}]", if n > 0 { "," } else { "" }, key.l, key.i).unwrap();
    }
    out.push_str("],\"tree\":[");
    let mut buf = Vec::new();
    for (n, (key, node)) in mem.store.nodes.iter().enumerate() {
        write!(out, "{}[{},{},", if n > 0 { "," } else { "" }, key.l, key.i).unwrap();
        push_json(&mut out, &mut buf, &node.text);
        out.push(']');
    }
    out.push_str("],\"root\":[");
    for (n, m) in mem.store.root.iter().enumerate() {
        if n > 0 {
            out.push(',');
        }
        push_json(&mut out, &mut buf, m);
    }
    out.push_str("]}</script><script>");
    out.push_str(BROWSER_JS);
    out.push_str("</script></body></html>");
    out
}

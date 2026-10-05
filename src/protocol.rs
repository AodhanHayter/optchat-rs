use crate::{
    MASTER, Memory, VIEW_DOC, cache_blocks,
    store::{Key, Message},
};
use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};

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
pub fn html(mem: &Memory) -> String {
    let mut out = String::from(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>OptChat</title><style>body{font:16px system-ui;max-width:100ch;margin:auto;padding:2em}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}</style><h1>OptChat</h1><h2>View</h2><pre>",
    );
    out.push_str(&escape(&mem.render()));
    out.push_str("</pre><h2>ROOT</h2>");
    for m in &mem.store.root {
        out.push_str(&format!(
            "<details id=\"m{}\"><summary>{}+1 · {} · {} bytes</summary><pre>{}</pre></details>",
            m.i,
            m.i,
            escape(&m.date),
            m.size,
            escape(&m.source())
        ));
    }
    let mut level = None;
    for (key, node) in &mem.store.nodes {
        if level != Some(key.l) {
            out.push_str(&format!("<h2>Level {}</h2>", key.l));
            level = Some(key.l);
        }
        let start = key.start().unwrap();
        let end = key.end().unwrap();
        out.push_str(&format!(
            "<details><summary>{}+{} · {} — {} · {} bytes</summary><pre>{}</pre></details>",
            start,
            key.width().unwrap(),
            escape(&mem.store.root[start].date),
            escape(&mem.store.root[end - 1].date),
            node.size,
            escape(&node.text)
        ));
    }
    out.push_str("</html>");
    out
}

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use optchat::{
    Memory, VIEW,
    protocol::{Request, dispatch},
    store::Message,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
};

#[derive(Parser)]
#[command(version, about = "Append-only chat memory for pi")]
struct Cli {
    #[arg(long, env = "OPTCHAT_DIR", default_value = "chat", global = true)]
    dir: PathBuf,
    #[arg(long, default_value_t = VIEW, global = true)]
    view_bytes: usize,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Hold the writer lock and serve newline-delimited JSON on stdin/stdout.
    Serve,
    /// Append a message. Omit TEXT (or use -) to read stdin.
    Append {
        kind: String,
        text: Option<String>,
        #[arg(long)]
        date: Option<String>,
    },
    /// Print a settled memory view; --display allows placeholders for humans.
    View {
        #[arg(long)]
        display: bool,
    },
    Status,
    Zoom {
        id: usize,
        n: usize,
    },
    Date {
        id: usize,
    },
    /// Search original text, newest id first, and print one JSON page of hits.
    Search {
        text: String,
        #[arg(long)]
        before: Option<usize>,
        #[arg(long)]
        include_tools: bool,
    },
    /// Import JSONL records with contiguous ids, original kinds, text and dates.
    Import {
        file: PathBuf,
    },
    /// Export the view, ROOT, and every tree level as escaped, self-contained HTML.
    Export {
        file: PathBuf,
    },
    /// Print constant integration prompts.
    Prompts,
}
fn main() {
    if let Err(e) = run() {
        eprintln!("optchat: {e:#}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let cli = Cli::parse();
    let mut mem = Memory::open(&cli.dir, cli.view_bytes)?;
    let request = match cli.command {
        Command::Serve => return serve(&mut mem),
        Command::Append { kind, text, date } => {
            let text = match text {
                Some(s) if s != "-" => s,
                _ => {
                    let mut s = String::new();
                    io::stdin().read_to_string(&mut s)?;
                    s
                }
            };
            Request::Append { kind, text, date }
        }
        Command::View { display } => Request::View { display },
        Command::Status => Request::Status,
        Command::Zoom { id, n } => Request::Zoom { id, n },
        Command::Date { id } => Request::Date { id },
        Command::Search {
            text,
            before,
            include_tools,
        } => Request::Search {
            text,
            before,
            include_tools,
        },
        Command::Import { file } => {
            let file = fs::read_to_string(file)?;
            let messages = file
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(serde_json::from_str::<Message>)
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Request::Import { messages }
        }
        Command::Export { file } => {
            optchat::protocol::export_file(&mem, &file)?;
            println!("{}", file.display());
            return Ok(());
        }
        Command::Prompts => Request::Prompts,
    };
    let value = dispatch(&mut mem, request)?;
    if let Some(text) = value.as_str() {
        println!("{text}");
    } else if let Some(view) = value.get("view").and_then(Value::as_str) {
        println!("{view}");
    } else {
        println!("{}", serde_json::to_string(&value)?);
    }
    Ok(())
}
fn serve(mem: &mut Memory) -> Result<()> {
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().split(b'\n') {
        // Invalid UTF-8 is a request error, not a reason to drop the lock and exit.
        let parsed = serde_json::from_slice::<Value>(&line?);
        let id = parsed
            .as_ref()
            .ok()
            .and_then(|v| v.get("request_id"))
            .cloned()
            .unwrap_or(Value::Null);
        let result = parsed.context("invalid JSON").and_then(|mut value| {
            if let Some(obj) = value.as_object_mut() {
                obj.remove("request_id");
            }
            let request: Request = serde_json::from_value(value)?;
            dispatch(mem, request)
        });
        let response = match result {
            Ok(result) => json!({"request_id":id,"ok":true,"result":result}),
            Err(e) => json!({"request_id":id,"ok":false,"error":format!("{e:#}")}),
        };
        writeln!(out, "{}", serde_json::to_string(&response)?)?;
        out.flush()?;
    }
    Ok(())
}

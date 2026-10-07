use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};
use tempfile::tempdir;

#[cfg(target_os = "linux")]
#[test]
fn failed_streamed_export_keeps_partial_file_and_live_writer() {
    let dir = tempdir().unwrap();
    let mut mem = optchat::Memory::open(dir.path(), optchat::VIEW).unwrap();
    mem.append("user", &"x".repeat(20_000), Some("2026-01-01T00:00:00Z"))
        .unwrap();
    drop(mem);
    let log = std::fs::read_dir(dir.path().join("main"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let original = std::fs::read(&log).unwrap();
    let file = dir.path().join("partial.html");
    // Force EFBIG on file writes, not on the stdout pipe. Ignoring SIGXFSZ lets
    // the exporter return the I/O error through its normal RPC error path.
    let mut child = Command::new("sh")
        .args([
            "-c",
            "trap '' XFSZ; ulimit -f 1; exec \"$1\" --dir \"$2\" serve",
            "sh",
            env!("CARGO_BIN_EXE_optchat"),
        ])
        .arg(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{}", json!({"op":"export_file", "file":file})).unwrap();
    writeln!(input, "{}", json!({"op":"status"})).unwrap();
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["ok"], false);
    let error = replies[0]["error"].as_str().unwrap();
    assert!(error.contains(file.to_str().unwrap()), "{error}");
    assert!(error.contains("partial snapshot may remain"), "{error}");
    assert!(
        file.is_file(),
        "a failed export never unlinks its destination"
    );
    assert_eq!(replies[1]["result"]["messages"], 1);
    assert_eq!(std::fs::read(log).unwrap(), original);
}

#[test]
fn stdio_roundtrip_lock_crash_recovery_and_cli_export() {
    let dir = tempdir().unwrap();
    let binary = env!("CARGO_BIN_EXE_optchat");
    let version = Command::new(binary).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        concat!("optchat ", env!("CARGO_PKG_VERSION"))
    );
    let mut child = Command::new(binary)
        .args(["--dir", dir.path().to_str().unwrap(), "serve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    input.write_all(b"\xff\n").unwrap();
    let mut raw = String::new();
    output.read_line(&mut raw).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["ok"], false);
    let mut request = |value: Value| {
        writeln!(input, "{value}").unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };
    let response = request(json!({"request_id":7,"op":"prepare","texts":["first question"]}));
    assert_eq!(response["request_id"], 7);
    assert_eq!(response["result"]["view"], "<chat>\n</chat>");
    assert_eq!(
        request(json!({"op":"append","kind":"talk","text":"answer"}))["ok"],
        true
    );
    assert_eq!(
        request(json!({"op":"zoom","id":0,"n":1}))["result"],
        "0+0|user: first question"
    );
    assert_eq!(request(json!({"op":"zoom","id":-1,"n":1}))["ok"], false);
    assert_eq!(request(json!({"op":"unknown"}))["ok"], false);
    let page = request(json!({"request_id":8,"op":"search","text":"FIRST"}));
    assert_eq!(page["request_id"], 8);
    assert_eq!(page["result"]["hits"][0]["id"], 0);
    assert_eq!(page["result"]["hits"][0]["kind"], "user");
    assert_eq!(page["result"]["hits"][0]["snippet"], "first question");
    assert_eq!(page["result"]["hits"][0]["covering"]["n"], 1);
    assert_eq!(page["result"]["next_before"], Value::Null);
    assert_eq!(
        request(json!({"op":"search","text":"answer","before":1}))["result"]["hits"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(request(json!({"op":"search","text":""}))["ok"], false);
    assert_eq!(request(json!({"op":"search"}))["ok"], false);
    let locked = Command::new(binary)
        .args(["--dir", dir.path().to_str().unwrap(), "status"])
        .output()
        .unwrap();
    assert!(!locked.status.success());
    assert!(String::from_utf8_lossy(&locked.stderr).contains("already open"));
    let snapshot = dir.path().join("live snapshot.html");
    let expected = request(json!({"op":"export"}))["result"]
        .as_str()
        .unwrap()
        .to_owned();
    let exported = request(json!({"request_id":9,"op":"export_file","file":snapshot}));
    assert_eq!(exported["ok"], true, "{exported}");
    assert_eq!(exported["request_id"], 9);
    assert_eq!(exported["result"], json!({"file":snapshot}));
    assert_eq!(std::fs::read_to_string(&snapshot).unwrap(), expected);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        assert_eq!(
            std::fs::metadata(&snapshot).unwrap().permissions().mode() & 0o777,
            0o600
        );
        for (name, target) in [
            ("link.html", snapshot.clone()),
            ("dangling.html", dir.path().join("absent")),
        ] {
            let link = dir.path().join(name);
            symlink(&target, &link).unwrap();
            let refused = request(json!({"op":"export_file","file":link}));
            assert_eq!(refused["ok"], false);
            assert!(
                refused["error"]
                    .as_str()
                    .unwrap()
                    .contains("already exists")
            );
            assert_eq!(std::fs::read_link(&link).unwrap(), target);
        }
        assert!(!dir.path().join("absent").exists());
    }
    let refused = request(json!({"op":"export_file","file":snapshot}));
    assert_eq!(refused["ok"], false);
    assert!(
        refused["error"]
            .as_str()
            .unwrap()
            .contains(snapshot.to_str().unwrap())
    );
    assert_eq!(std::fs::read_to_string(&snapshot).unwrap(), expected);
    let missing = dir.path().join("missing/snapshot.html");
    let refused = request(json!({"op":"export_file","file":missing}));
    assert_eq!(refused["ok"], false);
    assert!(
        refused["error"]
            .as_str()
            .unwrap()
            .contains(missing.to_str().unwrap())
    );
    assert_eq!(request(json!({"op":"status"}))["result"]["messages"], 2);
    child.kill().unwrap();
    child.wait().unwrap();
    drop(input);
    drop(output);
    let status = Command::new(binary)
        .env("OPTCHAT_DIR", dir.path())
        .arg("status")
        .output()
        .unwrap();
    assert!(status.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&status.stdout).unwrap()["messages"],
        2
    );
    let search = |args: &[&str]| {
        Command::new(binary)
            .args(["--dir", dir.path().to_str().unwrap()])
            .args(args)
            .output()
            .unwrap()
    };
    let hits = search(&["search", "ANSWER"]);
    assert!(hits.status.success());
    let page = serde_json::from_slice::<Value>(&hits.stdout).unwrap();
    assert_eq!(page["hits"][0]["id"], 1);
    assert_eq!(page["hits"][0]["snippet"], "answer");
    assert_eq!(page["next_before"], Value::Null);
    let older =
        serde_json::from_slice::<Value>(&search(&["search", "answer", "--before", "1"]).stdout)
            .unwrap();
    assert!(older["hits"].as_array().unwrap().is_empty());
    let tools =
        serde_json::from_slice::<Value>(&search(&["search", "question", "--include-tools"]).stdout)
            .unwrap();
    assert_eq!(tools["hits"][0]["id"], 0);
    assert!(
        !search(&["search", "answer", "--before", "-1"])
            .status
            .success()
    );
    let empty = search(&["search", " "]);
    assert!(!empty.status.success());
    assert!(String::from_utf8_lossy(&empty.stderr).contains("whitespace"));
    let html = dir.path().join("browse.html");
    assert!(
        Command::new(binary)
            .args([
                "--dir",
                dir.path().to_str().unwrap(),
                "export",
                html.to_str().unwrap()
            ])
            .output()
            .unwrap()
            .status
            .success()
    );
    let text = std::fs::read_to_string(&html).unwrap();
    assert!(text.contains("<title>OptChat</title>"));
    assert!(text.contains("<h1>OptChat</h1>"));
    assert!(text.contains("<script type=\"application/json\" id=\"snapshot\">"));
    assert!(text.contains("Content-Security-Policy"));
    assert!(text.contains("Private snapshot."));
    // The model view and the embedded originals both carry the real text.
    assert!(text.contains("first question"));
    assert!(text.contains("\"kind\":\"user\""));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&html).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "export must stay private");
    }
    // An existing destination is never overwritten.
    assert!(
        !Command::new(binary)
            .args([
                "--dir",
                dir.path().to_str().unwrap(),
                "export",
                html.to_str().unwrap()
            ])
            .output()
            .unwrap()
            .status
            .success()
    );
}

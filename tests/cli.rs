use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};
use tempfile::tempdir;

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
    let locked = Command::new(binary)
        .args(["--dir", dir.path().to_str().unwrap(), "status"])
        .output()
        .unwrap();
    assert!(!locked.status.success());
    assert!(String::from_utf8_lossy(&locked.stderr).contains("already open"));
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
    assert!(text.contains("ROOT"));
    assert!(text.contains("first question"));
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

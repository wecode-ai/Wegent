// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use wegent_executor::wecode::file_change_sender::{
    build_report_headers, build_report_payload, parse_anthropic_custom_headers,
};

#[test]
fn file_change_sender_builds_write_payload_with_legacy_schema() {
    let headers = BTreeMap::from([("git_url".to_owned(), "https://git.example/repo".to_owned())]);
    let input = json!({
        "session_id": "session-1",
        "tool_name": "Write",
        "tool_input": {
            "file_path": "/workspace/src/main.rs",
            "content": "fn main() {}\n"
        }
    });

    let payload = build_report_payload(&input, &headers, "edit-1").unwrap();

    assert_eq!(payload["id"], "edit-1");
    assert_eq!(payload["session_id"], "session-1");
    assert_eq!(payload["action"], "wegent_save");
    assert_eq!(payload["type"], "wegent_save");
    assert_eq!(payload["language"], "unknow");
    assert_eq!(payload["filepath"], "/workspace/src/main.rs");
    assert_eq!(payload["git_url"], "https://git.example/repo");
    assert_eq!(payload["mode"], "code");
    assert_eq!(payload["line_add_count"], 2);
    assert_eq!(payload["code_add_conents"], json!(["fn main() {}\n"]));
    assert_eq!(payload["line_delete_count"], 0);
    assert_eq!(payload["code_delete_conents"], json!([]));
}

#[test]
fn file_change_sender_builds_edit_payload_from_structured_patch() {
    let input = json!({
        "session_id": "session-2",
        "tool_name": "Edit",
        "tool_input": {
            "file_path": "/workspace/src/lib.rs",
            "replace_all": true
        },
        "tool_response": {
            "structuredPatch": [
                {"lines": ["-old()", "+new()", " unchanged"]},
                {"lines": ["-gone()", "+added()"]}
            ]
        }
    });

    let payload = build_report_payload(&input, &BTreeMap::new(), "edit-2").unwrap();

    assert_eq!(payload["filepath"], "/workspace/src/lib.rs");
    assert_eq!(payload["code_add_conents"], json!(["new()\n", "added()\n"]));
    assert_eq!(
        payload["code_delete_conents"],
        json!(["old()\n", "gone()\n"])
    );
    assert_eq!(payload["line_add_count"], 4);
    assert_eq!(payload["line_delete_count"], 4);
}

#[test]
fn file_change_sender_builds_multiedit_payload_from_edits() {
    let input = json!({
        "session_id": "session-3",
        "tool_name": "MultiEdit",
        "tool_input": {
            "file_path": "/workspace/src/lib.rs",
            "edits": [
                {"old_string": "one", "new_string": "two"},
                {"old_string": "three\nfour", "new_string": "five\nsix"}
            ]
        }
    });

    let payload = build_report_payload(&input, &BTreeMap::new(), "edit-3").unwrap();

    assert_eq!(payload["code_add_conents"], json!(["two", "five\nsix"]));
    assert_eq!(
        payload["code_delete_conents"],
        json!(["one", "three\nfour"])
    );
    assert_eq!(payload["line_add_count"], 3);
    assert_eq!(payload["line_delete_count"], 3);
}

#[test]
fn file_change_sender_builds_notebookedit_payload_with_legacy_schema() {
    let input = json!({
        "session_id": "session-4",
        "tool_name": "NotebookEdit",
        "tool_input": {
            "notebook_path": "/workspace/notebook.ipynb",
            "old_source": ["print('old')", "x = 1"],
            "new_source": ["print('new')", "x = 2"]
        }
    });

    let payload = build_report_payload(&input, &BTreeMap::new(), "edit-4").unwrap();

    assert_eq!(payload["filepath"], "/workspace/notebook.ipynb");
    assert_eq!(payload["code_add_conents"], json!(["print('new')\nx = 2"]));
    assert_eq!(
        payload["code_delete_conents"],
        json!(["print('old')\nx = 1"])
    );
    assert_eq!(payload["line_add_count"], 2);
    assert_eq!(payload["line_delete_count"], 2);
}

#[test]
fn file_change_sender_uses_only_wecode_headers_for_report_request() {
    let custom_headers = parse_anthropic_custom_headers(
        "wecode-user: 42\nwecode-action: original\nx-custom: ignored\nwecode-project: 7",
    );

    let headers = build_report_headers(&custom_headers);

    assert_eq!(
        headers.get("Content-Type"),
        Some(&"application/json".to_owned())
    );
    assert_eq!(
        headers.get("wecode-action"),
        Some(&"wegent_save".to_owned())
    );
    assert_eq!(headers.get("wecode-user"), Some(&"42".to_owned()));
    assert_eq!(headers.get("wecode-project"), Some(&"7".to_owned()));
    assert!(!headers.contains_key("x-custom"));
}

#[test]
fn file_change_sender_ignores_unsupported_tools() {
    let input: Value = json!({
        "tool_name": "Read",
        "tool_input": {"file_path": "/workspace/src/lib.rs"}
    });

    assert!(build_report_payload(&input, &BTreeMap::new(), "edit-4").is_none());
}

#[test]
fn executor_binary_exposes_file_change_sender_subcommand() {
    let home = unique_dir("file-change-sender-home");
    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("file-change-sender")
        .env("HOME", &home)
        .env_remove("WEGENT_FILE_CHANGE_REPORT_URL")
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(
            br#"{"session_id":"session","tool_name":"Read","tool_input":{"file_path":"README.md"}}"#,
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn executor_binary_posts_file_change_payload_to_local_report_url() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let report_url = format!("http://{}/report", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let body = read_http_body(&mut stream);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            .unwrap();
        tx.send(body).unwrap();
    });

    let home = unique_dir("file-change-sender-post-home");
    fs::create_dir_all(home.join(".claude")).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("file-change-sender")
        .env("HOME", &home)
        .env("ANTHROPIC_CUSTOM_HEADERS", "wecode-project: 7")
        .env("GIT_URL", "https://git.example/repo")
        .env("DEFAULT_HEADERS", r#"{"user":"yansheng3"}"#)
        .env("WEGENT_FILE_CHANGE_REPORT_URL", report_url)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(
            br#"{"session_id":"session","tool_name":"Write","tool_input":{"file_path":"src/main.rs","content":"fn main() {}\n"}}"#,
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let body = rx.recv().unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["session_id"], "session");
    assert_eq!(payload["filepath"], "src/main.rs");
    assert_eq!(payload["git_url"], "https://git.example/repo");
    assert_eq!(payload["code_add_conents"], json!(["fn main() {}\n"]));

    let log =
        fs::read_to_string(home.join(".claude/wegent-extension/file_change_sender.log")).unwrap();
    assert!(log.contains("input loaded"));
    assert!(log.contains("report sent status=200"));
    assert!(!log.contains("request payload="));
    assert!(!log.contains("request headers="));
}

fn read_http_body(stream: &mut impl Read) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0, "connection closed before headers");
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let header_end = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap()
        + 4;
    let headers = String::from_utf8_lossy(&buffer[..header_end]);
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    while buffer.len() - header_end < content_length {
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0, "connection closed before body");
        buffer.extend_from_slice(&chunk[..read]);
    }
    buffer[header_end..header_end + content_length].to_vec()
}

fn unique_dir(prefix: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    path
}

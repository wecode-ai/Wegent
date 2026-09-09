//! Bounded, streaming local-auth diagnostics. Raw stderr is never logged.
use serde_json::{json, Value};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt};

const PREFIX: &str = "WEGENT_PLUGIN_AUTH_DIAGNOSTIC:";
const MAX_LINE: usize = 4096;
const MAX_EVENTS: usize = 256;

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
}

fn safe_event(line: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(line).ok()?.trim();
    let input: Value = serde_json::from_str(text.strip_prefix(PREFIX)?).ok()?;
    let stage = input.get("stage")?.as_str()?;
    let status = input.get("status")?.as_str()?;
    if !identifier(stage) || !["started", "ok", "failed"].contains(&status) {
        return None;
    }
    let mut output = json!({"stage": stage, "status": status});
    // Business identifiers are plugin-defined codes, never free-form messages.
    // Plugin identity is supplied by the host rather than trusted from stderr.
    for key in ["platform", "reason", "error_code"] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            if identifier(value) {
                output[key] = json!(value);
            }
        }
    }
    if let Some(attempt) = input.get("attempt_id").and_then(Value::as_str) {
        if attempt.len() == 32 && attempt.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            output["attempt_id"] = json!(attempt);
        }
    }
    for key in ["exit_code", "system_code"] {
        if let Some(value) = input.get(key).and_then(Value::as_i64) {
            output[key] = json!(value);
        }
    }
    Some(output)
}

pub(super) struct Invocation {
    id: String,
    plugin: Option<String>,
    started: std::time::Instant,
    finished: bool,
}

impl Invocation {
    pub(super) fn new(root: &std::path::Path) -> Self {
        let plugin = std::fs::read(root.join(".codex-plugin/plugin.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.get("name").and_then(Value::as_str).map(str::to_owned))
            .filter(|name| identifier(name));
        let invocation = Self {
            id: uuid::Uuid::new_v4().to_string(),
            plugin,
            started: std::time::Instant::now(),
            finished: false,
        };
        invocation.emit(json!({"stage":"command", "status":"started"}));
        invocation
    }
    pub(super) fn emit(&self, mut event: Value) {
        event["invocation_id"] = json!(self.id);
        event["plugin"] = json!(self.plugin);
        log_event(event);
    }
    pub(super) fn finish(&mut self, code: Option<&str>) {
        let mut event = json!({"stage":"command", "status": if code.is_some() {"failed"} else {"ok"},
            "elapsed_ms": self.started.elapsed().as_millis()});
        if let Some(code) = code {
            event["error_code"] = json!(code);
        }
        self.emit(event);
        self.finished = true;
    }
}
impl Drop for Invocation {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(Some("local_auth_cancelled"));
        }
    }
}

pub(super) async fn read_stderr<R: AsyncRead + Unpin>(
    mut reader: R,
    mut emit: impl FnMut(Value),
) -> io::Result<Vec<u8>> {
    let mut chunk = [0; 2048];
    let mut line = Vec::new();
    let mut tail = Vec::new();
    let mut oversized = false;
    let mut count = 0;
    loop {
        let size = reader.read(&mut chunk).await?;
        if size == 0 {
            break;
        }
        tail.extend_from_slice(&chunk[..size]);
        if tail.len() > MAX_LINE {
            tail.drain(..tail.len() - MAX_LINE);
        }
        for &byte in &chunk[..size] {
            if byte == b'\n' {
                if !oversized && count < MAX_EVENTS {
                    if let Some(event) = safe_event(&line) {
                        emit(event);
                        count += 1;
                    }
                }
                line.clear();
                oversized = false;
            } else if line.len() < MAX_LINE {
                line.push(byte);
            } else {
                oversized = true;
            }
        }
    }
    if !oversized && count < MAX_EVENTS {
        if let Some(event) = safe_event(&line) {
            emit(event);
        }
    }
    Ok(tail)
}

pub(super) fn log_event(event: Value) {
    crate::logging::log_executor_event(
        "plugin auth diagnostic",
        &[("diagnostic", event.to_string())],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    fn line() -> String {
        format!(
            "{PREFIX}{}\n",
            json!({"plugin":"example-plugin","stage":"write","status":"failed","platform":"win32","attempt_id":"0123456789abcdef0123456789abcdef","password":"SECRET","reason":"permission_denied"})
        )
    }
    #[test]
    fn accepts_plugin_defined_codes_without_trusting_identity() {
        for name in ["calendar", "source-control", "custom-plugin"] {
            let line = format!(
                "{PREFIX}{}",
                json!({"plugin":name,"stage":"oauth.exchange", "status":"failed", "error_code":"provider_expired", "reason":"refresh_required", "message":"SECRET", "password":"SECRET"})
            );
            let event = safe_event(line.as_bytes()).unwrap();
            assert_eq!(event["error_code"], "provider_expired");
            assert!(event.get("plugin").is_none());
            assert!(!event.to_string().contains("SECRET"));
        }
    }
    #[test]
    fn rejects_free_text_and_unbounded_codes() {
        for stage in [
            "password=secret".to_string(),
            "x".repeat(65),
            "bad\nline".to_string(),
        ] {
            let line = format!("{PREFIX}{}", json!({"stage":stage,"status":"failed"}));
            assert!(safe_event(line.as_bytes()).is_none());
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn real_child_streams_before_exit() {
        use std::process::Stdio;
        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "printf '%s' \"$DIAGNOSTIC\" >&2; read answer"])
            .env("DIAGNOSTIC", line())
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let reader = child.stderr.take().unwrap();
        let read = tokio::spawn(read_stderr(reader, move |event| {
            sender.send(event).unwrap();
        }));
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["status"], "failed");
        assert!(child.try_wait().unwrap().is_none());
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"done\n")
            .await
            .unwrap();
        assert!(child.wait().await.unwrap().success());
        read.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn emits_before_eof_and_drops_unknown_fields() {
        let (mut writer, reader) = tokio::io::duplex(8192);
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(read_stderr(reader, move |event| {
            sender.send(event).unwrap();
        }));
        writer.write_all(line().as_bytes()).await.unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["stage"], "write");
        assert!(!event.to_string().contains("SECRET"));
        assert!(!task.is_finished());
        drop(writer);
        task.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn rejects_raw_and_oversized_lines_and_bounds_events() {
        let input = format!("SECRET\n{}\n{}", "x".repeat(10000), line().repeat(300));
        let mut events = Vec::new();
        let tail = read_stderr(input.as_bytes(), |event| events.push(event))
            .await
            .unwrap();
        assert_eq!(events.len(), MAX_EVENTS);
        assert!(tail.len() <= MAX_LINE);
        assert!(events
            .iter()
            .all(|event| !event.to_string().contains("SECRET")));
    }
}

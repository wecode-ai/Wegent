// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, process::Stdio, time::Duration};

use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
#[cfg(unix)]
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::{
    process::Command,
    time::{timeout_at, Instant},
};

use super::HttpError;
use crate::{logging::log_executor_event, process_environment};

pub(super) async fn start(headers: HeaderMap, body: Body) -> Result<Response, HttpError> {
    let received_at = Instant::now();
    let deadline = match headers.get("connect-timeout-ms").map(parse_connect_timeout) {
        Some(Some(timeout)) => Some(ProcessDeadline::new(received_at, timeout)),
        Some(None) => {
            return Ok(process_start_error(
                "invalid_argument",
                "Invalid connect-timeout-ms header",
            ));
        }
        None => None,
    };
    let bytes = axum::body::to_bytes(body, usize::MAX);
    let bytes = if let Some(deadline) = deadline {
        if deadline.expired() {
            return Ok(deadline_exceeded(deadline.timeout));
        }
        match timeout_at(deadline.at, bytes).await {
            Ok(bytes) if !deadline.expired() => bytes,
            _ => return Ok(deadline_exceeded(deadline.timeout)),
        }
    } else {
        bytes.await
    }
    .map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("failed to read process start request: {error}"),
    })?;
    let request: ProcessStartRequest = serde_json::from_slice(&connect_request_payload(&bytes)?)
        .map_err(|error| HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!("invalid process start request: {error}"),
        })?;
    Ok(match run_envd_process(&request, deadline).await {
        Ok(output) => process_start_response(process_start_stream_body(&output)),
        Err(timeout) => deadline_exceeded(timeout),
    })
}

#[derive(Clone, Copy)]
struct ProcessDeadline {
    at: Instant,
    timeout: Duration,
}

impl ProcessDeadline {
    fn new(received_at: Instant, timeout: Duration) -> Self {
        Self {
            at: received_at + timeout,
            timeout,
        }
    }

    fn expired(&self) -> bool {
        Instant::now() >= self.at
    }
}

#[derive(Debug, Deserialize)]
struct ProcessStartRequest {
    process: ProcessStartConfig,
}

#[derive(Debug, Deserialize)]
struct ProcessStartConfig {
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    envs: HashMap<String, String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug)]
struct ProcessOutput {
    pid: u32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: i32,
    error: String,
}

async fn run_envd_process(
    request: &ProcessStartRequest,
    deadline: Option<ProcessDeadline>,
) -> Result<ProcessOutput, Duration> {
    let requested_environment = request
        .process
        .envs
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Vec<_>>();
    let process_environment = process_environment::process_env(&requested_environment);
    let (program, prefix_args) = crate::process::spawn_program_parts(&request.process.cmd);
    let mut command = Command::new(program);
    crate::process::hide_windows_console(&mut command);
    command
        .args(prefix_args)
        .args(&request.process.args)
        .env_clear()
        .envs(process_environment)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    if deadline.is_some() {
        command.process_group(0);
    }
    if let Some(cwd) = request
        .process
        .cwd
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        command.current_dir(cwd);
    }
    log_executor_event(
        "envd process start request",
        &[
            ("cmd", request.process.cmd.clone()),
            ("arg_count", request.process.args.len().to_string()),
            ("cwd", request.process.cwd.clone().unwrap_or_default()),
        ],
    );
    if let Some(deadline) = deadline.filter(ProcessDeadline::expired) {
        return Err(deadline.timeout);
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(ProcessOutput {
                pid: 0,
                stdout: Vec::new(),
                stderr: error.to_string().into_bytes(),
                exit_code: -1,
                error: error.to_string(),
            });
        }
    };
    let pid = child.id().unwrap_or_default();
    Ok(match wait_for_envd_process(child, deadline).await? {
        Ok(output) => {
            let exit_code = output.status.code().unwrap_or(-1);
            log_executor_event(
                "envd process finished",
                &[
                    ("pid", pid.to_string()),
                    ("exit_code", exit_code.to_string()),
                    ("stdout_len", output.stdout.len().to_string()),
                    ("stderr_len", output.stderr.len().to_string()),
                ],
            );
            ProcessOutput {
                pid,
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code,
                error: String::new(),
            }
        }
        Err(error) => ProcessOutput {
            pid,
            stdout: Vec::new(),
            stderr: error.to_string().into_bytes(),
            exit_code: -1,
            error: error.to_string(),
        },
    })
}

async fn wait_for_envd_process(
    child: tokio::process::Child,
    deadline: Option<ProcessDeadline>,
) -> Result<std::io::Result<std::process::Output>, Duration> {
    let Some(deadline) = deadline else {
        return Ok(child.wait_with_output().await);
    };
    let pid = child.id();
    #[cfg(unix)]
    let mut child = child;
    #[cfg(unix)]
    let mut process_group = ProcessGroupGuard(pid);
    #[cfg(unix)]
    let output = collect_output_before_reaping(&mut child);
    #[cfg(not(unix))]
    let output = child.wait_with_output();
    if let Ok(result) = timeout_at(deadline.at, output).await {
        #[cfg(unix)]
        if result.is_ok() {
            process_group.0 = None;
        }
        return Ok(result);
    }
    if let Some(pid) = pid {
        #[cfg(windows)]
        wegent_subprocess::kill_windows_process_tree(pid);
        log_executor_event(
            "envd process deadline exceeded",
            &[
                ("pid", pid.to_string()),
                ("timeout_ms", deadline.timeout.as_millis().to_string()),
            ],
        );
    }
    Err(deadline.timeout)
}

#[cfg(unix)]
async fn collect_output_before_reaping(
    child: &mut tokio::process::Child,
) -> std::io::Result<std::process::Output> {
    drop(child.stdin.take());
    // A detached descendant can hold a pipe open after the leader exits. Keep
    // the leader unreaped so its PID cannot be reused while cleanup is armed.
    let (stdout, stderr) = tokio::try_join!(
        read_process_pipe(child.stdout.take()),
        read_process_pipe(child.stderr.take())
    )?;
    let status = child.wait().await?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(unix)]
async fn read_process_pipe(pipe: Option<impl AsyncRead + Unpin>) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut output).await?;
    }
    Ok(output)
}

#[cfg(unix)]
struct ProcessGroupGuard(Option<u32>);

#[cfg(unix)]
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            // The child owns this group. Stop its foreground descendants even if
            // shutdown cancels the wait before the command deadline fires.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}

fn parse_connect_timeout(header: &HeaderValue) -> Option<Duration> {
    let value = header.to_str().ok()?;
    if value.is_empty() || value.len() > 10 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok().map(Duration::from_millis)
}

fn connect_request_payload(bytes: &[u8]) -> Result<Vec<u8>, HttpError> {
    if bytes.len() < CONNECT_ENVELOPE_HEADER_LEN {
        return Ok(bytes.to_vec());
    }
    let flags = bytes[0];
    let len = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
    if bytes.len() == CONNECT_ENVELOPE_HEADER_LEN + len {
        if flags & CONNECT_FLAG_COMPRESSED != 0 {
            return Err(HttpError {
                status: StatusCode::BAD_REQUEST,
                detail: "compressed connect requests are not supported".to_owned(),
            });
        }
        return Ok(bytes[CONNECT_ENVELOPE_HEADER_LEN..].to_vec());
    }
    Ok(bytes.to_vec())
}

fn process_start_stream_body(output: &ProcessOutput) -> Vec<u8> {
    let mut stream = Vec::new();
    append_connect_json_message(
        &mut stream,
        json!({"event": {"start": {"pid": output.pid}}}),
    );
    if !output.stdout.is_empty() {
        append_connect_json_message(
            &mut stream,
            json!({"event": {"data": {"stdout": base64_encode(&output.stdout)}}}),
        );
    }
    if !output.stderr.is_empty() {
        append_connect_json_message(
            &mut stream,
            json!({"event": {"data": {"stderr": base64_encode(&output.stderr)}}}),
        );
    }
    append_connect_json_message(
        &mut stream,
        json!({
            "event": {
                "end": {
                    "exitCode": output.exit_code,
                    "exited": true,
                    "status": if output.exit_code == 0 { "success" } else { "error" },
                    "error": output.error,
                }
            }
        }),
    );
    append_connect_envelope(&mut stream, CONNECT_FLAG_END_STREAM, b"{}");
    stream
}

fn deadline_exceeded(timeout: Duration) -> Response {
    process_start_error(
        "deadline_exceeded",
        &format!(
            "Sandbox command exceeded its {} ms deadline",
            timeout.as_millis()
        ),
    )
}

fn process_start_error(code: &str, message: &str) -> Response {
    let mut stream = Vec::new();
    let payload = json!({"error": {"code": code, "message": message}});
    append_connect_envelope(
        &mut stream,
        CONNECT_FLAG_END_STREAM,
        payload.to_string().as_bytes(),
    );
    process_start_response(stream)
}

fn process_start_response(stream: Vec<u8>) -> Response {
    (
        [(header::CONTENT_TYPE, "application/connect+json")],
        Body::from(stream),
    )
        .into_response()
}

fn append_connect_json_message(stream: &mut Vec<u8>, value: Value) {
    append_connect_envelope(stream, 0, value.to_string().as_bytes());
}

fn append_connect_envelope(stream: &mut Vec<u8>, flags: u8, data: &[u8]) {
    stream.push(flags);
    stream.extend_from_slice(&(data.len() as u32).to_be_bytes());
    stream.extend_from_slice(data);
}

fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

const CONNECT_ENVELOPE_HEADER_LEN: usize = 5;
const CONNECT_FLAG_COMPRESSED: u8 = 0b0000_0001;
const CONNECT_FLAG_END_STREAM: u8 = 0b0000_0010;

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use std::{future::Future, task::Poll};
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::time::timeout;

    fn deadline_after(timeout: Duration) -> Option<ProcessDeadline> {
        Some(ProcessDeadline::new(Instant::now(), timeout))
    }

    fn spawn_process_with_descendant() -> (
        tokio::process::Child,
        tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    ) {
        let mut child = Command::new("/bin/bash")
            .args(["-c", "sleep 30 & printf 'ready\\n'; wait"])
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        (child, lines)
    }

    #[tokio::test]
    async fn cancelling_envd_process_stops_foreground_descendants() {
        let (child, mut lines) = spawn_process_with_descendant();
        let step_timeout = Duration::from_secs(5);

        {
            let wait = wait_for_envd_process(child, deadline_after(Duration::from_secs(60)));
            tokio::pin!(wait);
            let ready = timeout(step_timeout, async {
                tokio::select! {
                    biased;
                    _ = &mut wait => panic!("command exited before cancellation"),
                    line = lines.next_line() => line.unwrap(),
                }
            })
            .await
            .expect("shell did not confirm that its descendant had started");
            assert_eq!(ready.as_deref(), Some("ready"));
        }

        assert_eq!(
            timeout(step_timeout, lines.next_line())
                .await
                .expect("descendant kept stdout open after cancellation")
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn envd_deadline_stops_foreground_descendants() {
        let (child, mut lines) = spawn_process_with_descendant();
        let step_timeout = Duration::from_secs(5);
        let ready = timeout(step_timeout, lines.next_line())
            .await
            .expect("shell did not confirm that its descendant had started")
            .unwrap();
        assert_eq!(ready.as_deref(), Some("ready"));

        let deadline = Duration::from_millis(100);
        assert!(matches!(
            wait_for_envd_process(child, deadline_after(deadline)).await,
            Err(elapsed) if elapsed == deadline
        ));
        // The descendant inherited stdout and keeps it open until it exits.
        assert_eq!(
            timeout(step_timeout, lines.next_line())
                .await
                .expect("descendant kept stdout open after the deadline")
                .unwrap(),
            None
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn envd_reserves_process_group_id_while_a_descendant_holds_output_open() {
        let child = Command::new("/bin/bash")
            .args(["-c", "sleep 30 & exit 0"])
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        timeout(
            Duration::from_secs(5),
            tokio::task::spawn_blocking(move || peek_child_exit(pid, 0)),
        )
        .await
        .expect("shell did not exit after launching its descendant")
        .unwrap()
        .unwrap();

        let wait = wait_for_envd_process(child, deadline_after(Duration::from_secs(60)));
        tokio::pin!(wait);
        std::future::poll_fn(|cx| {
            assert!(wait.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;

        peek_child_exit(pid, libc::WNOHANG).expect("process leader was already reaped");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn peek_child_exit(pid: u32, options: libc::c_int) -> std::io::Result<()> {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // Observe the exit without consuming it from Tokio's child handle.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT | options,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error());
        }
        assert_eq!(unsafe { info.assume_init().si_pid() }, pid as libc::pid_t);
        Ok(())
    }

    #[tokio::test]
    async fn envd_process_filters_exported_bash_functions() {
        let request = ProcessStartRequest {
            process: ProcessStartConfig {
                cmd: "/bin/bash".to_owned(),
                args: vec!["-c".to_owned(), "printf ready".to_owned()],
                envs: HashMap::from([("BASH_FUNC_which%%".to_owned(), "() {".to_owned())]),
                cwd: None,
            },
        };

        let output = run_envd_process(&request, None).await.unwrap();

        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, b"ready");
        assert!(output.stderr.is_empty());
    }
}

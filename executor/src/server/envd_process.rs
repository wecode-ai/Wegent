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
use tokio::{process::Command, time::timeout};

use super::HttpError;
use crate::{logging::log_executor_event, process_environment};

pub(super) async fn start(headers: HeaderMap, body: Body) -> Result<Response, HttpError> {
    let deadline = match headers.get("connect-timeout-ms").map(parse_connect_timeout) {
        Some(Some(deadline)) => Some(deadline),
        Some(None) => {
            return Ok(process_start_error(
                "invalid_argument",
                "Invalid connect-timeout-ms header",
            ));
        }
        None => None,
    };
    if deadline.is_some_and(|deadline| deadline.is_zero()) {
        return Ok(process_start_error(
            "deadline_exceeded",
            "Sandbox command exceeded its 0 ms deadline",
        ));
    }

    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
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
        Err(deadline) => process_start_error(
            "deadline_exceeded",
            &format!(
                "Sandbox command exceeded its {} ms deadline",
                deadline.as_millis()
            ),
        ),
    })
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
    deadline: Option<Duration>,
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
    deadline: Option<Duration>,
) -> Result<std::io::Result<std::process::Output>, Duration> {
    let Some(deadline) = deadline else {
        return Ok(child.wait_with_output().await);
    };
    let pid = child.id();
    let output = child.wait_with_output();
    tokio::pin!(output);
    if let Ok(result) = timeout(deadline, &mut output).await {
        return Ok(result);
    }
    if let Some(pid) = pid {
        #[cfg(unix)]
        // The child owns this group. Stop foreground descendants as well as the shell.
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
        #[cfg(windows)]
        wegent_subprocess::kill_windows_process_tree(pid);
        log_executor_event(
            "envd process deadline exceeded",
            &[
                ("pid", pid.to_string()),
                ("timeout_ms", deadline.as_millis().to_string()),
            ],
        );
    }
    Err(deadline)
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

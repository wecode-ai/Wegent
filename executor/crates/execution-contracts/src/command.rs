//! Device command input, normalization, and result contract.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, future::Future, pin::Pin};

const DEFAULT_TIMEOUT_SECONDS: f64 = 60.0;
const MAX_TIMEOUT_SECONDS: f64 = 600.0;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 5 * 1024 * 1024;

pub trait DeviceCommandHandler: Send + Sync {
    fn handle_execute_command<'a>(
        &'a self,
        request: CommandRequest,
    ) -> Pin<Box<dyn Future<Output = CommandResult> + Send + 'a>>;
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandRequest {
    #[serde(default)]
    pub command_key: Option<String>,
    pub command: String,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub timeout_seconds: f64,
    pub max_output_bytes: usize,
}

impl CommandRequest {
    pub fn from_value(value: Value) -> Self {
        let command = string_field(&value, "command").unwrap_or_default();
        let argv = value
            .get("argv")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|items| !items.is_empty() && !items[0].trim().is_empty())
            .unwrap_or_default();
        let cwd = string_field(&value, "cwd").filter(|path| !path.trim().is_empty());
        let env = value
            .get("env")
            .and_then(Value::as_object)
            .map(|items| {
                items
                    .iter()
                    .filter(|(key, _)| !key.is_empty())
                    .map(|(key, value)| {
                        (
                            key.clone(),
                            value
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| value.to_string()),
                        )
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();

        Self {
            command_key: string_field(&value, "command_key"),
            command,
            argv,
            cwd,
            env,
            timeout_seconds: normalized_f64(
                value.get("timeout_seconds"),
                DEFAULT_TIMEOUT_SECONDS,
                MAX_TIMEOUT_SECONDS,
            ),
            max_output_bytes: normalized_usize(
                value.get("max_output_bytes"),
                DEFAULT_MAX_OUTPUT_BYTES,
                MAX_OUTPUT_BYTES,
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: Value,
    pub stderr: String,
    pub duration: f64,
    pub timed_out: bool,
    #[serde(default)]
    pub stdout_truncated: bool,
    #[serde(default)]
    pub stderr_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CommandResult {
    pub fn ok(stdout: impl Into<Value>) -> Self {
        Self {
            success: true,
            exit_code: Some(0),
            stdout: stdout.into(),
            stderr: String::new(),
            duration: 0.0,
            timed_out: false,
            stdout_truncated: false,
            stderr_truncated: false,
            error: None,
        }
    }

    pub fn error(message: String, duration: f64, timed_out: bool) -> Self {
        Self {
            success: false,
            exit_code: None,
            stdout: Value::String(String::new()),
            stderr: String::new(),
            duration,
            timed_out,
            stdout_truncated: false,
            stderr_truncated: false,
            error: Some(message),
        }
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn normalized_usize(value: Option<&Value>, default: usize, upper_bound: usize) -> usize {
    normalized_f64(value, default as f64, upper_bound as f64).round() as usize
}

fn normalized_f64(value: Option<&Value>, default: f64, upper_bound: f64) -> f64 {
    let parsed = value
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(default);
    if parsed <= 0.0 {
        default
    } else {
        parsed.min(upper_bound)
    }
}

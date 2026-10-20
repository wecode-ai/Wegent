// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Local device command registry shared by `POST /api/devices/{device_id}/commands`.
//!
//! Mirrors `app/services/device/command_registry.py` and the registry state
//! `app/services/device/command_service.py` owns:
//!
//! - [`DEFAULT_COMMANDS`] is the source's `DEFAULT_LOCAL_DEVICE_COMMANDS`
//!   (embedded verbatim in `defaults_*` modules);
//! - `LOCAL_DEVICE_COMMANDS` overrides a key before the built-in definition,
//!   exactly like `settings.LOCAL_DEVICE_COMMANDS`;
//! - [`register_device_command`] is the source's distribution-owned
//!   registration (`register_device_command`), used by an application crate to
//!   add commands and their allowed device types at startup;
//! - [`resolve_local_device_command`] returns the command text and post
//!   processor, and [`build_local_device_command_argv`] performs the source's
//!   `shlex.split(command)` plus caller arguments.
//!
//! Command text is the device contract: the handler publishes it verbatim in
//! the `device:execute_command` payload, so it must never be normalized.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

mod defaults_codex;
mod defaults_git;
mod defaults_hosting;
mod defaults_internal;
mod defaults_runtime;
mod defaults_skills;
mod defaults_workspace;
mod post_process;
mod request;
mod response;
mod shlex;

pub(crate) use post_process::apply_command_post_processor;
pub(crate) use request::DeviceCommandRequest;
pub(crate) use response::{DeviceCommandResponse, response_from_result};

use crate::http_compat::FastApiError;

/// `python_exception_handler`'s unhandled-exception body.
pub(crate) fn unhandled() -> FastApiError {
    FastApiError::unhandled()
}

/// `command_service.DEFAULT_COMMAND_TIMEOUT_SECONDS`.
pub(crate) const DEFAULT_COMMAND_TIMEOUT_SECONDS: i64 = 60;
/// `command_service.MAX_COMMAND_TIMEOUT_SECONDS`.
pub(crate) const MAX_COMMAND_TIMEOUT_SECONDS: i64 = 600;
/// `command_service.DEFAULT_MAX_OUTPUT_BYTES`.
pub(crate) const DEFAULT_MAX_OUTPUT_BYTES: i64 = 1024 * 1024;
/// `command_service.MAX_OUTPUT_BYTES`.
pub(crate) const MAX_OUTPUT_BYTES: i64 = 5 * 1024 * 1024;
/// `command_service.SOCKET_ACK_GRACE_SECONDS`.
pub(crate) const SOCKET_ACK_GRACE_SECONDS: i64 = 5;

/// `command_service.INTERNAL_DEVICE_COMMAND_KEYS`: never reachable through the
/// command API.
pub(crate) const INTERNAL_DEVICE_COMMAND_KEYS: [&str; 2] =
    ["environment_prepare", "sync_git_credentials"];

/// `command_service.REMOTE_READ_ONLY_COMMAND_KEYS`.
const REMOTE_READ_ONLY_COMMAND_KEYS: [&str; 25] = [
    "pwd",
    "home_dir",
    "ls_dirs",
    "workspace_tree",
    "workspace_read_text_file",
    "workspace_read_file_chunk",
    "git_branch",
    "git_branch_list",
    "git_diff",
    "git_branch_diff",
    "git_diff_unstaged",
    "git_diff_staged",
    "git_diff_last_commit",
    "git_branch_diff_shortstat",
    "git_status_porcelain",
    "git_remote_url",
    "git_github_cli_status",
    "git_gitlab_cli_status",
    "git_github_pull_requests",
    "git_github_pull_requests_batch",
    "git_github_pull_request_merge_queue_batch",
    "git_gitlab_merge_requests",
    "git_gitlab_merge_requests_batch",
    "git_generate_commit_message",
    "turn_file_changes_review",
];

/// `command_service.REMOTE_MUTATING_COMMAND_KEYS`.
const REMOTE_MUTATING_COMMAND_KEYS: [&str; 10] = [
    "mkdir_p",
    "git_checkout",
    "git_checkout_new",
    "git_add_all",
    "git_apply_patch",
    "git_commit",
    "git_push",
    "sync_git_credentials",
    "turn_file_changes_revert",
    "environment_prepare",
];

/// `command_service.RUNTIME_AUTH_COMMAND_KEYS`.
const RUNTIME_AUTH_COMMAND_KEYS: [&str; 2] = ["read_runtime_auth_file", "sync_runtime_auth_file"];

/// `command_service.execute_configured_device_command`'s payload keys that
/// carry `command_key` to the executor.
const EXECUTOR_COMMAND_KEY_KEYS: [&str; 5] = [
    "environment_prepare",
    "git_apply_patch",
    "workspace_tree",
    "workspace_read_text_file",
    "workspace_read_file_chunk",
];

/// One registered command definition (`LocalDeviceCommandDefinition`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceCommandSpec {
    /// The configured command text.
    pub command: &'static str,
    /// Optional post-processor name (`file_list`, `directory_list`, `json`).
    pub post_processor: Option<&'static str>,
}

/// A resolved command: a built-in/registered definition or a config override.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandDefinition {
    pub command: Cow<'static, str>,
    pub post_processor: Option<Cow<'static, str>>,
}

/// `CommandRegistryError`: invalid registry state or command definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRegistryError(pub String);

impl std::fmt::Display for CommandRegistryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CommandRegistryError {}

struct RegisteredCommand {
    definition: DeviceCommandSpec,
    allowed_device_types: &'static [&'static str],
}

fn registered_commands() -> &'static Mutex<BTreeMap<&'static str, RegisteredCommand>> {
    static COMMANDS: OnceLock<Mutex<BTreeMap<&'static str, RegisteredCommand>>> = OnceLock::new();
    COMMANDS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Register one distribution-owned command and its device-type policy.
///
/// Mirrors `command_service.register_device_command`: a key may be registered
/// once, must have at least one allowed device type, and must not shadow a
/// built-in command. Call this during startup before the application serves
/// requests.
pub fn register_device_command(
    key: &'static str,
    definition: DeviceCommandSpec,
    allowed_device_types: &'static [&'static str],
) -> Result<(), CommandRegistryError> {
    if key.is_empty() || allowed_device_types.is_empty() {
        return Err(CommandRegistryError(format!(
            "Invalid device command registration: {key}"
        )));
    }
    if default_lookup(key).is_some() {
        return Err(CommandRegistryError(format!(
            "Local device command '{key}' is already registered"
        )));
    }
    let mut commands = registered_commands()
        .lock()
        .map_err(|_| CommandRegistryError("device command registry is poisoned".into()))?;
    if commands.contains_key(key) {
        return Err(CommandRegistryError(format!(
            "Invalid device command registration: {key}"
        )));
    }
    commands.insert(
        key,
        RegisteredCommand {
            definition,
            allowed_device_types,
        },
    );
    Ok(())
}

/// The device-type policy registered for one key, if the key is registered.
pub(crate) fn registered_scope(key: &str) -> Option<&'static [&'static str]> {
    registered_commands().lock().ok().and_then(|commands| {
        commands
            .get(key)
            .map(|command| command.allowed_device_types)
    })
}

/// `command_key in INTERNAL_DEVICE_COMMAND_KEYS` for the submitted spelling.
pub(crate) fn is_internal_command_key(key: &str) -> bool {
    INTERNAL_DEVICE_COMMAND_KEYS.contains(&key)
}

/// Whether one key may target a `cloud`/`remote` device
/// (`REMOTE_DEVICE_COMMAND_KEYS | registered-for-type keys`).
pub(crate) fn remote_command_allowed(key: &str, device_type: &str) -> bool {
    REMOTE_READ_ONLY_COMMAND_KEYS.contains(&key)
        || REMOTE_MUTATING_COMMAND_KEYS.contains(&key)
        || RUNTIME_AUTH_COMMAND_KEYS.contains(&key)
        || registered_scope(key).is_some_and(|types| types.contains(&device_type))
}

/// Whether the executor payload carries `command_key` for this spelling.
pub(crate) fn executor_payload_carries_key(key: &str) -> bool {
    EXECUTOR_COMMAND_KEY_KEYS.contains(&key)
}

/// Parse `LOCAL_DEVICE_COMMANDS` once, at startup.
///
/// The source pydantic setting validates and normalizes the mapping while the
/// process starts; an invalid value fails startup instead of surfacing on the
/// first request.
pub(crate) fn init_from_env() -> Result<(), CommandRegistryError> {
    configured_commands().map(|_| ())
}

fn configured_commands() -> Result<&'static BTreeMap<String, Value>, CommandRegistryError> {
    static CONFIGURED: OnceLock<Result<BTreeMap<String, Value>, String>> = OnceLock::new();
    match CONFIGURED.get_or_init(|| parse_configured_commands().map_err(|error| error.0)) {
        Ok(commands) => Ok(commands),
        Err(message) => Err(CommandRegistryError(message.clone())),
    }
}

/// `app.core.config._parse_json_object_setting`: a JSON object whose keys are
/// stripped; blank keys are dropped.
fn parse_configured_commands() -> Result<BTreeMap<String, Value>, CommandRegistryError> {
    let Some(raw) = crate::config::env_or_dotenv("LOCAL_DEVICE_COMMANDS") else {
        return Ok(BTreeMap::new());
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(BTreeMap::new());
    }
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|_| CommandRegistryError("LOCAL_DEVICE_COMMANDS must be a JSON object".into()))?;
    let Value::Object(object) = parsed else {
        return Err(CommandRegistryError(
            "LOCAL_DEVICE_COMMANDS must be a JSON object".into(),
        ));
    };
    let mut commands = BTreeMap::new();
    for (key, value) in object {
        let key = key.trim();
        if !key.is_empty() {
            commands.insert(key.to_string(), value);
        }
    }
    Ok(commands)
}

/// `resolve_local_device_command`: config override first, then built-in and
/// registered defaults. The caller's key is stripped before lookup.
pub(crate) fn resolve_local_device_command(
    key: &str,
) -> Result<Option<CommandDefinition>, CommandRegistryError> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(None);
    }
    let configured = configured_commands()?;
    let default = default_command(key);
    if let Some(raw) = configured.get(key) {
        return parse_definition(key, raw, default).map(Some);
    }
    Ok(default.map(|definition| CommandDefinition {
        command: Cow::Borrowed(definition.command),
        post_processor: definition.post_processor.map(Cow::Borrowed),
    }))
}

/// `build_local_device_command_argv`: `shlex.split(command) + args`.
///
/// The source raises `ValueError` for an unbalanced quote or an empty argv;
/// that failure is an unhandled server error, not a configuration error.
pub(crate) fn build_local_device_command_argv(
    command: &str,
    args: &[String],
) -> Result<Vec<String>, CommandRegistryError> {
    let mut argv =
        shlex::split(command).map_err(|error| CommandRegistryError(error.to_string()))?;
    if argv.is_empty() {
        return Err(CommandRegistryError(
            "Local device command resolved to an empty argv".into(),
        ));
    }
    argv.extend_from_slice(args);
    Ok(argv)
}

/// `_parse_command_definition`: one configured override.
fn parse_definition(
    key: &str,
    raw: &Value,
    default: Option<DeviceCommandSpec>,
) -> Result<CommandDefinition, CommandRegistryError> {
    match raw {
        Value::String(text) => {
            let command = text.trim();
            if command.is_empty() {
                return Err(CommandRegistryError(format!(
                    "Local device command '{key}' has an empty command"
                )));
            }
            Ok(CommandDefinition {
                command: Cow::Owned(command.to_string()),
                post_processor: default
                    .and_then(|definition| definition.post_processor)
                    .map(Cow::Borrowed),
            })
        }
        Value::Object(object) => {
            let raw_command = object
                .get("command")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new()));
            let command = python_str(&raw_command);
            let command = command.trim();
            if command.is_empty() {
                return Err(CommandRegistryError(format!(
                    "Local device command '{key}' must define command"
                )));
            }
            let post_processor = match object.get("post_processor") {
                Some(Value::Null) => None,
                Some(value) => {
                    let text = python_str(value);
                    let text = text.trim();
                    (!text.is_empty()).then(|| Cow::Owned(text.to_string()))
                }
                None => default
                    .and_then(|definition| definition.post_processor)
                    .map(Cow::Borrowed),
            };
            Ok(CommandDefinition {
                command: Cow::Owned(command.to_string()),
                post_processor,
            })
        }
        _ => Err(CommandRegistryError(format!(
            "Local device command '{key}' must be a command string or object"
        ))),
    }
}

/// Registered definitions first, then the embedded source defaults.
fn default_command(key: &str) -> Option<DeviceCommandSpec> {
    registered_commands()
        .lock()
        .ok()
        .and_then(|commands| commands.get(key).map(|command| command.definition))
        .or_else(|| default_lookup(key))
}

fn default_lookup(key: &str) -> Option<DeviceCommandSpec> {
    defaults_workspace::lookup(key)
        .or_else(|| defaults_git::lookup(key))
        .or_else(|| defaults_skills::lookup(key))
        .or_else(|| defaults_codex::lookup(key))
        .or_else(|| defaults_hosting::lookup(key))
        .or_else(|| defaults_runtime::lookup(key))
        .or_else(|| defaults_internal::lookup(key))
}

/// Python truthiness for the source's `or`/`if not` guards.
pub(crate) fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(object) => !object.is_empty(),
    }
}

/// Python `str(value)` for the values the registry and post-processors pass
/// through `str()`.
pub(crate) fn python_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(_) | Value::Object(_) => python_repr(value),
    }
}

/// Python `repr(value)` for containers (used by `str()` on a list or dict).
fn python_repr(value: &Value) -> String {
    match value {
        Value::String(text) => python_repr_string(text),
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(python_repr).collect();
            format!("[{}]", items.join(", "))
        }
        Value::Object(object) => {
            let items: Vec<String> = object
                .iter()
                .map(|(key, value)| format!("{}: {}", python_repr_string(key), python_repr(value)))
                .collect();
            format!("{{{}}}", items.join(", "))
        }
    }
}

/// Python `repr(str)` with single quotes and the printable escapes.
fn python_repr_string(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::with_capacity(text.len() + 2);
    out.push(quote);
    for character in text.chars() {
        match character {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if other == quote => {
                out.push('\\');
                out.push(other);
            }
            other if (other as u32) < 0x20 || other as u32 == 0x7f => {
                out.push_str(&format!("\\x{:02x}", other as u32));
            }
            other => out.push(other),
        }
    }
    out.push(quote);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_default_command_resolves_and_splits() {
        for key in [
            "pwd",
            "home_dir",
            "workspace_tree",
            "workspace_read_text_file",
            "ls_a",
            "ls_dirs",
            "git_status_porcelain",
            "git_apply_patch",
            "sync_git_credentials",
            "turn_file_changes_review",
        ] {
            let definition = resolve_local_device_command(key)
                .expect("registry lookup succeeds")
                .expect("default command exists");
            let argv = build_local_device_command_argv(&definition.command, &[])
                .expect("default command splits");
            assert!(!argv.is_empty(), "{key}");
        }
    }

    #[test]
    fn caller_arguments_are_appended_after_the_split_command() {
        let definition = resolve_local_device_command("pwd")
            .expect("registry lookup succeeds")
            .expect("default command exists");
        let argv = build_local_device_command_argv(&definition.command, &["plan.md".into()])
            .expect("command splits");
        assert_eq!(argv, ["pwd", "plan.md"]);
    }

    #[test]
    fn blank_keys_resolve_to_nothing() {
        assert_eq!(resolve_local_device_command("   ").unwrap(), None);
        assert_eq!(resolve_local_device_command("not_a_command").unwrap(), None);
    }

    #[test]
    fn python_str_matches_the_source_scalars_and_containers() {
        assert_eq!(python_str(&Value::Null), "None");
        assert_eq!(python_str(&serde_json::json!(["a", 1])), "['a', 1]");
        assert_eq!(python_str(&serde_json::json!({"a": true})), "{'a': True}");
    }
}

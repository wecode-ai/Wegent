// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fmt,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

mod support;

use support::{
    append_unique_inherited_session, bool_member, bot_matches, dedupe_sessions, dedupe_strings,
    format_url_host, has_excluded_part, i64_member, is_loopback_host, is_unsafe_archive_member,
    normalize_inherited_session, normalize_path, object_value, optional_string_member,
    payload_string_list, string_field, string_list_member, string_member, u64_member,
};

pub const DIRECT_TRANSFER_BIND_HOST: &str = "0.0.0.0";
pub const TRANSFER_PATH_PREFIX: &str = "/runtime-task-transfers/";
pub const TRANSFER_UPLOAD_PATH_PREFIX: &str = "/runtime-task-transfer-uploads/";
pub const ARCHIVE_IO_CHUNK_BYTES: usize = 1024 * 1024;
pub const TRANSFER_TOKEN_HEADER: &str = "X-Wegent-Transfer-Token";
pub const TRANSFER_PROOF_HEADER: &str = "X-Wegent-Transfer-Proof";
pub const HOME_ARCHIVE_PREFIX: &str = "home";
pub const RUNTIME_FORK_ARCHIVE_PREFIX: &str = "runtime-fork";
pub const RUNTIME_FORK_UNTRACKED_PREFIX: &str = "runtime-fork/untracked";

const ARCHIVE_EXCLUDED_NAMES: &[&str] = &[
    ".DS_Store",
    ".git",
    ".hg",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".turbo",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "venv",
    ".venv",
];

pub type ForkTransferResult<T> = Result<T, ForkTransferError>;

#[derive(Debug)]
pub enum ForkTransferError {
    MissingField {
        code: &'static str,
        field: &'static str,
    },
    InvalidField {
        code: &'static str,
        field: &'static str,
        expected: &'static str,
    },
    UnsupportedArchiveType(String),
    MissingBaseCommit,
    ConflictingTransfer,
    Io(String),
    Join(String),
}

impl ForkTransferError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingField { code, .. } | Self::InvalidField { code, .. } => code,
            Self::UnsupportedArchiveType(_) => "unsupported_archive_type",
            Self::MissingBaseCommit => "missing_base_commit",
            Self::ConflictingTransfer => "conflicting_transfer",
            Self::Io(_) => "io_error",
            Self::Join(_) => "join_error",
        }
    }
}

impl fmt::Display for ForkTransferError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingField { field, .. } => write!(formatter, "{field} is required"),
            Self::InvalidField {
                field, expected, ..
            } => write!(formatter, "{field} must be {expected}"),
            Self::UnsupportedArchiveType(archive_type) => {
                write!(
                    formatter,
                    "Unsupported runtime fork archive type: {archive_type}"
                )
            }
            Self::MissingBaseCommit => {
                write!(formatter, "Runtime fork archive is missing baseCommit")
            }
            Self::ConflictingTransfer => write!(
                formatter,
                "Runtime fork archive has a different localTransferId"
            ),
            Self::Io(error) | Self::Join(error) => formatter.write_str(error),
        }
    }
}

impl std::error::Error for ForkTransferError {}

impl From<std::io::Error> for ForkTransferError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitPatchArchiveMetadata {
    pub base_commit: String,
    pub base_ref: Option<String>,
    pub source_head: Option<String>,
    pub source_branch: Option<String>,
    pub remote_url: Option<String>,
    pub workspace_pathspec: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveMetadata {
    GitPatch(GitPatchArchiveMetadata),
    SessionOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveRestorePlan {
    pub base_commit: Option<String>,
    pub checkout_base_commit: bool,
    pub apply_patch: bool,
    pub extract_untracked_overlay: bool,
    pub restore_sessions: bool,
}

impl ArchiveRestorePlan {
    pub fn from_metadata(
        metadata: &ArchiveMetadata,
        patch_size_bytes: usize,
    ) -> ForkTransferResult<Self> {
        Ok(match metadata {
            ArchiveMetadata::GitPatch(git_patch) => Self {
                base_commit: Some(git_patch.base_commit.clone()),
                checkout_base_commit: true,
                apply_patch: patch_size_bytes > 0,
                extract_untracked_overlay: true,
                restore_sessions: true,
            },
            ArchiveMetadata::SessionOnly => Self {
                base_commit: None,
                checkout_base_commit: false,
                apply_patch: false,
                extract_untracked_overlay: false,
                restore_sessions: true,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritedSession {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_task_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceTaskIdentity {
    pub device_id: Option<String>,
    pub workspace_path: Option<String>,
    pub local_task_id: String,
    pub thread_id: Option<String>,
    pub runtime: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkedTaskMetadata {
    pub source_task_id: i64,
    pub after_message_id: i64,
    pub root_task_id: i64,
    pub target_device_id: Option<String>,
    pub runtime: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeThreadMapping {
    pub parent: SourceTaskIdentity,
    pub child_local_task_id: String,
    pub child_thread_id: Option<String>,
    pub child_workspace_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeForkArchive {
    pub mode: Option<String>,
    pub transfer_id: Option<String>,
    pub direct_urls: Vec<String>,
    pub direct_token: Option<String>,
    pub download_url: Option<String>,
    pub local_transfer_id: Option<String>,
    pub receiver_transfer_id: Option<String>,
    pub size_bytes: Option<u64>,
    pub requires_workspace_restore: bool,
    pub requires_session_restore: bool,
}

impl RuntimeForkArchive {
    pub fn from_value(value: &Value) -> ForkTransferResult<Self> {
        let object = value.as_object().ok_or(ForkTransferError::InvalidField {
            code: "invalid_archive",
            field: "archive",
            expected: "an object",
        })?;
        Ok(Self {
            mode: string_member(object, "mode"),
            transfer_id: string_member(object, "transferId")
                .or_else(|| string_member(object, "transfer_id")),
            direct_urls: string_list_member(
                object
                    .get("directUrls")
                    .or_else(|| object.get("direct_urls")),
            )?,
            direct_token: string_member(object, "directToken")
                .or_else(|| string_member(object, "direct_token")),
            download_url: string_member(object, "downloadUrl")
                .or_else(|| string_member(object, "download_url")),
            local_transfer_id: string_member(object, "localTransferId")
                .or_else(|| string_member(object, "local_transfer_id")),
            receiver_transfer_id: string_member(object, "receiverTransferId")
                .or_else(|| string_member(object, "receiver_transfer_id")),
            size_bytes: u64_member(object, "sizeBytes")
                .or_else(|| u64_member(object, "size_bytes")),
            requires_workspace_restore: bool_member(object, "requiresWorkspaceRestore")
                .or_else(|| bool_member(object, "requires_workspace_restore"))
                .unwrap_or(false),
            requires_session_restore: bool_member(object, "requiresSessionRestore")
                .or_else(|| bool_member(object, "requires_session_restore"))
                .unwrap_or(false),
        })
    }

    pub fn requires_restore(&self) -> bool {
        if self.mode.as_deref() != Some("git_workspace") {
            return true;
        }
        if self.requires_session_restore {
            return true;
        }
        self.local_transfer_id.is_some()
            || self.receiver_transfer_id.is_some()
            || self.download_url.is_some()
            || !self.direct_urls.is_empty()
    }

    pub fn with_local_transfer_id(&self, transfer_id: &str) -> ForkTransferResult<Self> {
        let transfer_id = transfer_id.trim();
        if transfer_id.is_empty() {
            return Err(ForkTransferError::MissingField {
                code: "missing_transfer_id",
                field: "localTransferId",
            });
        }
        if let Some(existing) = self.local_transfer_id.as_deref() {
            if existing == transfer_id {
                return Ok(self.clone());
            }
            return Err(ForkTransferError::ConflictingTransfer);
        }
        let mut archive = self.clone();
        archive.local_transfer_id = Some(transfer_id.to_owned());
        Ok(archive)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrepareForkTransferPayload {
    pub transfer_id: String,
    pub upload_url: Option<String>,
    pub workspace_transfer: Option<String>,
    pub direct_hosts: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportForkPayload {
    pub source: SourceTaskIdentity,
    pub workspace_path: String,
    pub fork_package: Value,
    pub archive: RuntimeForkArchive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexThreadState {
    pub thread_id: String,
    pub rollout_relative_path: Option<String>,
    pub thread: Value,
    pub thread_dynamic_tools: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexStateRestorePlan {
    pub thread_id: String,
    pub thread: Value,
    pub thread_dynamic_tools: Vec<Value>,
}

impl CodexThreadState {
    pub fn from_value(value: &Value) -> ForkTransferResult<Self> {
        let object = value.as_object().ok_or(ForkTransferError::InvalidField {
            code: "invalid_codex_state",
            field: "codexState",
            expected: "an object",
        })?;
        let thread_value = object
            .get("thread")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let thread_id = string_member(object, "threadId")
            .or_else(|| string_member(object, "thread_id"))
            .or_else(|| string_field(&thread_value, "id"))
            .ok_or(ForkTransferError::MissingField {
                code: "missing_thread_id",
                field: "threadId",
            })?;
        let thread_dynamic_tools = object
            .get("threadDynamicTools")
            .or_else(|| object.get("thread_dynamic_tools"))
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter(|row| row.is_object())
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        Ok(Self {
            thread_id,
            rollout_relative_path: string_member(object, "rolloutRelativePath")
                .or_else(|| string_member(object, "rollout_relative_path")),
            thread: thread_value,
            thread_dynamic_tools,
        })
    }

    pub fn restore_plan(&self, workspace_path: &Path, home_path: &Path) -> CodexStateRestorePlan {
        let mut thread = object_value(self.thread.clone());
        thread.insert("id".to_owned(), Value::String(self.thread_id.clone()));
        thread.insert(
            "cwd".to_owned(),
            Value::String(workspace_path.to_string_lossy().into_owned()),
        );
        if let Some(rollout_relative_path) = self.rollout_relative_path.as_deref() {
            thread.insert(
                "rollout_path".to_owned(),
                Value::String(
                    home_path
                        .join(rollout_relative_path)
                        .to_string_lossy()
                        .into_owned(),
                ),
            );
        }

        let thread_dynamic_tools = self
            .thread_dynamic_tools
            .iter()
            .filter_map(|row| {
                let mut row = row.as_object()?.clone();
                row.insert(
                    "thread_id".to_owned(),
                    Value::String(self.thread_id.clone()),
                );
                Some(Value::Object(row))
            })
            .collect();

        CodexStateRestorePlan {
            thread_id: self.thread_id.clone(),
            thread: Value::Object(thread),
            thread_dynamic_tools,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveUploadPlan {
    pub headers: BTreeMap<String, String>,
    pub chunk_sizes: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrepareArchiveTransferRequest {
    pub workspace_path: String,
    pub transfer_id: String,
    pub session_paths: Vec<String>,
    pub direct_hosts: Option<Vec<String>>,
    pub include_workspace: bool,
    pub codex_thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveCreateRequest {
    pub workspace_path: String,
    pub session_paths: Vec<String>,
    pub include_workspace: bool,
    pub codex_thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedArchive {
    pub archive_path: PathBuf,
    pub direct_urls: Vec<String>,
    pub direct_token: String,
    pub size_bytes: u64,
}

pub fn direct_transfer_bind_host(configured: Option<&str>) -> String {
    configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| DIRECT_TRANSFER_BIND_HOST.to_owned())
}

pub fn candidate_hosts(
    bind_host: &str,
    direct_hosts: Option<&[String]>,
    configured_host: Option<&str>,
    discovered_host: Option<&str>,
) -> Vec<String> {
    if let Some(direct_hosts) = direct_hosts {
        return dedupe_strings(direct_hosts.iter().map(String::as_str));
    }

    let bind_host = bind_host.trim();
    if is_loopback_host(bind_host) {
        return dedupe_strings([bind_host]);
    }

    let mut hosts = Vec::new();
    if let Some(configured_host) = configured_host
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        hosts.push(configured_host.to_owned());
    }
    if !matches!(bind_host, "" | "0.0.0.0" | "::") {
        hosts.push(bind_host.to_owned());
    }
    if let Some(discovered_host) = discovered_host
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.starts_with("127."))
    {
        hosts.push(discovered_host.to_owned());
    }
    hosts.push("127.0.0.1".to_owned());
    dedupe_strings(hosts.iter().map(String::as_str))
}

pub fn direct_archive_urls(
    transfer_id: &str,
    bind_host: &str,
    port: u16,
    direct_hosts: Option<&[String]>,
    configured_host: Option<&str>,
    discovered_host: Option<&str>,
) -> Vec<String> {
    candidate_hosts(bind_host, direct_hosts, configured_host, discovered_host)
        .into_iter()
        .map(|host| {
            format!(
                "http://{}:{}{}{}",
                format_url_host(&host),
                port,
                TRANSFER_PATH_PREFIX,
                transfer_id
            )
        })
        .collect()
}

pub fn transfer_proof(transfer_id: &str, token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{transfer_id}:{token}").as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn parse_archive_metadata(value: &Value) -> ForkTransferResult<ArchiveMetadata> {
    let object = value.as_object().ok_or(ForkTransferError::InvalidField {
        code: "invalid_archive_metadata",
        field: "metadata",
        expected: "an object",
    })?;
    match string_member(object, "type").as_deref() {
        Some("git_patch") => {
            let base_commit = string_member(object, "baseCommit")
                .or_else(|| string_member(object, "base_commit"))
                .ok_or(ForkTransferError::MissingBaseCommit)?;
            Ok(ArchiveMetadata::GitPatch(GitPatchArchiveMetadata {
                base_commit,
                base_ref: string_member(object, "baseRef")
                    .or_else(|| string_member(object, "base_ref")),
                source_head: string_member(object, "sourceHead")
                    .or_else(|| string_member(object, "source_head")),
                source_branch: string_member(object, "sourceBranch")
                    .or_else(|| string_member(object, "source_branch")),
                remote_url: string_member(object, "remoteUrl")
                    .or_else(|| string_member(object, "remote_url")),
                workspace_pathspec: string_member(object, "workspacePathspec")
                    .or_else(|| string_member(object, "workspace_pathspec")),
            }))
        }
        Some("session_only") => Ok(ArchiveMetadata::SessionOnly),
        Some(other) => Err(ForkTransferError::UnsupportedArchiveType(other.to_owned())),
        None => Err(ForkTransferError::MissingField {
            code: "missing_archive_type",
            field: "type",
        }),
    }
}

pub fn safe_untracked_member_path(name: &str) -> Option<PathBuf> {
    let relative_name = name.strip_prefix(&format!("{RUNTIME_FORK_UNTRACKED_PREFIX}/"))?;
    if relative_name.trim_matches('/').is_empty() || is_unsafe_archive_member(relative_name) {
        return None;
    }
    let relative_path = Path::new(relative_name);
    if has_excluded_part(relative_path) {
        return None;
    }
    Some(relative_path.to_path_buf())
}

pub fn home_relative_session_paths(home: &Path, session_paths: &[PathBuf]) -> Vec<String> {
    let Ok(home) = normalize_path(home) else {
        return Vec::new();
    };
    let mut relative_paths = Vec::new();
    for path in session_paths {
        let Ok(path) = normalize_path(path) else {
            continue;
        };
        let Ok(relative_path) = path.strip_prefix(&home) else {
            continue;
        };
        if has_excluded_part(relative_path) {
            continue;
        }
        relative_paths.push(relative_path.to_string_lossy().replace('\\', "/"));
    }
    dedupe_strings(relative_paths.iter().map(String::as_str))
}

pub fn inherited_sessions_from_fork_runtime(fork_runtime: &Value) -> Vec<InheritedSession> {
    let sessions = fork_runtime
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(normalize_inherited_session)
        .collect::<Vec<_>>();
    dedupe_sessions(sessions)
}

pub fn select_inherited_claude_session(
    sessions: &[InheritedSession],
    bot_id: Option<i64>,
    new_session: bool,
    has_existing_session: bool,
) -> Option<InheritedSession> {
    if new_session || has_existing_session {
        return None;
    }
    sessions
        .iter()
        .find(|session| {
            matches!(session.agent.as_str(), "ClaudeCode" | "Claude Code")
                && session
                    .session_id
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                && bot_matches(session.bot_id.as_ref(), bot_id)
        })
        .cloned()
}

pub fn select_inherited_codex_thread(
    sessions: &[InheritedSession],
    bot_id: Option<i64>,
    new_session: bool,
    has_existing_session: bool,
) -> Option<InheritedSession> {
    if new_session || has_existing_session {
        return None;
    }
    sessions
        .iter()
        .find(|session| {
            matches!(session.agent.as_str(), "CodeX" | "Codex")
                && session
                    .thread_id
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                && bot_matches(session.bot_id.as_ref(), bot_id)
        })
        .cloned()
}

pub fn build_imported_runtime_handle(fork_package: &Value) -> ForkTransferResult<Value> {
    let fork_package = fork_package
        .as_object()
        .ok_or(ForkTransferError::InvalidField {
            code: "invalid_fork_package",
            field: "forkPackage",
            expected: "an object",
        })?;
    let mut runtime_handle = fork_package
        .get("runtimeHandle")
        .or_else(|| fork_package.get("runtime_handle"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if let Some(executor_session) = fork_package
        .get("executorSession")
        .or_else(|| fork_package.get("executor_session"))
        .filter(|value| value.is_object())
        .cloned()
    {
        runtime_handle.insert("executorSession".to_owned(), executor_session.clone());
        let execution_request_key = if runtime_handle.contains_key("executionRequest") {
            Some("executionRequest")
        } else if runtime_handle.contains_key("execution_request") {
            Some("execution_request")
        } else {
            None
        };
        if let Some(execution_request) = execution_request_key
            .and_then(|key| runtime_handle.get_mut(key))
            .and_then(Value::as_object_mut)
        {
            append_unique_inherited_session(execution_request, executor_session);
            execution_request.insert("new_session".to_owned(), Value::Bool(false));
        }
    }

    if let Some(messages) = fork_package
        .get("recentMessages")
        .or_else(|| fork_package.get("recent_messages"))
        .and_then(Value::as_array)
    {
        runtime_handle.insert(
            "messages".to_owned(),
            Value::Array(
                messages
                    .iter()
                    .filter(|message| message.is_object())
                    .cloned()
                    .collect(),
            ),
        );
    }

    Ok(Value::Object(runtime_handle))
}

pub fn validate_prepare_transfer_payload(
    value: &Value,
) -> ForkTransferResult<PrepareForkTransferPayload> {
    let object = value.as_object().ok_or(ForkTransferError::InvalidField {
        code: "invalid_payload",
        field: "payload",
        expected: "an object",
    })?;
    let transfer_id = string_member(object, "transferId")
        .or_else(|| string_member(object, "transfer_id"))
        .ok_or(ForkTransferError::MissingField {
            code: "missing_transfer_id",
            field: "transferId",
        })?;
    let upload_url = optional_string_member(object, "uploadUrl", "uploadUrl")?.or_else(|| {
        optional_string_member(object, "upload_url", "uploadUrl")
            .ok()
            .flatten()
    });
    let workspace_transfer =
        optional_string_member(object, "workspaceTransfer", "workspaceTransfer")?.or_else(|| {
            optional_string_member(object, "workspace_transfer", "workspaceTransfer")
                .ok()
                .flatten()
        });
    let direct_hosts = match object
        .get("directHosts")
        .or_else(|| object.get("direct_hosts"))
    {
        None | Some(Value::Null) => None,
        Some(value) => Some(payload_string_list(value, "directHosts")?),
    };

    Ok(PrepareForkTransferPayload {
        transfer_id,
        upload_url,
        workspace_transfer,
        direct_hosts,
    })
}

pub fn validate_import_fork_payload(value: &Value) -> ForkTransferResult<ImportForkPayload> {
    let object = value.as_object().ok_or(ForkTransferError::InvalidField {
        code: "invalid_payload",
        field: "payload",
        expected: "an object",
    })?;
    let source_value = object
        .get("source")
        .ok_or(ForkTransferError::MissingField {
            code: "missing_source",
            field: "source",
        })?;
    let source = SourceTaskIdentity::from_value(source_value)?;
    let workspace_path = string_member(object, "workspacePath")
        .or_else(|| string_member(object, "workspace_path"))
        .ok_or(ForkTransferError::MissingField {
            code: "missing_workspace_path",
            field: "workspacePath",
        })?;
    let fork_package = object
        .get("forkPackage")
        .or_else(|| object.get("fork_package"))
        .filter(|value| value.is_object())
        .cloned()
        .ok_or(ForkTransferError::MissingField {
            code: "missing_fork_package",
            field: "forkPackage",
        })?;
    let archive_value = fork_package
        .get("archive")
        .ok_or(ForkTransferError::MissingField {
            code: "missing_archive",
            field: "forkPackage.archive",
        })?;
    let archive = RuntimeForkArchive::from_value(archive_value)?;

    Ok(ImportForkPayload {
        source,
        workspace_path,
        fork_package,
        archive,
    })
}

pub fn archive_upload_plan(size_bytes: u64, token: Option<&str>) -> ArchiveUploadPlan {
    let mut headers = BTreeMap::new();
    headers.insert("Content-Type".to_owned(), "application/gzip".to_owned());
    headers.insert("Content-Length".to_owned(), size_bytes.to_string());
    if let Some(token) = token.map(str::trim).filter(|value| !value.is_empty()) {
        headers.insert(TRANSFER_TOKEN_HEADER.to_owned(), token.to_owned());
    }

    let mut remaining = size_bytes;
    let mut chunk_sizes = Vec::new();
    while remaining > 0 {
        let chunk_size = remaining.min(ARCHIVE_IO_CHUNK_BYTES as u64);
        chunk_sizes.push(chunk_size as usize);
        remaining -= chunk_size;
    }

    ArchiveUploadPlan {
        headers,
        chunk_sizes,
    }
}

pub async fn prepare_archive_transfer_with<CreateArchive, RegisterDirectArchive>(
    request: PrepareArchiveTransferRequest,
    create_archive: CreateArchive,
    register_direct_archive: RegisterDirectArchive,
    direct_token: String,
) -> ForkTransferResult<PreparedArchive>
where
    CreateArchive: FnOnce(ArchiveCreateRequest) -> ForkTransferResult<PathBuf> + Send + 'static,
    RegisterDirectArchive: FnOnce(&str, &Path, &str, Option<&[String]>) -> Vec<String>,
{
    let transfer_id = request.transfer_id.clone();
    let direct_hosts = request.direct_hosts.clone();
    let create_request = ArchiveCreateRequest {
        workspace_path: request.workspace_path,
        session_paths: request.session_paths,
        include_workspace: request.include_workspace,
        codex_thread_id: request.codex_thread_id,
    };
    let archive_path = tokio::task::spawn_blocking(move || create_archive(create_request))
        .await
        .map_err(|error| ForkTransferError::Join(error.to_string()))??;
    let size_bytes = std::fs::metadata(&archive_path)?.len();
    let direct_urls = register_direct_archive(
        &transfer_id,
        &archive_path,
        &direct_token,
        direct_hosts.as_deref(),
    );

    Ok(PreparedArchive {
        archive_path,
        direct_urls,
        direct_token,
        size_bytes,
    })
}

impl SourceTaskIdentity {
    pub fn from_value(value: &Value) -> ForkTransferResult<Self> {
        let object = value.as_object().ok_or(ForkTransferError::InvalidField {
            code: "invalid_source",
            field: "source",
            expected: "an object",
        })?;
        let local_task_id =
            string_member(object, "taskId").ok_or(ForkTransferError::MissingField {
                code: "missing_task_id",
                field: "taskId",
            })?;
        let runtime_handle = object
            .get("runtimeHandle")
            .or_else(|| object.get("runtime_handle"));
        let thread_id = string_member(object, "threadId")
            .or_else(|| string_member(object, "thread_id"))
            .or_else(|| runtime_handle.and_then(|value| string_field(value, "threadId")));

        Ok(Self {
            device_id: string_member(object, "deviceId")
                .or_else(|| string_member(object, "device_id")),
            workspace_path: string_member(object, "workspacePath")
                .or_else(|| string_member(object, "workspace_path")),
            local_task_id,
            thread_id,
            runtime: string_member(object, "runtime"),
        })
    }
}

impl RuntimeThreadMapping {
    pub fn from_import_result(
        parent: SourceTaskIdentity,
        import_result: &Value,
    ) -> ForkTransferResult<Self> {
        let object = import_result
            .as_object()
            .ok_or(ForkTransferError::InvalidField {
                code: "invalid_import_result",
                field: "importResult",
                expected: "an object",
            })?;
        let child_local_task_id =
            string_member(object, "taskId").ok_or(ForkTransferError::MissingField {
                code: "missing_task_id",
                field: "taskId",
            })?;
        let child_workspace_path = string_member(object, "workspacePath")
            .or_else(|| string_member(object, "workspace_path"))
            .ok_or(ForkTransferError::MissingField {
                code: "missing_workspace_path",
                field: "workspacePath",
            })?;
        let child_thread_id =
            string_member(object, "threadId").or_else(|| string_member(object, "thread_id"));

        Ok(Self {
            parent,
            child_local_task_id,
            child_thread_id,
            child_workspace_path,
        })
    }
}

impl ForkedTaskMetadata {
    pub fn from_fork_spec(value: &Value) -> ForkTransferResult<Self> {
        let object = value.as_object().ok_or(ForkTransferError::InvalidField {
            code: "invalid_fork_metadata",
            field: "fork",
            expected: "an object",
        })?;
        let source_task_id = i64_member(object, "sourceTaskId")
            .or_else(|| i64_member(object, "source_task_id"))
            .ok_or(ForkTransferError::MissingField {
                code: "missing_source_task_id",
                field: "sourceTaskId",
            })?;
        Ok(Self {
            source_task_id,
            after_message_id: i64_member(object, "afterMessageId")
                .or_else(|| i64_member(object, "after_message_id"))
                .unwrap_or_default(),
            root_task_id: i64_member(object, "rootTaskId")
                .or_else(|| i64_member(object, "root_task_id"))
                .unwrap_or(source_task_id),
            target_device_id: string_member(object, "targetDeviceId")
                .or_else(|| string_member(object, "target_device_id")),
            runtime: object.get("runtime").cloned(),
        })
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Metadata-only declaration of user-facing files created in a Task workspace.

use reqwest::StatusCode;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

const COMMAND_PREFIX: &str = "artifact";
const RESULT_MARKER: &str = "[WEGENT_ARTIFACT]";
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(2)];

pub const AGENT_INSTRUCTIONS: &str = "When you create a user-facing deliverable file, declare it before the final response by running `$WEGENT_EXECUTOR_BINARY artifact declare --path <file>`. Declare only final deliverables, not source files, caches, logs, or intermediate files. The file remains in the Task workspace on the execution device. For local conversations the command validates the file and returns local_path without contacting Backend; include a Markdown file link to that local_path in the final response so the existing file card can open it. For Backend Tasks, declaration registers an artifact. The command sends metadata only and handles transient retries within the invocation. If it fails, report the file delivery failure in the final response. Do not start background retries or wait for publication. On success, mention the filename so the user can use its artifact card.";

pub fn is_artifact_command() -> bool {
    env::args().nth(1).as_deref() == Some(COMMAND_PREFIX)
}

pub async fn run() -> Result<(), String> {
    let args = env::args().skip(2).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("declare") => declare(&args[1..]).await,
        _ => Err(
            "usage: wegent-executor artifact declare --path <file> [--name <filename>] [--mime-type <type>]"
                .to_owned(),
        ),
    }
}

async fn declare(args: &[String]) -> Result<(), String> {
    let workspace = task_workspace(&required_env("WEGENT_TASK_ID")?)?;
    let path = required_path_option(args, "--path")?;
    let artifact = artifact_metadata(&workspace, &path)?;
    let name = option(args, "--name")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| artifact.name.clone());
    let mime_type = option(args, "--mime-type")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| infer_mime_type(&artifact.relative_path).to_owned());
    let payload = declaration_payload(&artifact, &name, &mime_type);
    let result = match env::var("WEGENT_BACKEND_TASK_ID") {
        Ok(task_id) => {
            let task_id = task_id.trim();
            if !task_id.parse::<i64>().is_ok_and(|id| id > 0) {
                return Err("WEGENT_BACKEND_TASK_ID must be a positive integer".to_owned());
            }
            declare_backend(task_id, &payload).await?
        }
        Err(env::VarError::NotPresent) => {
            let mut result = payload;
            result["local_path"] = json!(local_reference_path(
                &artifact.workspace_root,
                &artifact.relative_path,
            ));
            result
        }
        Err(error) => return Err(format!("read WEGENT_BACKEND_TASK_ID failed: {error}")),
    };
    println!(
        "{RESULT_MARKER}{}",
        serde_json::to_string(&result)
            .map_err(|error| format!("serialize artifact result failed: {error}"))?
    );
    Ok(())
}

fn local_reference_path(workspace_root: &str, relative_path: &str) -> String {
    let path = Path::new(workspace_root).join(relative_path);
    let readable = crate::path_compat::strip_windows_verbatim_prefix(&path);
    if cfg!(windows) || readable != path {
        readable.to_string_lossy().replace('\\', "/")
    } else {
        readable.to_string_lossy().into_owned()
    }
}

async fn declare_backend(task_id: &str, payload: &Value) -> Result<Value, String> {
    let backend = backend_url()?;
    let token = auth_token()?;
    let client = http_client()?;
    let url = format!("{backend}/api/tasks/{task_id}/remote-workspace/artifacts");
    let mut delays = RETRY_DELAYS.into_iter();
    let response = loop {
        let result = client
            .post(&url)
            .bearer_auth(&token)
            .json(payload)
            .send()
            .await;
        let retryable = match &result {
            Ok(response) => retryable_status(response.status()),
            Err(error) => error.is_timeout() || error.is_connect(),
        };
        if let (true, Some(delay)) = (retryable, delays.next()) {
            tokio::time::sleep(delay).await;
            continue;
        }
        break result.map_err(|error| format!("declare artifact failed: {error}"))?;
    };
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("read artifact declaration response failed: {error}"))?;
    ensure_success(status, &body)?;
    serde_json::from_str(&body)
        .map_err(|error| format!("invalid artifact declaration response: {error}"))
}

#[derive(Debug, PartialEq, Eq)]
struct ArtifactMetadata {
    workspace_root: String,
    relative_path: String,
    name: String,
    file_size: u64,
    modified_at: Option<u64>,
    sha256: String,
}

fn declaration_payload(artifact: &ArtifactMetadata, name: &str, mime_type: &str) -> Value {
    json!({
        "workspace_root": artifact.workspace_root,
        "relative_path": artifact.relative_path,
        "name": name,
        "file_size": artifact.file_size,
        "mime_type": mime_type,
        "modified_at": artifact.modified_at,
        "sha256": artifact.sha256,
    })
}

fn artifact_metadata(workspace: &Path, requested_path: &Path) -> Result<ArtifactMetadata, String> {
    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|error| format!("resolve Task workspace failed: {error}"))?;
    let candidate = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        canonical_workspace.join(requested_path)
    };
    let canonical_file = candidate
        .canonicalize()
        .map_err(|error| format!("resolve artifact file failed: {error}"))?;
    if !canonical_file.starts_with(&canonical_workspace) || canonical_file == canonical_workspace {
        return Err(format!(
            "artifact file must be inside Task workspace {}",
            canonical_workspace.display()
        ));
    }
    let metadata = canonical_file
        .metadata()
        .map_err(|error| format!("read artifact metadata failed: {error}"))?;
    if !metadata.is_file() {
        return Err("artifact path must identify a regular file".to_owned());
    }
    let relative_path = canonical_file
        .strip_prefix(&canonical_workspace)
        .map_err(|_| "artifact file is outside the Task workspace".to_owned())?
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let relative_path = relative_path.replace('\\', "/");
    let name = canonical_file
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "artifact filename is invalid".to_owned())?
        .to_owned();
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs());
    Ok(ArtifactMetadata {
        workspace_root: canonical_workspace.to_string_lossy().into_owned(),
        relative_path,
        name,
        file_size: metadata.len(),
        modified_at,
        sha256: sha256_file(&canonical_file)?,
    })
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("open artifact file failed: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("read artifact file failed: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn infer_mime_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "csv" => "text/csv",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "gif" => "image/gif",
        "html" | "htm" => "text/html",
        "jpeg" | "jpg" => "image/jpeg",
        "json" => "application/json",
        "md" | "txt" => "text/plain",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn required_path_option(args: &[String], name: &str) -> Result<PathBuf, String> {
    option(args, name)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{name} is required"))
}

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn task_workspace(task_id: &str) -> Result<PathBuf, String> {
    if let Ok(value) = env::var("WEGENT_TASK_WORKSPACE") {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    Ok(crate::workspace_paths::task_workspace_dir(task_id))
}

fn backend_url() -> Result<String, String> {
    [
        "WEGENT_RUNTIME_BACKEND_URL",
        "WEGENT_BACKEND_URL",
        "TASK_API_DOMAIN",
    ]
    .into_iter()
    .find_map(|key| {
        env::var(key)
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_owned())
            .filter(|value| !value.is_empty())
    })
    .ok_or_else(|| {
        "WEGENT_RUNTIME_BACKEND_URL, WEGENT_BACKEND_URL, or TASK_API_DOMAIN is required".to_owned()
    })
}

fn auth_token() -> Result<String, String> {
    required_env("AUTH_TOKEN")
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(HTTP_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("build artifact declaration HTTP client failed: {error}"))
}

fn retryable_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT
    )
}

fn ensure_success(status: StatusCode, body: &str) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    Err(format!(
        "declare artifact failed with HTTP {status}: {body}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn binding_conflicts_are_not_retried() {
        assert!(!retryable_status(StatusCode::CONFLICT));
        assert!(!retryable_status(StatusCode::FORBIDDEN));
        assert!(retryable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(retryable_status(StatusCode::GATEWAY_TIMEOUT));
    }

    #[test]
    fn local_references_use_markdown_safe_windows_drive_and_unc_paths() {
        assert_eq!(
            local_reference_path(r"\\?\C:\Users\test\.wegent\workspace", "local report.md"),
            "C:/Users/test/.wegent/workspace/local report.md",
        );
        assert_eq!(
            local_reference_path(r"\\?\UNC\server\share\workspace", "local report.md"),
            "//server/share/workspace/local report.md",
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_references_preserve_posix_backslashes() {
        assert_eq!(
            local_reference_path(r"/tmp/back\slash", "local report.md"),
            r"/tmp/back\slash/local report.md",
        );

        let workspace = tempdir().unwrap();
        let file = workspace.path().join(r"report\2026.md");
        fs::write(&file, b"original POSIX filename").unwrap();
        let metadata = artifact_metadata(workspace.path(), &file).unwrap();
        assert_eq!(metadata.relative_path, r"report\2026.md");
        let reference = local_reference_path(&metadata.workspace_root, &metadata.relative_path);
        assert_eq!(fs::read(reference).unwrap(), b"original POSIX filename");
    }

    #[test]
    fn metadata_keeps_file_inside_workspace_and_hashes_without_uploading() {
        let directory = tempdir().unwrap();
        let output = directory.path().join("outputs");
        fs::create_dir_all(&output).unwrap();
        let artifact = output.join("report.txt");
        fs::write(&artifact, b"device-only bytes").unwrap();

        let metadata = artifact_metadata(directory.path(), &artifact).unwrap();

        assert_eq!(metadata.relative_path, "outputs/report.txt");
        assert_eq!(metadata.name, "report.txt");
        assert_eq!(metadata.file_size, 17);
        assert_eq!(
            metadata.sha256,
            "747d9f4b8a03ff11d66a3289760a126899f3b46146526e73a5049f130360c8e6"
        );
    }

    #[test]
    fn metadata_rejects_files_outside_workspace() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let artifact = outside.path().join("secret.txt");
        fs::write(&artifact, b"secret").unwrap();

        let error = artifact_metadata(workspace.path(), &artifact).unwrap_err();

        assert!(error.contains("must be inside Task workspace"));
    }

    #[test]
    fn known_extensions_get_specific_mime_types() {
        assert_eq!(infer_mime_type("report.pdf"), "application/pdf");
        assert_eq!(
            infer_mime_type("archive.unknown"),
            "application/octet-stream"
        );
    }

    #[test]
    fn declaration_payload_contains_metadata_only() {
        let artifact = ArtifactMetadata {
            workspace_root: "/workspace/repository".to_owned(),
            relative_path: "outputs/report.pdf".to_owned(),
            name: "report.pdf".to_owned(),
            file_size: 4096,
            modified_at: Some(1_797_638_400),
            sha256: "a".repeat(64),
        };

        let payload = declaration_payload(&artifact, "report.pdf", "application/pdf");
        let mut keys = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();

        assert_eq!(
            keys,
            [
                "file_size",
                "mime_type",
                "modified_at",
                "name",
                "relative_path",
                "sha256",
                "workspace_root",
            ]
        );
        assert_eq!(payload["file_size"], 4096);
        assert!(payload.get("content").is_none());
        assert!(payload.get("binary_data").is_none());
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Plugin Creator result and publication commands for a Task workspace.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::StatusCode;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use zip::{write::FileOptions, CompressionMethod, ZipWriter};

const COMMAND_PREFIX: &str = "plugin-workspace";
const RESULT_MARKER: &str = "[WEGENT_PLUGIN_RESULT]";
const MAX_PACKAGE_BYTES: usize = 50 * 1024 * 1024;
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublishRoute {
    LegacySubmission,
    EnterprisePublication,
}

struct PublishArtifact<'a> {
    task_id: &'a str,
    listing_type: &'a str,
    slug: &'a str,
    display_name: &'a str,
    version: &'a str,
    filename: &'a str,
    digest: &'a str,
    package: &'a [u8],
}

#[derive(Debug)]
struct PublishOutcome {
    status: &'static str,
    plugin_id: Option<i64>,
    submission_id: Option<i64>,
}

pub fn is_plugin_workspace_command() -> bool {
    env::args().nth(1).as_deref() == Some(COMMAND_PREFIX)
}

pub async fn run() -> Result<(), String> {
    let args = env::args().skip(2).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("describe") => describe(&args[1..]),
        Some("publish") => publish(&args[1..]).await,
        _ => Err("usage: wegent-executor plugin-workspace <describe|publish> [options]".to_owned()),
    }
}

fn describe(args: &[String]) -> Result<(), String> {
    let plugin_root = required_path_option(args, "--plugin-root")?;
    let listing_type = listing_type_option(args)?;
    let task_id = required_env("WEGENT_TASK_ID")?;
    let workspace = task_workspace(&task_id)?;
    let package = validated_package(&plugin_root, &workspace)?;
    let result = plugin_result(
        &plugin_root,
        &workspace,
        &task_id,
        &listing_type,
        &package,
        "ready",
    )?;
    print_result(&result)
}

async fn publish(args: &[String]) -> Result<(), String> {
    let plugin_root = required_path_option(args, "--plugin-root")?;
    let listing_type = listing_type_option(args)?;
    let request = publish_request(args)?;
    let task_id = required_env("WEGENT_TASK_ID")?;
    let workspace = task_workspace(&task_id)?;
    let package = validated_package(&plugin_root, &workspace)?;
    let manifest = read_manifest(&plugin_root)?;
    let name = required_manifest_string(&manifest, "name")?;
    let version = required_manifest_string(&manifest, "version")?;
    let display_name = manifest
        .pointer("/interface/displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(name);
    let digest = format!("{:x}", Sha256::digest(&package));
    let filename = format!("{}.zip", plugin_directory_name(&plugin_root));
    let slug = name.to_ascii_lowercase();
    let route = publish_route(&request)?;
    let mut result = plugin_result(
        &plugin_root,
        &workspace,
        &task_id,
        &listing_type,
        &package,
        "pending_review",
    )?;

    let client = http_client()?;
    let backend = backend_url()?;
    let token = auth_token()?;
    let artifact = PublishArtifact {
        task_id: &task_id,
        listing_type: &listing_type,
        slug: &slug,
        display_name,
        version,
        filename: &filename,
        digest: &digest,
        package: &package,
    };
    let outcome = match route {
        PublishRoute::LegacySubmission => {
            publish_legacy_submission(&client, &backend, &token, &artifact, &request).await?
        }
        PublishRoute::EnterprisePublication => {
            publish_enterprise_publication(&client, &backend, &token, &artifact, &request).await?
        }
    };
    let object = result
        .as_object_mut()
        .ok_or_else(|| "plugin result must be an object".to_owned())?;
    object.insert("status".to_owned(), json!(outcome.status));
    if let Some(plugin_id) = outcome.plugin_id {
        object.insert("pluginId".to_owned(), json!(plugin_id));
    }
    if let Some(submission_id) = outcome.submission_id {
        object.insert("submissionId".to_owned(), json!(submission_id));
    }
    print_result(&result)
}

fn publish_route(request: &Value) -> Result<PublishRoute, String> {
    let intent = request.get("intent").and_then(Value::as_str);
    let visibility = request.get("visibility").and_then(Value::as_str);
    match (intent, visibility) {
        (Some("enterprise"), None | Some("workspace")) => Ok(PublishRoute::EnterprisePublication),
        (Some("enterprise"), Some(_)) => {
            Err("enterprise publish intent requires workspace visibility".to_owned())
        }
        (Some("restricted"), None | Some("personal")) => Ok(PublishRoute::LegacySubmission),
        (Some("restricted"), Some(_)) => {
            Err("restricted publish intent requires personal visibility".to_owned())
        }
        (Some(value), _) => Err(format!("unsupported publish intent: {value}")),
        (None, Some("workspace")) => Ok(PublishRoute::EnterprisePublication),
        (None, None | Some("personal")) => Ok(PublishRoute::LegacySubmission),
        (None, Some("public")) => Err(
            "public visibility is no longer supported; use enterprise/workspace publication"
                .to_owned(),
        ),
        (None, Some(value)) => Err(format!("unsupported publish visibility: {value}")),
    }
}

async fn publish_legacy_submission(
    client: &reqwest::Client,
    backend: &str,
    token: &str,
    artifact: &PublishArtifact<'_>,
    request: &Value,
) -> Result<PublishOutcome, String> {
    let targets = request
        .get("targets")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let allow_copy = request
        .get("allowCopy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let initialized = send_json(
        client
            .post(format!("{backend}/api/plugins/submissions/init"))
            .bearer_auth(token)
            .json(&json!({
                "slug": artifact.slug,
                "displayName": artifact.display_name,
                "version": artifact.version,
                "filename": artifact.filename,
                "sha256": artifact.digest,
                "sizeBytes": artifact.package.len(),
                "listingType": artifact.listing_type,
                "purpose": "restricted_share",
                "visibility": "personal",
                "targets": targets,
                "allowCopy": allow_copy,
            })),
        "initialize plugin submission",
    )
    .await?;
    let submission_id = initialized
        .get("submissionId")
        .and_then(Value::as_i64)
        .ok_or_else(|| "plugin submission response is missing submissionId".to_owned())?;
    let upload_url = initialized
        .get("uploadUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "plugin submission response is missing uploadUrl".to_owned())?;

    if let Err(error) = upload_package(client, upload_url, artifact.package).await {
        cancel_submission(client, backend, token, submission_id).await;
        return Err(error);
    }
    let completed = match send_json(
        client
            .post(format!(
                "{backend}/api/plugins/submissions/{submission_id}/complete"
            ))
            .bearer_auth(token),
        "complete plugin submission",
    )
    .await
    {
        Ok(completed) => completed,
        Err(error) => {
            cancel_submission(client, backend, token, submission_id).await;
            return Err(error);
        }
    };
    let submission = completed
        .get("submission")
        .and_then(Value::as_object)
        .ok_or_else(|| "plugin submission completion is missing submission".to_owned())?;
    let submission_status = submission
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let result_status = if submission_status == "approved" {
        "published"
    } else {
        "pending_review"
    };
    Ok(PublishOutcome {
        status: result_status,
        plugin_id: submission.get("pluginId").and_then(Value::as_i64),
        submission_id: Some(submission_id),
    })
}

async fn publish_enterprise_publication(
    client: &reqwest::Client,
    backend: &str,
    token: &str,
    artifact: &PublishArtifact<'_>,
    request: &Value,
) -> Result<PublishOutcome, String> {
    let attempt_id = required_request_string(request, "operationAttemptId")?;
    let payload = enterprise_publication_payload(artifact, request)?;
    let initialize_key = publication_idempotency_key(
        "create",
        attempt_id,
        artifact.task_id,
        artifact.digest,
        &payload,
    )?;
    let initialized = send_json(
        client
            .post(format!("{backend}/api/plugins/publication-requests"))
            .bearer_auth(token)
            .header("Idempotency-Key", initialize_key)
            .json(&payload),
        "initialize enterprise plugin publication",
    )
    .await?;
    let request_id = initialized
        .get("requestId")
        .and_then(Value::as_i64)
        .ok_or_else(|| "plugin publication response is missing requestId".to_owned())?;
    let revision = initialized
        .pointer("/revision/number")
        .and_then(Value::as_i64)
        .ok_or_else(|| "plugin publication response is missing revision number".to_owned())?;
    let upload_url = initialized
        .get("uploadUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "plugin publication response is missing uploadUrl".to_owned())?;

    if let Err(error) = upload_package(client, upload_url, artifact.package).await {
        withdraw_enterprise_publication(
            client, backend, token, artifact, attempt_id, request_id, revision,
        )
        .await;
        return Err(error);
    }
    let completion_identity = json!({"requestId": request_id, "revision": revision});
    let complete_key = publication_idempotency_key(
        "complete",
        attempt_id,
        artifact.task_id,
        artifact.digest,
        &completion_identity,
    )?;
    let completed = match send_json(
        client
            .post(format!(
                "{backend}/api/plugins/publication-requests/{request_id}/revisions/{revision}/complete"
            ))
            .bearer_auth(token)
            .header("Idempotency-Key", complete_key),
        "complete enterprise plugin publication",
    )
    .await
    {
        Ok(completed) => completed,
        Err(error) => {
            withdraw_enterprise_publication(
                client,
                backend,
                token,
                artifact,
                attempt_id,
                request_id,
                revision,
            )
            .await;
            return Err(error);
        }
    };
    match enterprise_publication_outcome(&initialized, &completed, request_id) {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            withdraw_enterprise_publication(
                client, backend, token, artifact, attempt_id, request_id, revision,
            )
            .await;
            Err(error)
        }
    }
}

fn enterprise_publication_outcome(
    initialized: &Value,
    completed: &Value,
    request_id: i64,
) -> Result<PublishOutcome, String> {
    let completed_request_id = completed
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "plugin publication completion is missing id".to_owned())?;
    if completed_request_id != request_id {
        return Err("plugin publication completion returned a different request id".to_owned());
    }
    let status = if completed.get("status").and_then(Value::as_str) == Some("published") {
        "published"
    } else {
        "pending_review"
    };
    let plugin_id = completed
        .get("pluginId")
        .and_then(Value::as_i64)
        .or_else(|| initialized.get("sourcePluginId").and_then(Value::as_i64));
    Ok(PublishOutcome {
        status,
        plugin_id,
        submission_id: None,
    })
}

async fn withdraw_enterprise_publication(
    client: &reqwest::Client,
    backend: &str,
    token: &str,
    artifact: &PublishArtifact<'_>,
    attempt_id: &str,
    request_id: i64,
    revision: i64,
) {
    let identity = json!({"requestId": request_id, "revision": revision});
    let Ok(idempotency_key) = publication_idempotency_key(
        "withdraw",
        attempt_id,
        artifact.task_id,
        artifact.digest,
        &identity,
    ) else {
        return;
    };
    let _ = client
        .post(format!(
            "{backend}/api/plugins/publication-requests/{request_id}/withdraw"
        ))
        .bearer_auth(token)
        .header("Idempotency-Key", idempotency_key)
        .send()
        .await;
}

fn enterprise_publication_payload(
    artifact: &PublishArtifact<'_>,
    request: &Value,
) -> Result<Value, String> {
    let release_notes = required_request_string(request, "releaseNotes")?;
    let test_notes = required_request_string(request, "testNotes")?;
    let risk_declaration = request
        .get("riskDeclaration")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !risk_declaration.is_object() {
        return Err("publish request riskDeclaration must be a JSON object".to_owned());
    }
    let mut payload = json!({
        "slug": artifact.slug,
        "displayName": artifact.display_name,
        "requestedVersion": artifact.version,
        "filename": artifact.filename,
        "snapshotSha256": artifact.digest,
        "sizeBytes": artifact.package.len(),
        "listingType": artifact.listing_type,
        "releaseNotes": release_notes,
        "testNotes": test_notes,
        "riskDeclaration": risk_declaration,
    });
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "plugin publication payload must be an object".to_owned())?;
    for field in ["sourcePluginId", "sourceReleaseId", "sourceUpdatedAt"] {
        if let Some(value) = request.get(field) {
            object.insert(field.to_owned(), value.clone());
        }
    }
    Ok(payload)
}

fn required_request_string<'a>(request: &'a Value, field: &str) -> Result<&'a str, String> {
    request
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("enterprise publish request requires {field}"))
}

fn publication_idempotency_key(
    operation: &str,
    attempt_id: &str,
    task_id: &str,
    snapshot_sha256: &str,
    payload: &Value,
) -> Result<String, String> {
    let canonical_payload = canonical_json(payload);
    let payload_bytes = serde_json::to_vec(&canonical_payload)
        .map_err(|error| format!("serialize publication idempotency payload failed: {error}"))?;
    let mut hasher = Sha256::new();
    for component in [
        b"plugin-workspace-publication-v1".as_slice(),
        operation.as_bytes(),
        attempt_id.as_bytes(),
        task_id.as_bytes(),
        snapshot_sha256.as_bytes(),
        payload_bytes.as_slice(),
    ] {
        hasher.update((component.len() as u64).to_be_bytes());
        hasher.update(component);
    }
    Ok(format!(
        "plugin-workspace-{operation}-{:x}",
        hasher.finalize()
    ))
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_json).collect()),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let mut normalized = Map::new();
            for key in keys {
                normalized.insert(key.clone(), canonical_json(&values[key]));
            }
            Value::Object(normalized)
        }
        _ => value.clone(),
    }
}

async fn upload_package(
    client: &reqwest::Client,
    upload_url: &str,
    package: &[u8],
) -> Result<(), String> {
    let response = client
        .put(upload_url)
        .header("Content-Type", "application/zip")
        .body(package.to_vec())
        .send()
        .await
        .map_err(|error| format!("upload plugin package failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    ensure_success(status, body, "upload plugin package")
}

async fn cancel_submission(
    client: &reqwest::Client,
    backend: &str,
    token: &str,
    submission_id: i64,
) {
    let _ = client
        .post(format!(
            "{backend}/api/plugins/submissions/{submission_id}/cancel"
        ))
        .bearer_auth(token)
        .send()
        .await;
}

fn publish_request(args: &[String]) -> Result<Value, String> {
    let encoded = required_option(args, "--request-base64")?;
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| format!("decode publish request failed: {error}"))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse publish request failed: {error}"))?;
    if !value.is_object() {
        return Err("publish request must be a JSON object".to_owned());
    }
    Ok(value)
}

fn validated_package(plugin_root: &Path, workspace: &Path) -> Result<Vec<u8>, String> {
    ensure_workspace_plugin(plugin_root, workspace)?;
    read_manifest(plugin_root)?;
    package_plugin(plugin_root)
}

fn ensure_workspace_plugin(plugin_root: &Path, workspace: &Path) -> Result<(), String> {
    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|error| format!("resolve Task workspace failed: {error}"))?;
    let canonical_plugin = plugin_root
        .canonicalize()
        .map_err(|error| format!("resolve plugin root failed: {error}"))?;
    if canonical_plugin == canonical_workspace
        || !canonical_plugin.starts_with(&canonical_workspace)
    {
        return Err(format!(
            "plugin root must be inside Task workspace {}",
            canonical_workspace.display()
        ));
    }
    Ok(())
}

fn plugin_result(
    plugin_root: &Path,
    workspace: &Path,
    task_id: &str,
    listing_type: &str,
    package: &[u8],
    status: &str,
) -> Result<Value, String> {
    let manifest = read_manifest(plugin_root)?;
    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|error| format!("resolve Task workspace failed: {error}"))?;
    let canonical_plugin = plugin_root
        .canonicalize()
        .map_err(|error| format!("resolve plugin root failed: {error}"))?;
    let relative_path = canonical_plugin
        .strip_prefix(&canonical_workspace)
        .map_err(|_| "plugin root is outside the Task workspace".to_owned())?
        .to_string_lossy()
        .replace('\\', "/");
    let name = required_manifest_string(&manifest, "name")?;
    let version = required_manifest_string(&manifest, "version")?;
    let interface = manifest
        .get("interface")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    let display_name = interface
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(name);
    let description = manifest
        .get("description")
        .and_then(Value::as_str)
        .or_else(|| interface.get("shortDescription").and_then(Value::as_str))
        .unwrap_or("");
    let logo = interface.get("logo").and_then(Value::as_str).unwrap_or("");
    Ok(json!({
        "schemaVersion": 1,
        "taskId": task_id,
        "relativePath": relative_path,
        "name": name,
        "displayName": display_name,
        "description": description,
        "version": version,
        "listingType": listing_type,
        "logo": logo,
        "sha256": format!("{:x}", Sha256::digest(package)),
        "status": status,
    }))
}

fn print_result(result: &Value) -> Result<(), String> {
    println!(
        "{RESULT_MARKER}{}",
        serde_json::to_string(result)
            .map_err(|error| format!("serialize plugin result failed: {error}"))?
    );
    Ok(())
}

async fn send_json(request: reqwest::RequestBuilder, action: &str) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|error| format!("{action} failed: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("read {action} response failed: {error}"))?;
    ensure_success(status, body.clone(), action)?;
    serde_json::from_str(&body).map_err(|error| format!("invalid {action} response: {error}"))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(HTTP_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("build plugin publication HTTP client failed: {error}"))
}

fn ensure_success(status: StatusCode, body: String, action: &str) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    Err(format!("{action} failed with HTTP {status}: {body}"))
}

fn package_plugin(root: &Path) -> Result<Vec<u8>, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("resolve plugin root failed: {error}"))?;
    let mut files = Vec::new();
    collect_files(&canonical_root, &canonical_root, &mut files)?;
    files.sort();
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut archive = ZipWriter::new(&mut cursor);
        let options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644)
            .last_modified_time(zip::DateTime::default());
        let mut total = 0_usize;
        for path in files {
            let relative = path
                .strip_prefix(&canonical_root)
                .map_err(|error| format!("resolve plugin package path failed: {error}"))?
                .to_string_lossy()
                .replace('\\', "/");
            let data = fs::read(&path)
                .map_err(|error| format!("read plugin file {relative} failed: {error}"))?;
            total = total
                .checked_add(data.len())
                .ok_or_else(|| "plugin package size overflow".to_owned())?;
            if total > MAX_PACKAGE_BYTES {
                return Err("plugin source exceeds 50 MiB".to_owned());
            }
            archive
                .start_file(relative, options)
                .map_err(|error| format!("start plugin ZIP entry failed: {error}"))?;
            archive
                .write_all(&data)
                .map_err(|error| format!("write plugin ZIP entry failed: {error}"))?;
        }
        archive
            .finish()
            .map_err(|error| format!("finalize plugin ZIP failed: {error}"))?;
    }
    let package = cursor.into_inner();
    if package.len() > MAX_PACKAGE_BYTES {
        return Err("plugin package exceeds 50 MiB".to_owned());
    }
    Ok(package)
}

fn collect_files(root: &Path, current: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in
        fs::read_dir(current).map_err(|error| format!("read plugin directory failed: {error}"))?
    {
        let entry = entry.map_err(|error| format!("read plugin entry failed: {error}"))?;
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path);
        if relative.components().any(|part| part.as_os_str() == ".git") {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("inspect plugin entry failed: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "plugin package cannot contain symlinks: {}",
                relative.display()
            ));
        }
        if metadata.is_dir() {
            collect_files(root, &path, files)?;
        } else if metadata.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn read_manifest(root: &Path) -> Result<Value, String> {
    let path = root.join(".codex-plugin/plugin.json");
    let manifest: Value = serde_json::from_slice(
        &fs::read(&path).map_err(|error| format!("read {} failed: {error}", path.display()))?,
    )
    .map_err(|error| format!("parse {} failed: {error}", path.display()))?;
    required_manifest_string(&manifest, "name")?;
    required_manifest_string(&manifest, "version")?;
    Ok(manifest)
}

fn required_manifest_string<'a>(manifest: &'a Value, field: &str) -> Result<&'a str, String> {
    manifest
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("plugin manifest must include {field}"))
}

fn plugin_directory_name(root: &Path) -> String {
    root.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("plugin")
        .to_owned()
}

fn listing_type_option(args: &[String]) -> Result<String, String> {
    let value = option(args, "--listing-type").unwrap_or_else(|| "plugin".to_owned());
    if !matches!(value.as_str(), "plugin" | "skill") {
        return Err("--listing-type must be plugin or skill".to_owned());
    }
    Ok(value)
}

fn option(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .map(ToOwned::to_owned)
}

fn required_option(args: &[String], name: &str) -> Result<String, String> {
    option(args, name).ok_or_else(|| format!("{name} is required"))
}

fn required_path_option(args: &[String], name: &str) -> Result<PathBuf, String> {
    required_option(args, name).map(PathBuf::from)
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
        let normalized = value.trim();
        if !normalized.is_empty() {
            return Ok(PathBuf::from(normalized));
        }
    }
    let root = env::var("WORKSPACE_ROOT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/workspace".to_owned());
    Ok(PathBuf::from(root).join(task_id))
}

fn backend_url() -> Result<String, String> {
    env::var("WEGENT_BACKEND_URL")
        .or_else(|_| env::var("TASK_API_DOMAIN"))
        .map(|value| value.trim_end_matches('/').to_owned())
        .map_err(|_| "WEGENT_BACKEND_URL or TASK_API_DOMAIN is required".to_owned())
}

fn auth_token() -> Result<String, String> {
    env::var("WEGENT_RUNTIME_AUTH_TOKEN")
        .or_else(|_| env::var("AUTH_TOKEN"))
        .map_err(|_| "WEGENT_RUNTIME_AUTH_TOKEN or AUTH_TOKEN is required".to_owned())
}

#[cfg(test)]
#[path = "plugin_workspace_publication_tests.rs"]
mod publication_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_plugin(workspace: &Path) -> PathBuf {
        let plugin = workspace.join("plugins/example");
        fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
        fs::create_dir_all(plugin.join("skills/example")).unwrap();
        fs::write(
            plugin.join(".codex-plugin/plugin.json"),
            r#"{"name":"example","version":"0.1.0","interface":{"displayName":"Example"}}"#,
        )
        .unwrap();
        fs::write(plugin.join("skills/example/SKILL.md"), "# Example").unwrap();
        plugin
    }

    #[test]
    fn result_references_source_inside_task_workspace() {
        let workspace = tempdir().unwrap();
        let plugin = create_plugin(workspace.path());
        let package = validated_package(&plugin, workspace.path()).unwrap();
        let result =
            plugin_result(&plugin, workspace.path(), "123", "skill", &package, "ready").unwrap();

        assert_eq!(result["relativePath"], "plugins/example");
        assert_eq!(result["displayName"], "Example");
        assert_eq!(result["listingType"], "skill");
        assert_eq!(result["sha256"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn package_rejects_plugin_outside_task_workspace() {
        let workspace = tempdir().unwrap();
        let other = tempdir().unwrap();
        let plugin = create_plugin(other.path());

        assert!(validated_package(&plugin, workspace.path())
            .unwrap_err()
            .contains("inside Task workspace"));
    }

    #[cfg(unix)]
    #[test]
    fn package_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let workspace = tempdir().unwrap();
        let plugin = create_plugin(workspace.path());
        symlink(".codex-plugin/plugin.json", plugin.join("manifest-link")).unwrap();

        assert!(package_plugin(&plugin).unwrap_err().contains("symlinks"));
    }

    #[test]
    fn publish_request_decodes_json() {
        let encoded = BASE64.encode(r#"{"visibility":"personal","targets":[]}"#);
        let request = publish_request(&["--request-base64".to_owned(), encoded]).unwrap();

        assert_eq!(request["visibility"], "personal");
    }

    #[test]
    fn enterprise_and_workspace_requests_use_publication_workflow() {
        assert_eq!(
            publish_route(&json!({"intent": "enterprise", "visibility": "workspace"})).unwrap(),
            PublishRoute::EnterprisePublication
        );
        assert_eq!(
            publish_route(&json!({"visibility": "workspace"})).unwrap(),
            PublishRoute::EnterprisePublication
        );
        assert_eq!(
            publish_route(&json!({"intent": "restricted", "visibility": "personal"})).unwrap(),
            PublishRoute::LegacySubmission
        );
        assert_eq!(
            publish_route(&json!({"visibility": "personal"})).unwrap(),
            PublishRoute::LegacySubmission
        );
        assert!(publish_route(&json!({"visibility": "public"}))
            .unwrap_err()
            .contains("no longer supported"));
    }

    #[test]
    fn publication_http_client_has_valid_configuration() {
        assert!(http_client().is_ok());
    }
}

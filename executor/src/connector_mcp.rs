// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Stdio MCP proxy for Wegent cloud connector applications.

use std::{
    env, fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use zip::{write::FileOptions, CompressionMethod, ZipWriter};

use crate::connector_gateway::load_connector_gateway_config;

const WEGENT_SITES_SAVE_SOURCE_REVISION: &str = "wegent-sites__save_source_revision";
const MAX_SOURCE_ARCHIVE_BYTES: usize = 100 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_SOURCE_FILES: usize = 20_000;
const SOURCE_EXCLUDES: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "__pycache__",
    ".pytest_cache",
    ".DS_Store",
];

pub fn is_connector_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("connector-mcp-server")
}

pub async fn run() -> Result<(), String> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle_request(&request).await,
            Err(error) => Some(error_response(Value::Null, -32700, error.to_string())),
        };
        if let Some(response) = response {
            let mut encoded = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
            encoded.push(b'\n');
            stdout
                .write_all(&encoded)
                .await
                .map_err(|error| error.to_string())?;
            stdout.flush().await.map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

async fn handle_request(request: &Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match method {
        "notifications/initialized" => None,
        "initialize" => id.map(|id| {
            result_response(
                id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": {
                        "name": "wegent_apps",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }),
        "ping" => id.map(|id| result_response(id, json!({}))),
        "tools/list" => {
            let id = id?;
            Some(
                match connector_gateway_request(reqwest::Method::GET, "tools", None).await {
                    Ok(value) => result_response(id, json!({ "tools": mcp_tools(&value) })),
                    Err(error) => error_response(id, -32001, error),
                },
            )
        }
        "tools/call" => {
            let id = id?;
            let Some(name) = request.pointer("/params/name").and_then(Value::as_str) else {
                return Some(error_response(
                    id,
                    -32602,
                    "tools/call requires params.name",
                ));
            };
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let arguments = match normalize_tool_arguments(name, arguments) {
                Ok(arguments) => arguments,
                Err(error) => return Some(result_response(id, text_result(error, true))),
            };
            Some(
                match connector_gateway_request(
                    reqwest::Method::POST,
                    "call",
                    Some(json!({ "name": name, "arguments": arguments })),
                )
                .await
                {
                    Ok(value) => result_response(id, tool_result(&value)),
                    Err(error) => result_response(id, text_result(error, true)),
                },
            )
        }
        _ => id.map(|id| error_response(id, -32601, format!("Unknown method: {method}"))),
    }
}

fn mcp_tools(value: &Value) -> Vec<Value> {
    value
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            Some(json!({
                "name": tool.get("name")?.as_str()?,
                "title": tool.get("title").cloned().unwrap_or(Value::Null),
                "description": tool.get("description").cloned().unwrap_or_else(|| json!("")),
                "inputSchema": mcp_tool_input_schema(tool),
                "annotations": tool.get("annotations").cloned().unwrap_or(Value::Null),
                "_meta": {
                    "connectorId": tool.get("connector_id").cloned().unwrap_or(Value::Null),
                    "connectorName": tool.get("connector_name").cloned().unwrap_or(Value::Null),
                    "rawToolName": tool.get("raw_tool_name").cloned().unwrap_or(Value::Null),
                    "sourceTransport": tool.get("source_transport").cloned().unwrap_or(Value::Null),
                    "riskHints": tool.get("risk_hints").cloned().unwrap_or_else(|| json!({}))
                }
            }))
        })
        .collect()
}

fn mcp_tool_input_schema(tool: &Value) -> Value {
    if tool
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| name == WEGENT_SITES_SAVE_SOURCE_REVISION)
    {
        return json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "project_id": {
                    "type": "string",
                    "pattern": "^prj_[0-9A-HJKMNP-TV-Z]{26}$"
                },
                "idempotency_key": {
                    "type": "string",
                    "minLength": 8,
                    "maxLength": 128
                },
                "source_directory": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Absolute path to the exact locally validated source directory."
                },
                "source_sha256": {
                    "type": "string",
                    "pattern": "^sha256:[a-f0-9]{64}$"
                }
            },
            "required": [
                "project_id",
                "idempotency_key",
                "source_directory",
                "source_sha256"
            ]
        });
    }
    tool.get("input_schema").cloned().unwrap_or_else(|| {
        json!({
            "type": "object", "properties": {}
        })
    })
}

fn normalize_tool_arguments(name: &str, arguments: Value) -> Result<Value, String> {
    if name != WEGENT_SITES_SAVE_SOURCE_REVISION {
        return Ok(arguments);
    }
    let Some(source_directory) = arguments
        .get("source_directory")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(arguments);
    };
    prepare_wegent_sites_source_revision(arguments, &source_directory)
}

fn prepare_wegent_sites_source_revision(
    mut arguments: Value,
    source_directory: &str,
) -> Result<Value, String> {
    let root = PathBuf::from(source_directory);
    if !root.is_absolute() {
        return Err("source_directory must be an absolute path.".to_owned());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "source_directory does not exist or is not a directory.".to_owned())?;
    if !root.is_dir() {
        return Err("source_directory does not exist or is not a directory.".to_owned());
    }

    let project_id = string_argument(&arguments, "project_id")?;
    let source_sha256 = string_argument(&arguments, "source_sha256")?;
    let contract = read_json_file(
        &root.join(".wegent").join("hosting.json"),
        "Hosting Contract",
    )?;
    let manifest = read_json_file(
        &root.join(".wegent").join("build-manifest.json"),
        "Build manifest",
    )?;
    if manifest
        .pointer("/validation/passed")
        .and_then(Value::as_bool)
        != Some(true)
        || manifest.get("source_sha256").and_then(Value::as_str) != Some(source_sha256)
    {
        return Err(
            "The requested source digest does not match a successful build manifest.".to_owned(),
        );
    }
    if contract.get("project_id").and_then(Value::as_str) != Some(project_id) {
        return Err("Hosting Contract project_id does not match the selected Project.".to_owned());
    }

    let source_files = source_files(&root)?;
    let current_digest = current_source_digest(&root, &source_files)?;
    if current_digest != source_sha256 {
        return Err(
            "Source files changed after validation; validate the exact files again.".to_owned(),
        );
    }
    let archive = source_archive(&root, &source_files)?;
    if archive.len() > MAX_SOURCE_ARCHIVE_BYTES {
        return Err(format!(
            "Source archive exceeds {MAX_SOURCE_ARCHIVE_BYTES} bytes."
        ));
    }
    let archive_digest = sha256_digest(&archive);
    let object = arguments
        .as_object_mut()
        .ok_or_else(|| "Tool arguments must be an object.".to_owned())?;
    object.remove("source_directory");
    object.insert(
        "source_archive_sha256".to_owned(),
        Value::String(archive_digest),
    );
    object.insert("size_bytes".to_owned(), json!(archive.len()));
    object.insert(
        "source_archive_base64".to_owned(),
        Value::String(general_purpose::STANDARD.encode(archive)),
    );
    Ok(arguments)
}

fn string_argument<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{key} is required."))
}

fn read_json_file(path: &Path, description: &str) -> Result<Value, String> {
    let content =
        fs::read_to_string(path).map_err(|_| format!("{description} is missing or invalid."))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|_| format!("{description} is missing or invalid."))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{description} is missing or invalid."))
    }
}

fn source_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_source_files(root, root, &mut files)?;
    files.sort();
    if files.len() > MAX_SOURCE_FILES {
        return Err(format!(
            "source contains more than {MAX_SOURCE_FILES} files."
        ));
    }
    Ok(files)
}

fn collect_source_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_name = entry.file_name();
        if file_name
            .to_str()
            .is_some_and(|name| SOURCE_EXCLUDES.contains(&name))
        {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        let relative = relative_source_path(root, &path)?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Symbolic links are not allowed in source packages: {relative}."
            ));
        }
        if metadata.is_dir() {
            collect_source_files(root, &path, files)?;
        } else if metadata.is_file() {
            if metadata.len() > MAX_SOURCE_FILE_BYTES {
                return Err(format!(
                    "file exceeds {MAX_SOURCE_FILE_BYTES} bytes: {relative}."
                ));
            }
            files.push(path);
        }
    }
    Ok(())
}

fn current_source_digest(root: &Path, files: &[PathBuf]) -> Result<String, String> {
    let mut digest = Sha256::new();
    for file in files {
        let relative = relative_source_path(root, file)?;
        if relative == ".wegent/build-manifest.json" {
            continue;
        }
        digest.update(relative.as_bytes());
        digest.update(b"\0");
        digest
            .update(fs::read(file).map_err(|error| format!("Failed to read {relative}: {error}"))?);
        digest.update(b"\0");
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn source_archive(root: &Path, files: &[PathBuf]) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut archive = ZipWriter::new(&mut cursor);
        let options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644)
            .last_modified_time(zip::DateTime::default());
        for file in files {
            let relative = relative_source_path(root, file)?;
            archive
                .start_file(relative.clone(), options)
                .map_err(|error| format!("Failed to package {relative}: {error}"))?;
            let mut source = fs::File::open(file)
                .map_err(|error| format!("Failed to read {relative}: {error}"))?;
            let mut buffer = Vec::new();
            source
                .read_to_end(&mut buffer)
                .map_err(|error| format!("Failed to read {relative}: {error}"))?;
            archive
                .write_all(&buffer)
                .map_err(|error| format!("Failed to package {relative}: {error}"))?;
        }
        archive
            .finish()
            .map_err(|error| format!("Failed to finalize source archive: {error}"))?;
    }
    Ok(cursor.into_inner())
}

fn relative_source_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|_| "Source path is outside source_directory.".to_owned())
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn tool_result(value: &Value) -> Value {
    let content = value.get("content").cloned().unwrap_or(Value::Null);
    let is_error = value
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut result = if is_mcp_content(&content) {
        json!({ "content": content, "isError": is_error })
    } else if let Some(nested) = content.get("content").filter(|item| is_mcp_content(item)) {
        json!({ "content": nested, "isError": is_error })
    } else {
        let text = match content {
            Value::String(text) => text,
            other => serde_json::to_string(&other).unwrap_or_else(|_| "null".to_owned()),
        };
        text_result(text, is_error)
    };
    if let Some(structured_content) = value
        .get("structured_content")
        .filter(|item| !item.is_null())
    {
        result["structuredContent"] = structured_content.clone();
    }
    result
}

fn is_mcp_content(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.iter().all(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| !kind.is_empty())
        })
    })
}

fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text.into() }],
        "isError": is_error
    })
}

async fn connector_gateway_request(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    load_connector_gateway_config()?
        .request(method, path, body)
        .await
        .map_err(|error| error.message)
}

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_backend_tool_schema_to_mcp_shape() {
        let tools = mcp_tools(&json!({ "tools": [{
            "name": "tickets__search",
            "description": "Search tickets",
            "input_schema": { "type": "object", "properties": { "q": { "type": "string" } } },
            "annotations": { "readOnlyHint": true }
        }] }));
        assert_eq!(tools[0]["name"], "tickets__search");
        assert_eq!(tools[0]["inputSchema"]["properties"]["q"]["type"], "string");
    }

    #[test]
    fn exposes_local_source_directory_for_wegent_sites_source_revisions() {
        let tools = mcp_tools(&json!({ "tools": [{
            "name": WEGENT_SITES_SAVE_SOURCE_REVISION,
            "description": "Save source",
            "input_schema": {
                "type": "object",
                "properties": {
                    "source_archive_base64": { "type": "string" }
                },
                "required": ["source_archive_base64"]
            }
        }] }));

        assert_eq!(
            tools[0]["inputSchema"]["required"],
            json!([
                "project_id",
                "idempotency_key",
                "source_directory",
                "source_sha256"
            ])
        );
        assert!(tools[0]["inputSchema"]["properties"]
            .get("source_archive_base64")
            .is_none());
    }

    #[test]
    fn packages_wegent_sites_source_revision_before_forwarding() {
        let temp = tempfile::tempdir().expect("temporary source directory should exist");
        let root = temp.path();
        fs::create_dir(root.join(".wegent")).expect("metadata directory should be created");
        fs::write(root.join("index.html"), "<h1>Hello</h1>")
            .expect("source file should be written");
        fs::write(
            root.join(".wegent").join("hosting.json"),
            json!({"project_id": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY"}).to_string(),
        )
        .expect("hosting contract should be updated");

        let files = source_files(root).expect("source files should be listed");
        let source_sha256 =
            current_source_digest(root, &files).expect("source digest should be computed");
        fs::write(
            root.join(".wegent").join("build-manifest.json"),
            json!({
                "validation": {"passed": true},
                "source_sha256": source_sha256.clone()
            })
            .to_string(),
        )
        .expect("build manifest should be written");

        let normalized = normalize_tool_arguments(
            WEGENT_SITES_SAVE_SOURCE_REVISION,
            json!({
                "project_id": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
                "idempotency_key": "idem-123456",
                "source_directory": root.display().to_string(),
                "source_sha256": source_sha256.clone()
            }),
        )
        .expect("source revision arguments should normalize");

        assert!(normalized.get("source_directory").is_none());
        assert!(normalized
            .get("source_archive_base64")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()));
        assert_eq!(normalized["source_sha256"], json!(source_sha256));
        assert_eq!(normalized["size_bytes"].as_u64().unwrap() > 0, true);
        assert!(normalized["source_archive_sha256"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
    }

    #[test]
    fn preserves_upstream_mcp_content_blocks() {
        let result = tool_result(&json!({
            "content": [{ "type": "text", "text": "done" }],
            "structured_content": { "ticket": { "id": "T-1" } },
            "is_error": false
        }));

        assert_eq!(result["content"][0]["text"], "done");
        assert_eq!(result["structuredContent"]["ticket"]["id"], "T-1");
        assert_eq!(result["isError"], false);
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Opt-in, lossless transcript transport. A page is an immutable gzip snapshot;
//! transport chunks never become partial turns in the conversation reducer.
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::local::app_ipc::AppIpcError;

pub(super) const VERSION: u64 = 2;
// Base64 plus metadata stays below the 512 KiB compression threshold and the
// 980,000 byte relay limit, regardless of how compressible the history is.
const CHUNK_BYTES: usize = 360 * 1024;
const STRING_BYTES: usize = 1024;
const SNAPSHOT_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

pub(super) fn requested(payload: &Value) -> Result<bool, AppIpcError> {
    match payload.get("transcriptProtocolVersion") {
        None => Ok(false),
        Some(version) if version.as_u64() == Some(1) => Ok(false),
        Some(version) if version.as_u64() == Some(VERSION) => Ok(true),
        _ => Err(AppIpcError::new(
            "unsupported_transcript_protocol",
            "Unsupported transcript protocol version",
        )),
    }
}

pub(super) fn snapshot_directory(root: &Path, payload: &Value) -> PathBuf {
    // Continuations are bound to the same task and session as their first request.
    let address = json!([
        payload.get("taskId").or_else(|| payload.get("task_id")),
        payload.get("threadId").or_else(|| payload.get("thread_id")),
    ]);
    root.join("transcript-transfers").join(format!(
        "{:x}",
        Sha256::digest(address.to_string().as_bytes())
    ))
}

pub(super) fn encode(directory: &Path, response: Value) -> Result<Value, AppIpcError> {
    let packed = pack(response);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    serde_json::to_writer(&mut encoder, &packed).map_err(transport_error)?;
    let bytes = encoder.finish().map_err(transport_error)?;
    let id = format!("{:x}", Sha256::digest(&bytes));
    if bytes.len() > CHUNK_BYTES {
        fs::create_dir_all(directory).map_err(transport_error)?;
        remove_expired_snapshots(directory)?;
        // Atomic publication permits concurrent loads of identical snapshots.
        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(transport_error)?;
        file.write_all(&bytes).map_err(transport_error)?;
        file.persist(directory.join(format!("{id}.gz")))
            .map_err(transport_error)?;
    }
    Ok(chunk(
        &id,
        0,
        bytes.len(),
        &bytes[..bytes.len().min(CHUNK_BYTES)],
    ))
}

pub(super) fn read_chunk(directory: &Path, request: &Value) -> Result<Value, AppIpcError> {
    let id = request
        .get("snapshotId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let offset = request.get("offset").and_then(Value::as_u64);
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppIpcError::new(
            "bad_request",
            "Invalid transcript snapshot ID",
        ));
    }
    let offset = offset
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0 && *value % CHUNK_BYTES == 0)
        .ok_or_else(|| AppIpcError::new("bad_request", "Invalid transcript chunk offset"))?;
    let mut file = File::open(directory.join(format!("{id}.gz"))).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppIpcError::new(
                "transcript_snapshot_expired",
                "Transcript snapshot expired; reload history",
            )
        } else {
            transport_error(error)
        }
    })?;
    let metadata = file.metadata().map_err(transport_error)?;
    if expired(&metadata) {
        return Err(AppIpcError::new(
            "transcript_snapshot_expired",
            "Transcript snapshot expired; reload history",
        ));
    }
    let size = usize::try_from(metadata.len()).map_err(transport_error)?;
    if offset >= size {
        return Err(AppIpcError::new(
            "bad_request",
            "Transcript chunk offset exceeds snapshot",
        ));
    }
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(transport_error)?;
    let mut bytes = vec![0; (size - offset).min(CHUNK_BYTES)];
    file.read_exact(&mut bytes).map_err(transport_error)?;
    Ok(chunk(id, offset, size, &bytes))
}

fn chunk(id: &str, offset: usize, total: usize, bytes: &[u8]) -> Value {
    let next = offset + bytes.len();
    json!({
        "success": true,
        "transcriptProtocolVersion": VERSION,
        "transfer": {
            "snapshotId": id,
            "encoding": "gzip+base64+json",
            "offset": offset,
            "nextOffset": if next < total { Some(next) } else { None },
            "totalBytes": total,
            "payload": STANDARD.encode(bytes),
        }
    })
}

fn pack(mut transcript: Value) -> Value {
    let mut strings = Vec::new();
    let mut references = Vec::new();
    intern_strings(
        &mut transcript,
        &mut Vec::new(),
        &mut HashMap::new(),
        &mut strings,
        &mut references,
    );
    json!({"transcript": transcript, "strings": strings, "references": references})
}

fn intern_strings(
    value: &mut Value,
    path: &mut Vec<Value>,
    indexes: &mut HashMap<[u8; 32], usize>,
    strings: &mut Vec<String>,
    references: &mut Vec<Value>,
) {
    match value {
        Value::String(text) if text.len() >= STRING_BYTES => {
            let hash: [u8; 32] = Sha256::digest(text.as_bytes()).into();
            let index = *indexes.entry(hash).or_insert_with(|| {
                strings.push(std::mem::take(text));
                strings.len() - 1
            });
            references.push(json!({"path": path, "index": index}));
            *value = Value::Null;
        }
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                path.push(json!(index));
                intern_strings(item, path, indexes, strings, references);
                path.pop();
            }
        }
        Value::Object(fields) => {
            for (key, item) in fields.iter_mut() {
                path.push(json!(key));
                intern_strings(item, path, indexes, strings, references);
                path.pop();
            }
        }
        _ => {}
    }
}

fn expired(metadata: &fs::Metadata) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|time| SystemTime::now().duration_since(time).ok())
        .is_some_and(|age| age > SNAPSHOT_LIFETIME)
}

fn remove_expired_snapshots(directory: &Path) -> Result<(), AppIpcError> {
    for entry in fs::read_dir(directory).map_err(transport_error)? {
        let entry = entry.map_err(transport_error)?;
        if !entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "gz")
        {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            // Another request may have removed this expired snapshot.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(transport_error(error)),
        };
        if expired(&metadata) {
            match fs::remove_file(entry.path()) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(transport_error(error)),
            }
        }
    }
    Ok(())
}

pub(super) fn remove_expired_transfers(runtime_directory: &Path) -> Result<(), AppIpcError> {
    let entries = match fs::read_dir(runtime_directory.join("transcript-transfers")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(transport_error(error)),
    };
    for entry in entries {
        let entry = entry.map_err(transport_error)?;
        if entry.file_type().map_err(transport_error)?.is_dir() {
            remove_expired_snapshots(&entry.path())?;
        }
    }
    Ok(())
}

fn transport_error(error: impl std::fmt::Display) -> AppIpcError {
    AppIpcError::new(
        "transcript_transport_failed",
        format!("Transcript transfer failed: {error}"),
    )
}

#[cfg(test)]
#[path = "transcript_transport_tests.rs"]
mod tests;

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Opt-in, lossless transcript transport. A page is an immutable gzip snapshot;
//! transport chunks never become partial turns in the conversation reducer.
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::local::app_ipc::AppIpcError;
use crate::logging::{format_executor_log, write_executor_log_line};

pub(super) const VERSION: u64 = 2;

/// Reassembles the same lossless pages consumed by the desktop reader.
#[derive(Default)]
pub(super) struct TranscriptDecoder {
    identity: Option<(String, usize)>,
    bytes: Vec<u8>,
}

impl TranscriptDecoder {
    pub(super) fn push(&mut self, response: &Value) -> Result<Option<Value>, AppIpcError> {
        let invalid = || AppIpcError::new("invalid_response", "Invalid transcript transfer");
        let transfer = &response["transfer"];
        let id = transfer["snapshotId"].as_str().ok_or_else(invalid)?;
        let total = transfer["totalBytes"]
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(invalid)?;
        if response["transcriptProtocolVersion"] != VERSION
            || transfer["encoding"] != "gzip+base64+json"
            || id.len() != 64
            || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || total == 0
            || transfer["offset"].as_u64() != Some(self.bytes.len() as u64)
        {
            return Err(invalid());
        }
        let identity = self.identity.get_or_insert_with(|| (id.to_owned(), total));
        if identity != &(id.to_owned(), total) {
            return Err(invalid());
        }
        let bytes = STANDARD
            .decode(transfer["payload"].as_str().ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        if bytes.is_empty()
            || bytes.len() > CHUNK_BYTES
            || bytes.len() > total.saturating_sub(self.bytes.len())
        {
            return Err(invalid());
        }
        self.bytes.extend_from_slice(&bytes);
        if !transfer["nextOffset"].is_null() {
            if transfer["nextOffset"].as_u64() != Some(self.bytes.len() as u64)
                || self.bytes.len() >= total
            {
                return Err(invalid());
            }
            return Ok(None);
        }
        if self.bytes.len() != total {
            return Err(invalid());
        }
        let mut unpacked = Vec::new();
        flate2::read::GzDecoder::new(self.bytes.as_slice())
            .read_to_end(&mut unpacked)
            .map_err(|_| invalid())?;
        let mut packed: Value = serde_json::from_slice(&unpacked).map_err(|_| invalid())?;
        let strings = packed["strings"]
            .as_array()
            .filter(|s| s.iter().all(Value::is_string))
            .ok_or_else(invalid)?
            .clone();
        let references = packed["references"].as_array().ok_or_else(invalid)?.clone();
        let transcript = packed
            .get_mut("transcript")
            .filter(|v| v.is_object())
            .ok_or_else(invalid)?;
        for reference in references {
            let path = reference["path"]
                .as_array()
                .filter(|p| !p.is_empty())
                .ok_or_else(invalid)?;
            let text = reference["index"]
                .as_u64()
                .and_then(|v| strings.get(v as usize))
                .ok_or_else(invalid)?;
            let mut target = &mut *transcript;
            for key in path {
                target = if let Some(key) = key.as_str() {
                    target.as_object_mut().and_then(|map| map.get_mut(key))
                } else {
                    key.as_u64().and_then(|index| {
                        target
                            .as_array_mut()
                            .and_then(|items| items.get_mut(index as usize))
                    })
                }
                .ok_or_else(invalid)?;
            }
            if !target.is_null() {
                return Err(invalid());
            }
            *target = text.clone();
        }
        Ok(Some(std::mem::take(transcript)))
    }
}
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
    let started_at = Instant::now();
    let packed = pack(response);
    let packed_at = Instant::now();
    let encoder = GzEncoder::new(Vec::new(), Compression::fast());
    let encoder = write_packed_json(encoder, &packed)?;
    let bytes = encoder.finish().map_err(transport_error)?;
    let compressed_at = Instant::now();
    let id = format!("{:x}", Sha256::digest(&bytes));
    if bytes.len() > CHUNK_BYTES {
        fs::create_dir_all(directory).map_err(transport_error)?;
        // tempfile passes paths directly to Win32 when publishing. Canonicalize
        // the existing directory so long snapshot paths retain the verbatim prefix.
        let directory = directory.canonicalize().map_err(transport_error)?;
        remove_expired_snapshots(&directory)?;
        // Content-addressed snapshots are immutable. Reuse an existing publication
        // instead of replacing a file another request may already be reading.
        let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(transport_error)?;
        file.write_all(&bytes).map_err(transport_error)?;
        if let Err(error) = file.persist_noclobber(directory.join(format!("{id}.gz"))) {
            if error.error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(transport_error(error));
            }
        }
    }
    log_snapshot_encoding(started_at, packed_at, compressed_at, bytes.len());
    Ok(chunk(
        &id,
        0,
        bytes.len(),
        &bytes[..bytes.len().min(CHUNK_BYTES)],
    ))
}

fn log_snapshot_encoding(
    started_at: Instant,
    packed_at: Instant,
    compressed_at: Instant,
    size: usize,
) {
    write_executor_log_line(&format_executor_log(
        "runtime transcript snapshot encoded",
        &[
            (
                "pack_ms",
                packed_at.duration_since(started_at).as_millis().to_string(),
            ),
            (
                "compression_ms",
                compressed_at
                    .duration_since(packed_at)
                    .as_millis()
                    .to_string(),
            ),
            (
                "publication_ms",
                compressed_at.elapsed().as_millis().to_string(),
            ),
            ("compressed_bytes", size.to_string()),
        ],
    ));
}

fn write_packed_json<W: Write>(writer: W, packed: &Value) -> Result<W, AppIpcError> {
    // Batch JSON punctuation and escape fragments before feeding the compressor.
    let mut buffered = BufWriter::new(writer);
    serde_json::to_writer(&mut buffered, packed).map_err(transport_error)?;
    buffered.into_inner().map_err(transport_error)
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

#[cfg(test)]
mod decoder_tests {
    use super::*;

    #[test]
    fn transcript_decoder_restores_all_chunks_and_long_user_keyed_content() {
        let root = tempfile::tempdir().unwrap();
        let text: String = (0_i64..25_000)
            .map(|index| format!("{:x}", Sha256::digest(index.to_le_bytes())))
            .collect();
        let original = json!({"success":true,"messages":[{"content":text}],"user/field~":{"text":text},"hasMoreBefore":true,"beforeCursor":"old-page"});
        let mut response = encode(root.path(), original.clone()).unwrap();
        assert!(response["transfer"]["nextOffset"].is_number());
        let mut decoder = TranscriptDecoder::default();
        let mut chunks = 0;
        let decoded = loop {
            chunks += 1;
            if let Some(value) = decoder.push(&response).unwrap() {
                break value;
            }
            response = read_chunk(root.path(),&json!({"snapshotId":response["transfer"]["snapshotId"],"offset":response["transfer"]["nextOffset"]})).unwrap();
        };
        assert!(chunks > 1);
        assert_eq!(decoded, original);
    }

    #[test]
    fn transcript_decoder_rejects_partial_misordered_and_corrupted_pages() {
        let root = tempfile::tempdir().unwrap();
        let original = encode(
            root.path(),
            json!({"messages":[{"content":"x".repeat(70_000)}]}),
        )
        .unwrap();
        for (key, value) in [
            ("offset", json!(1)),
            ("totalBytes", json!(1)),
            ("encoding", json!("unknown")),
            ("nextOffset", json!(0)),
        ] {
            let mut invalid = original.clone();
            invalid["transfer"][key] = value;
            assert!(TranscriptDecoder::default().push(&invalid).is_err());
        }
        let mut corrupted = original.clone();
        let mut bytes = STANDARD
            .decode(corrupted["transfer"]["payload"].as_str().unwrap())
            .unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        corrupted["transfer"]["payload"] = json!(STANDARD.encode(bytes));
        assert!(TranscriptDecoder::default().push(&corrupted).is_err());
    }
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

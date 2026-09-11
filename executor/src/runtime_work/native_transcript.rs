// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashSet,
    env, fs,
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    time::Duration,
};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use ignore::WalkBuilder;
use rusqlite::{
    params,
    types::{Value as SqlValue, ValueRef},
    Connection, OptionalExtension,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use tar::{Archive, Builder};
use uuid::Uuid;

use crate::agents::{executor_home, wework_codex_home};
use crate::local::native_git::run_git_capture;

const STATE_DB_FILENAME: &str = "state_5.sqlite";
const CODEX_SQLITE_HOME_ENV: &str = "CODEX_SQLITE_HOME";
const ENCRYPTED_MAGIC: &[u8; 4] = b"WTRN";
const ENCRYPTED_VERSION: u8 = 1;
const ENCRYPTED_HEADER_BYTES: usize = ENCRYPTED_MAGIC.len() + 1 + 12;
const AES_GCM_TAG_BYTES: u64 = 16;
const MAX_ROLLOUT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PLAINTEXT_SEGMENT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ENCRYPTED_SEGMENT_BYTES: u64 =
    MAX_PLAINTEXT_SEGMENT_BYTES + ENCRYPTED_HEADER_BYTES as u64 + AES_GCM_TAG_BYTES;
const MAX_WORKSPACE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_WORKSPACE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_WORKSPACE_PATH_LIST_BYTES: usize = 16 * 1024 * 1024;
const WORKSPACE_GIT_TIMEOUT: Duration = Duration::from_secs(10);
const MANIFEST_PATH: &str = "manifest.json";
const ROLLOUT_PATH: &str = "rollout.jsonl";
const WORKSPACE_PREFIX: &str = "workspace";
const EXCLUDED_NAMES: &[&str] = &[
    ".DS_Store",
    ".git",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTranscriptManifest {
    version: u64,
    transcript_id: String,
    task_id: String,
    title: String,
    sequence: u64,
    base_sequence: u64,
    format: String,
    source_thread_id: String,
    source_workspace_path: String,
    rollout_start: u64,
    rollout_end: u64,
    thread: Map<String, Value>,
    thread_dynamic_tools: Vec<Map<String, Value>>,
}

#[derive(Debug, Clone)]
pub(crate) struct ExportRequest {
    pub transcript_id: String,
    pub task_id: String,
    pub title: String,
    pub workspace_path: PathBuf,
    pub workspace_paths: Option<Vec<PathBuf>>,
    pub workspace_snapshot: Option<WorkspaceSnapshot>,
    pub thread_id: String,
    pub sequence: u64,
    pub base_sequence: u64,
    pub rollout_start: u64,
    pub snapshot: bool,
    pub encryption_key: String,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkspaceSnapshot {
    pub git_common_dir: PathBuf,
    pub reference: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ExportedSegment {
    pub path: PathBuf,
    pub sha256: String,
    pub size_bytes: u64,
    pub format: String,
    pub rollout_end: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreSegment {
    pub path: PathBuf,
    pub sha256: String,
    pub sequence: u64,
    pub format: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RestoredTranscript {
    pub title: String,
    pub workspace_path: PathBuf,
    pub thread_id: String,
    pub sequence: u64,
    pub rollout_end: u64,
}

pub(crate) fn export_segment(request: ExportRequest) -> Result<ExportedSegment, String> {
    if request.sequence != request.base_sequence + 1 {
        return Err("native transcript segment must advance exactly one sequence".to_owned());
    }
    let codex_home = wework_codex_home();
    let state_path = codex_state_home(&codex_home).join(STATE_DB_FILENAME);
    let thread = read_rows(&state_path, "threads", "id", &request.thread_id)?
        .into_iter()
        .next()
        .ok_or_else(|| format!("Codex thread state is unavailable: {}", request.thread_id))?;
    let thread_dynamic_tools = read_rows(
        &state_path,
        "thread_dynamic_tools",
        "thread_id",
        &request.thread_id,
    )?;
    let rollout_path = thread
        .get("rollout_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "Codex thread state has no rollout_path".to_owned())?;
    let rollout = read_limited(&rollout_path, MAX_ROLLOUT_BYTES, "native Codex rollout")?;
    let rollout_start = if request.snapshot {
        0
    } else {
        usize::try_from(request.rollout_start)
            .map_err(|_| "rollout offset is too large".to_owned())?
    };
    if rollout_start > rollout.len() {
        return Err("native Codex rollout moved behind its synchronized offset".to_owned());
    }
    let format = if request.snapshot {
        "codex-snapshot.v1.tgz.aes256gcm"
    } else {
        "codex-delta.v1.tgz.aes256gcm"
    }
    .to_owned();
    let manifest = NativeTranscriptManifest {
        version: 1,
        transcript_id: request.transcript_id,
        task_id: request.task_id,
        title: request.title,
        sequence: request.sequence,
        base_sequence: request.base_sequence,
        format: format.clone(),
        source_thread_id: request.thread_id,
        source_workspace_path: request.workspace_path.to_string_lossy().into_owned(),
        rollout_start: rollout_start as u64,
        rollout_end: rollout.len() as u64,
        thread,
        thread_dynamic_tools,
    };
    let output_dir = executor_home()
        .join("runtime-work")
        .join("transcript-segments");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("failed to create transcript segment directory: {error}"))?;
    let segment_id = Uuid::new_v4();
    let plaintext_path = output_dir.join(format!("{segment_id}.tgz"));
    let output_path = output_dir.join(format!("{segment_id}.tgz.aes256gcm"));
    let package_result = (|| {
        let output = create_private_file(&plaintext_path)
            .map_err(|error| format!("failed to create transcript segment: {error}"))?;
        let encoder = GzEncoder::new(output, Compression::default());
        let mut archive = Builder::new(encoder);
        append_bytes(
            &mut archive,
            MANIFEST_PATH,
            &serde_json::to_vec(&manifest)
                .map_err(|error| format!("failed to serialize transcript manifest: {error}"))?,
        )?;
        append_bytes(&mut archive, ROLLOUT_PATH, &rollout[rollout_start..])?;
        append_workspace(
            &mut archive,
            &request.workspace_path,
            request.workspace_paths.as_deref(),
            request.workspace_snapshot.as_ref(),
        )?;
        archive
            .into_inner()
            .and_then(GzEncoder::finish)
            .map_err(|error| format!("failed to finish transcript segment: {error}"))?;
        Ok::<(), String>(())
    })();
    if let Err(error) = package_result {
        cleanup(&plaintext_path);
        return Err(error);
    }
    let plaintext = match read_limited(
        &plaintext_path,
        MAX_PLAINTEXT_SEGMENT_BYTES,
        "transcript segment for encryption",
    ) {
        Ok(plaintext) => plaintext,
        Err(error) => {
            cleanup(&plaintext_path);
            return Err(error);
        }
    };
    let encrypted = encrypt_segment(
        &plaintext,
        &request.encryption_key,
        &manifest.transcript_id,
        manifest.sequence,
        &manifest.format,
    );
    cleanup(&plaintext_path);
    let encrypted = encrypted?;
    let write_result = create_private_file(&output_path)
        .and_then(|mut output| output.write_all(&encrypted))
        .map_err(|error| format!("failed to write encrypted transcript segment: {error}"));
    if let Err(error) = write_result {
        cleanup(&output_path);
        return Err(error);
    }
    Ok(ExportedSegment {
        path: output_path,
        sha256: format!("{:x}", Sha256::digest(&encrypted)),
        size_bytes: encrypted.len() as u64,
        format,
        rollout_end: rollout.len() as u64,
    })
}

pub(crate) fn restore_segments(
    transcript_id: &str,
    segments: &[RestoreSegment],
    encryption_key: &str,
) -> Result<RestoredTranscript, String> {
    if segments.is_empty() {
        return Err("native transcript restore requires at least one segment".to_owned());
    }
    let mut ordered = segments.to_vec();
    ordered.sort_by_key(|segment| segment.sequence);
    let snapshot_index = ordered
        .iter()
        .rposition(|segment| segment.format.contains("snapshot"))
        .ok_or_else(|| "native transcript restore requires a full snapshot".to_owned())?;
    let ordered = &ordered[snapshot_index..];
    let first_sequence = ordered[0].sequence;
    let mut rollout = Vec::new();
    let mut final_manifest = None;
    let staging_root = executor_home()
        .join("runtime-work")
        .join("transcript-restore")
        .join(Uuid::new_v4().to_string());
    let staging_guard = CleanupGuard::new(staging_root.clone());
    let staging_workspace = staging_root.join("workspace");
    fs::create_dir_all(&staging_workspace)
        .map_err(|error| format!("failed to create transcript restore staging: {error}"))?;
    for (offset, segment) in ordered.iter().enumerate() {
        let expected = first_sequence + offset as u64;
        if segment.sequence != expected {
            cleanup(&staging_root);
            return Err(format!(
                "native transcript restore expected sequence {expected}, received {}",
                segment.sequence
            ));
        }
        let bytes = read_limited(
            &segment.path,
            MAX_ENCRYPTED_SEGMENT_BYTES,
            "transcript segment",
        )?;
        if format!("{:x}", Sha256::digest(&bytes)) != segment.sha256 {
            cleanup(&staging_root);
            return Err("native transcript segment failed SHA-256 verification".to_owned());
        }
        cleanup(&staging_workspace);
        fs::create_dir_all(&staging_workspace)
            .map_err(|error| format!("failed to reset transcript restore staging: {error}"))?;
        let plaintext = decrypt_segment(
            &bytes,
            encryption_key,
            transcript_id,
            segment.sequence,
            &segment.format,
        )?;
        let (manifest, segment_rollout) =
            extract_segment(&plaintext, &staging_workspace, transcript_id)?;
        if manifest.sequence != segment.sequence || manifest.format != segment.format {
            cleanup(&staging_root);
            return Err("native transcript segment manifest does not match its index".to_owned());
        }
        if manifest.format.contains("snapshot") {
            rollout = segment_rollout;
        } else {
            if manifest.rollout_start != rollout.len() as u64 {
                cleanup(&staging_root);
                return Err("native transcript rollout delta is not contiguous".to_owned());
            }
            let merged_size = rollout
                .len()
                .checked_add(segment_rollout.len())
                .ok_or_else(|| "native transcript rollout is too large".to_owned())?;
            if merged_size as u64 > MAX_ROLLOUT_BYTES {
                return Err("native transcript rollout is too large".to_owned());
            }
            rollout.extend(segment_rollout);
        }
        if rollout.len() as u64 != manifest.rollout_end {
            cleanup(&staging_root);
            return Err("native transcript rollout length does not match its manifest".to_owned());
        }
        final_manifest = Some(manifest);
    }
    validate_jsonl(&rollout)?;
    let manifest = final_manifest.expect("segments are non-empty");
    let destination_workspace = unused_workspace_path(transcript_id);
    if let Some(parent) = destination_workspace.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create restored workspace parent: {error}"))?;
    }
    fs::rename(&staging_workspace, &destination_workspace)
        .map_err(|error| format!("failed to bind restored workspace: {error}"))?;
    let mut destination_guard = CleanupGuard::new(destination_workspace.clone());
    let codex_home = wework_codex_home();
    let state_path = codex_state_home(&codex_home).join(STATE_DB_FILENAME);
    let thread_id = unused_thread_id(&state_path, &manifest.source_thread_id)?;
    let rollout_path = canonical_rollout_path(&codex_home, &thread_id);
    if let Some(parent) = rollout_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create restored rollout parent: {error}"))?;
    }
    let rewritten = rewrite_rollout(
        &rollout,
        &manifest.source_thread_id,
        &thread_id,
        &manifest.source_workspace_path,
        &destination_workspace,
    )?;
    let rewritten_rollout_end = rewritten.len() as u64;
    let write_result =
        create_private_file(&rollout_path).and_then(|mut output| output.write_all(&rewritten));
    if let Err(error) = write_result {
        cleanup(&staging_root);
        return Err(format!("failed to write restored native rollout: {error}"));
    }
    if let Err(error) = restore_thread_state(
        &state_path,
        &manifest,
        &thread_id,
        &destination_workspace,
        &rollout_path,
    ) {
        cleanup(&rollout_path);
        cleanup(&staging_root);
        return Err(error);
    }
    destination_guard.disarm();
    drop(staging_guard);
    Ok(RestoredTranscript {
        title: manifest.title,
        workspace_path: destination_workspace,
        thread_id,
        sequence: manifest.sequence,
        rollout_end: rewritten_rollout_end,
    })
}

pub(crate) fn remove_restored_transcript(
    workspace_path: &Path,
    thread_id: &str,
) -> Result<bool, String> {
    let restored_root = executor_home().join("restored-workspaces");
    if workspace_path.parent() != Some(restored_root.as_path()) {
        return Ok(false);
    }
    let codex_home = wework_codex_home();
    let state_path = codex_state_home(&codex_home).join(STATE_DB_FILENAME);
    let mut connection = Connection::open(&state_path)
        .map_err(|error| format!("failed to open Codex state database: {error}"))?;
    let rollout_path = connection
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?",
            params![thread_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to read restored Codex thread: {error}"))?
        .map(PathBuf::from);
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin restored Codex thread cleanup: {error}"))?;
    transaction
        .execute(
            "DELETE FROM thread_dynamic_tools WHERE thread_id = ?",
            params![thread_id],
        )
        .map_err(|error| format!("failed to remove restored Codex tools: {error}"))?;
    transaction
        .execute("DELETE FROM threads WHERE id = ?", params![thread_id])
        .map_err(|error| format!("failed to remove restored Codex thread: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit restored Codex thread cleanup: {error}"))?;
    if let Some(rollout_path) = rollout_path.filter(|path| {
        path.starts_with(codex_home.join("sessions"))
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&format!("-{thread_id}.jsonl")))
    }) {
        cleanup(&rollout_path);
    }
    cleanup(workspace_path);
    Ok(true)
}

fn encryption_aad(transcript_id: &str, sequence: u64, format: &str) -> Vec<u8> {
    format!("wework-transcript-segment:v1:{transcript_id}:{sequence}:{format}").into_bytes()
}

fn decode_encryption_key(value: &str) -> Result<[u8; 32], String> {
    BASE64
        .decode(value)
        .map_err(|error| format!("failed to decode transcript encryption key: {error}"))?
        .try_into()
        .map_err(|_| "transcript encryption key must be 32 bytes".to_owned())
}

fn encrypt_segment(
    plaintext: &[u8],
    encryption_key: &str,
    transcript_id: &str,
    sequence: u64,
    format: &str,
) -> Result<Vec<u8>, String> {
    let key = decode_encryption_key(encryption_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("failed to initialize transcript cipher: {error}"))?;
    let aad = encryption_aad(transcript_id, sequence, format);
    let mut nonce_digest = Sha256::new();
    nonce_digest.update(key);
    nonce_digest.update(&aad);
    nonce_digest.update(Sha256::digest(plaintext));
    let nonce_digest = nonce_digest.finalize();
    let mut nonce = [0_u8; 12];
    nonce.copy_from_slice(&nonce_digest[..12]);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "failed to encrypt transcript segment".to_owned())?;
    let mut encrypted = Vec::with_capacity(ENCRYPTED_HEADER_BYTES + ciphertext.len());
    encrypted.extend_from_slice(ENCRYPTED_MAGIC);
    encrypted.push(ENCRYPTED_VERSION);
    encrypted.extend_from_slice(&nonce);
    encrypted.extend_from_slice(&ciphertext);
    Ok(encrypted)
}

fn decrypt_segment(
    encrypted: &[u8],
    encryption_key: &str,
    transcript_id: &str,
    sequence: u64,
    format: &str,
) -> Result<Vec<u8>, String> {
    if encrypted.len() <= ENCRYPTED_HEADER_BYTES
        || &encrypted[..ENCRYPTED_MAGIC.len()] != ENCRYPTED_MAGIC
        || encrypted[ENCRYPTED_MAGIC.len()] != ENCRYPTED_VERSION
    {
        return Err("unsupported encrypted transcript segment".to_owned());
    }
    let key = decode_encryption_key(encryption_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("failed to initialize transcript cipher: {error}"))?;
    let nonce_start = ENCRYPTED_MAGIC.len() + 1;
    let nonce_end = nonce_start + 12;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&encrypted[nonce_start..nonce_end]),
            Payload {
                msg: &encrypted[nonce_end..],
                aad: &encryption_aad(transcript_id, sequence, format),
            },
        )
        .map_err(|_| "transcript segment authentication failed".to_owned())?;
    if plaintext.len() as u64 > MAX_PLAINTEXT_SEGMENT_BYTES {
        return Err("decrypted transcript segment is too large".to_owned());
    }
    Ok(plaintext)
}

fn read_limited(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    let size = fs::metadata(path)
        .map_err(|error| format!("failed to inspect {label}: {error}"))?
        .len();
    if size > max_bytes {
        return Err(format!("{label} exceeds the {max_bytes}-byte limit"));
    }
    fs::read(path).map_err(|error| format!("failed to read {label}: {error}"))
}

fn create_private_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn read_rows(
    database_path: &Path,
    table: &str,
    key: &str,
    value: &str,
) -> Result<Vec<Map<String, Value>>, String> {
    let connection = Connection::open(database_path)
        .map_err(|error| format!("failed to open Codex state database: {error}"))?;
    let sql = format!("SELECT * FROM {table} WHERE {key} = ? ORDER BY rowid");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("failed to read Codex state schema: {error}"))?;
    let names = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    let rows = statement
        .query_map(params![value], |row| {
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                object.insert(name.clone(), sql_value_to_json(row.get_ref(index)?));
            }
            Ok(object)
        })
        .map_err(|error| format!("failed to query Codex state: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode Codex state: {error}"))?;
    Ok(rows)
}

fn sql_value_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Number(value.into()),
        ValueRef::Real(value) => Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Array(
            value
                .iter()
                .map(|byte| Value::Number((*byte).into()))
                .collect(),
        ),
    }
}

fn json_to_sql_value(value: &Value) -> Result<SqlValue, String> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Number(value) => value
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| value.as_f64().map(SqlValue::Real))
            .ok_or_else(|| "unsupported numeric Codex state value".to_owned())?,
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Array(values) if values.iter().all(Value::is_number) => SqlValue::Blob(
            values
                .iter()
                .map(|value| value.as_u64().unwrap_or_default() as u8)
                .collect(),
        ),
        _ => SqlValue::Text(
            serde_json::to_string(value)
                .map_err(|error| format!("failed to serialize Codex state value: {error}"))?,
        ),
    })
}

fn append_bytes(
    archive: &mut Builder<GzEncoder<fs::File>>,
    path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    archive
        .append_data(&mut header, path, bytes)
        .map_err(|error| format!("failed to append transcript archive member: {error}"))
}

fn append_workspace(
    archive: &mut Builder<GzEncoder<fs::File>>,
    workspace: &Path,
    workspace_paths: Option<&[PathBuf]>,
    snapshot: Option<&WorkspaceSnapshot>,
) -> Result<(), String> {
    if workspace.is_dir() {
        return match workspace_paths {
            Some(paths) => append_workspace_paths(archive, workspace, paths),
            None => append_workspace_directory(archive, workspace),
        };
    }
    let snapshot =
        snapshot.ok_or_else(|| format!("workspace does not exist: {}", workspace.display()))?;
    append_workspace_snapshot(archive, snapshot)
}

fn append_workspace_directory(
    archive: &mut Builder<GzEncoder<fs::File>>,
    workspace: &Path,
) -> Result<(), String> {
    let mut total_bytes = 0_u64;
    for entry in WalkBuilder::new(workspace)
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .follow_links(false)
        .build()
    {
        let entry = entry.map_err(|error| format!("failed to walk workspace: {error}"))?;
        let path = entry.path();
        if path == workspace {
            continue;
        }
        let relative = path
            .strip_prefix(workspace)
            .map_err(|error| format!("failed to relativize workspace path: {error}"))?;
        if relative
            .components()
            .any(|part| EXCLUDED_NAMES.contains(&part.as_os_str().to_string_lossy().as_ref()))
        {
            continue;
        }
        if entry
            .file_type()
            .is_some_and(|file_type| file_type.is_symlink())
        {
            continue;
        }
        if entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            let size = entry
                .metadata()
                .map_err(|error| format!("failed to inspect workspace member: {error}"))?
                .len();
            validate_workspace_member_size(relative, size, &mut total_bytes)?;
        }
        archive
            .append_path_with_name(path, Path::new(WORKSPACE_PREFIX).join(relative))
            .map_err(|error| format!("failed to append workspace member: {error}"))?;
    }
    Ok(())
}

pub(crate) async fn prepare_workspace_paths(
    workspace: &Path,
) -> Result<Option<Vec<PathBuf>>, String> {
    if git_marker(workspace).is_none() {
        return Ok(None);
    }
    let environment = env::vars().collect();
    let probe = run_git_capture(
        &["rev-parse".to_owned(), "--is-inside-work-tree".to_owned()],
        Some(workspace),
        &environment,
        WORKSPACE_GIT_TIMEOUT,
        1024,
    )
    .await
    .map_err(|error| format!("failed to inspect workspace repository: {}", error.message))?;
    if !probe.success || String::from_utf8_lossy(&probe.stdout).trim() != "true" {
        return Err(format!(
            "failed to inspect workspace repository: {}",
            probe.stderr.trim()
        ));
    }
    let output = run_git_capture(
        &[
            "ls-files".to_owned(),
            "--cached".to_owned(),
            "--others".to_owned(),
            "--exclude-standard".to_owned(),
            "-z".to_owned(),
        ],
        Some(workspace),
        &environment,
        WORKSPACE_GIT_TIMEOUT,
        MAX_WORKSPACE_PATH_LIST_BYTES,
    )
    .await
    .map_err(|error| {
        format!(
            "failed to list workspace repository files: {}",
            error.message
        )
    })?;
    if !output.success {
        return Err(format!(
            "failed to list workspace repository files: {}",
            output.stderr.trim()
        ));
    }
    if output.truncated {
        return Err("workspace repository file list is too large to synchronize".to_owned());
    }
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(git_path)
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn git_marker(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .map(|ancestor| ancestor.join(".git"))
        .find(|marker| marker.exists())
}

fn git_path(bytes: &[u8]) -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        Ok(PathBuf::from(OsString::from_vec(bytes.to_vec())))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(PathBuf::from)
            .map_err(|_| "workspace repository contains a non-UTF-8 path".to_owned())
    }
}

fn append_workspace_paths(
    archive: &mut Builder<GzEncoder<fs::File>>,
    workspace: &Path,
    paths: &[PathBuf],
) -> Result<(), String> {
    let mut total_bytes = 0_u64;
    for relative in paths {
        if unsafe_path(relative) {
            continue;
        }
        let path = workspace.join(relative);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("failed to inspect workspace member: {error}"));
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        validate_workspace_member_size(relative, metadata.len(), &mut total_bytes)?;
        archive
            .append_path_with_name(&path, Path::new(WORKSPACE_PREFIX).join(relative))
            .map_err(|error| format!("failed to append workspace member: {error}"))?;
    }
    Ok(())
}

fn append_workspace_snapshot(
    archive: &mut Builder<GzEncoder<fs::File>>,
    snapshot: &WorkspaceSnapshot,
) -> Result<(), String> {
    let mut command = Command::new("git");
    crate::local::native_git::clear_local_git_env(&mut command);
    command
        .arg("--git-dir")
        .arg(&snapshot.git_common_dir)
        .args(["archive", "--format=tar", &snapshot.reference, "--", "."]);
    for name in EXCLUDED_NAMES {
        command.arg(format!(":(exclude,glob){name}/**"));
        command.arg(format!(":(exclude,glob)**/{name}/**"));
    }
    let output = command
        .output()
        .map_err(|error| format!("failed to read workspace snapshot: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to read workspace snapshot {}: {}",
            snapshot.reference,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut source = Archive::new(Cursor::new(output.stdout));
    let mut total_bytes = 0_u64;
    for entry in source
        .entries()
        .map_err(|error| format!("failed to open workspace snapshot: {error}"))?
    {
        let mut entry =
            entry.map_err(|error| format!("failed to read workspace snapshot member: {error}"))?;
        let relative = entry
            .path()
            .map_err(|error| format!("invalid workspace snapshot path: {error}"))?
            .to_path_buf();
        if unsafe_path(&relative)
            || relative
                .components()
                .any(|part| EXCLUDED_NAMES.contains(&part.as_os_str().to_string_lossy().as_ref()))
        {
            continue;
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            continue;
        }
        let size = entry.size();
        if entry_type.is_file() {
            validate_workspace_member_size(&relative, size, &mut total_bytes)?;
        }
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(entry_type);
        header.set_mode(entry.header().mode().unwrap_or(0o600));
        header.set_size(size);
        header.set_cksum();
        archive
            .append_data(
                &mut header,
                Path::new(WORKSPACE_PREFIX).join(&relative),
                &mut entry,
            )
            .map_err(|error| format!("failed to append workspace snapshot member: {error}"))?;
    }
    Ok(())
}

fn validate_workspace_member_size(
    relative: &Path,
    size: u64,
    total_bytes: &mut u64,
) -> Result<(), String> {
    if size > MAX_WORKSPACE_FILE_BYTES {
        return Err(format!(
            "workspace member exceeds the {MAX_WORKSPACE_FILE_BYTES}-byte limit: {}",
            relative.display()
        ));
    }
    *total_bytes = total_bytes
        .checked_add(size)
        .ok_or_else(|| "workspace is too large to synchronize".to_owned())?;
    if *total_bytes > MAX_WORKSPACE_BYTES {
        return Err("workspace is too large to synchronize".to_owned());
    }
    Ok(())
}

fn extract_segment(
    bytes: &[u8],
    workspace: &Path,
    transcript_id: &str,
) -> Result<(NativeTranscriptManifest, Vec<u8>), String> {
    let mut archive = Archive::new(GzDecoder::new(bytes));
    let mut manifest = None;
    let mut rollout = None;
    let mut workspace_bytes = 0_u64;
    for entry in archive
        .entries()
        .map_err(|error| format!("failed to open transcript segment: {error}"))?
    {
        let mut entry =
            entry.map_err(|error| format!("failed to read transcript archive member: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("invalid transcript archive path: {error}"))?
            .to_path_buf();
        if unsafe_path(&path) {
            return Err("transcript segment contains an unsafe path".to_owned());
        }
        if path == Path::new(MANIFEST_PATH) {
            let bytes = read_archive_member(&mut entry, 1024 * 1024, "transcript manifest")?;
            let value: NativeTranscriptManifest = serde_json::from_slice(&bytes)
                .map_err(|error| format!("invalid transcript manifest: {error}"))?;
            if value.transcript_id != transcript_id || value.version != 1 {
                return Err("transcript segment identity does not match restore target".to_owned());
            }
            manifest = Some(value);
        } else if path == Path::new(ROLLOUT_PATH) {
            let bytes = read_archive_member(&mut entry, MAX_ROLLOUT_BYTES, "transcript rollout")?;
            rollout = Some(bytes);
        } else if let Ok(relative) = path.strip_prefix(WORKSPACE_PREFIX) {
            let destination = workspace.join(relative);
            let entry_type = entry.header().entry_type();
            if !entry_type.is_file() && !entry_type.is_dir() {
                return Err("transcript segment contains an unsupported workspace entry".to_owned());
            }
            if entry_type.is_file() {
                let size = entry.size();
                if size > MAX_WORKSPACE_FILE_BYTES {
                    return Err("transcript workspace member is too large".to_owned());
                }
                workspace_bytes = workspace_bytes
                    .checked_add(size)
                    .ok_or_else(|| "transcript workspace is too large".to_owned())?;
                if workspace_bytes > MAX_WORKSPACE_BYTES {
                    return Err("transcript workspace is too large".to_owned());
                }
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create workspace path: {error}"))?;
            }
            entry
                .unpack(&destination)
                .map_err(|error| format!("failed to restore workspace member: {error}"))?;
        }
    }
    Ok((
        manifest.ok_or_else(|| "transcript segment has no manifest".to_owned())?,
        rollout.ok_or_else(|| "transcript segment has no rollout".to_owned())?,
    ))
}

fn read_archive_member(
    reader: &mut impl Read,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {label}: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{label} is too large"));
    }
    Ok(bytes)
}

fn validate_jsonl(bytes: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "native transcript rollout is not UTF-8".to_owned())?;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        serde_json::from_str::<Value>(line)
            .map_err(|error| format!("native transcript rollout is invalid JSONL: {error}"))?;
    }
    Ok(())
}

fn rewrite_rollout(
    bytes: &[u8],
    source_thread_id: &str,
    thread_id: &str,
    source_workspace: &str,
    workspace: &Path,
) -> Result<Vec<u8>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "native transcript rollout is not UTF-8".to_owned())?;
    let mut output = String::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let mut value: Value = serde_json::from_str(line)
            .map_err(|error| format!("native transcript rollout is invalid JSONL: {error}"))?;
        replace_thread_id(&mut value, source_thread_id, thread_id);
        replace_workspace_paths(
            &mut value,
            source_workspace,
            workspace.to_string_lossy().as_ref(),
        );
        output.push_str(
            &serde_json::to_string(&value)
                .map_err(|error| format!("failed to rewrite native rollout: {error}"))?,
        );
        output.push('\n');
    }
    Ok(output.into_bytes())
}

fn replace_thread_id(value: &mut Value, source_thread_id: &str, thread_id: &str) {
    match value {
        Value::String(current) if current == source_thread_id => {
            *current = thread_id.to_owned();
        }
        Value::String(_) => {}
        Value::Array(values) => {
            for value in values {
                replace_thread_id(value, source_thread_id, thread_id);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                replace_thread_id(value, source_thread_id, thread_id);
            }
        }
        _ => {}
    }
}

fn restore_thread_state(
    database_path: &Path,
    manifest: &NativeTranscriptManifest,
    thread_id: &str,
    workspace: &Path,
    rollout_path: &Path,
) -> Result<(), String> {
    let mut connection = Connection::open(database_path)
        .map_err(|error| format!("failed to open Codex state database: {error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin Codex state restore: {error}"))?;
    let thread_columns = table_columns(&transaction, "threads")?;
    let mut thread = manifest.thread.clone();
    thread.insert("id".to_owned(), Value::String(thread_id.to_owned()));
    thread.insert(
        "cwd".to_owned(),
        Value::String(workspace.to_string_lossy().into_owned()),
    );
    thread.insert(
        "rollout_path".to_owned(),
        Value::String(rollout_path.to_string_lossy().into_owned()),
    );
    insert_row(&transaction, "threads", &thread_columns, &thread)?;
    let tool_columns = table_columns(&transaction, "thread_dynamic_tools")?;
    for tool in &manifest.thread_dynamic_tools {
        let mut tool = tool.clone();
        tool.insert("thread_id".to_owned(), Value::String(thread_id.to_owned()));
        insert_row(&transaction, "thread_dynamic_tools", &tool_columns, &tool)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit Codex state restore: {error}"))
}

fn replace_workspace_paths(value: &mut Value, source_workspace: &str, workspace: &str) {
    match value {
        Value::String(current) => {
            if current == source_workspace {
                *current = workspace.to_owned();
            } else if let Some(suffix) = current.strip_prefix(source_workspace) {
                if suffix.starts_with('/') || suffix.starts_with('\\') {
                    *current = format!("{workspace}{suffix}");
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                replace_workspace_paths(value, source_workspace, workspace);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                replace_workspace_paths(value, source_workspace, workspace);
            }
        }
        _ => {}
    }
}

fn table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("failed to inspect Codex state table: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("failed to query Codex state columns: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("failed to decode Codex state columns: {error}"))?;
    Ok(columns)
}

fn insert_row(
    connection: &Connection,
    table: &str,
    available_columns: &HashSet<String>,
    row: &Map<String, Value>,
) -> Result<(), String> {
    let columns = row
        .keys()
        .filter(|column| available_columns.contains(*column))
        .cloned()
        .collect::<Vec<_>>();
    let placeholders = std::iter::repeat("?")
        .take(columns.len())
        .collect::<Vec<_>>()
        .join(",");
    let values = columns
        .iter()
        .map(|column| json_to_sql_value(&row[column]))
        .collect::<Result<Vec<_>, _>>()?;
    connection
        .execute(
            &format!(
                "INSERT INTO {table} ({}) VALUES ({placeholders})",
                columns.join(",")
            ),
            rusqlite::params_from_iter(values),
        )
        .map_err(|error| format!("failed to restore Codex {table} row: {error}"))?;
    Ok(())
}

fn unused_thread_id(database_path: &Path, preferred: &str) -> Result<String, String> {
    let preferred = Uuid::parse_str(preferred)
        .map(|_| preferred.to_owned())
        .unwrap_or_else(|_| Uuid::new_v4().to_string());
    let connection = Connection::open(database_path)
        .map_err(|error| format!("failed to open Codex state database: {error}"))?;
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?)",
            params![&preferred],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("failed to inspect Codex thread identity: {error}"))?;
    Ok(if exists {
        Uuid::new_v4().to_string()
    } else {
        preferred
    })
}

fn canonical_rollout_path(codex_home: &Path, thread_id: &str) -> PathBuf {
    let timestamp = Utc::now();
    codex_home
        .join("sessions")
        .join(timestamp.format("%Y").to_string())
        .join(timestamp.format("%m").to_string())
        .join(timestamp.format("%d").to_string())
        .join(format!(
            "rollout-{}-{thread_id}.jsonl",
            timestamp.format("%Y-%m-%dT%H-%M-%S")
        ))
}

fn unused_workspace_path(transcript_id: &str) -> PathBuf {
    let safe_id = transcript_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let root = executor_home().join("restored-workspaces");
    let preferred = root.join(&safe_id);
    if !preferred.exists() {
        return preferred;
    }
    root.join(format!("{safe_id}-{}", Uuid::new_v4()))
}

fn codex_state_home(codex_home: &Path) -> PathBuf {
    env::var_os(CODEX_SQLITE_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| codex_home.to_path_buf())
}

fn unsafe_path(path: &Path) -> bool {
    path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
}

fn cleanup(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

struct CleanupGuard {
    path: Option<PathBuf>,
}

impl CleanupGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.as_deref() {
            cleanup(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};

    use super::*;

    fn git(path: &Path, args: &[&str]) -> std::process::Output {
        let mut command = Command::new("git");
        crate::local::native_git::clear_local_git_env(&mut command);
        command
            .current_dir(path)
            .args(args)
            .output()
            .expect("git should start")
    }

    fn assert_git(path: &Path, args: &[&str]) {
        let output = git(path, args);
        assert!(
            output.status.success(),
            "git -C {} {} failed: {}",
            path.display(),
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn environment_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    #[tokio::test]
    async fn workspace_packaging_excludes_gitignored_generated_files() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let workspace = root.path().join("workspace");
        let generated = source.join("wework/electron/resources/codex");
        fs::create_dir_all(&generated).unwrap();
        fs::create_dir_all(source.join("node_modules")).unwrap();
        fs::write(source.join("wework/electron/.gitignore"), "resources/\n").unwrap();
        fs::write(source.join("source.txt"), "source\n").unwrap();
        fs::write(generated.join("tracked.txt"), "tracked\n").unwrap();
        fs::write(
            source.join("node_modules/tracked.txt"),
            "tracked dependency\n",
        )
        .unwrap();
        assert_git(&source, &["init"]);
        assert_git(&source, &["config", "user.name", "Wegent Test"]);
        assert_git(&source, &["config", "user.email", "test@wegent.local"]);
        assert_git(
            &source,
            &["add", "source.txt", "wework/electron/.gitignore"],
        );
        assert_git(
            &source,
            &[
                "add",
                "-f",
                "node_modules/tracked.txt",
                "wework/electron/resources/codex/tracked.txt",
            ],
        );
        assert_git(&source, &["commit", "-m", "base"]);
        assert_git(
            &source,
            &[
                "worktree",
                "add",
                "--detach",
                workspace.to_str().expect("temporary path must be UTF-8"),
            ],
        );
        assert!(workspace.join(".git").is_file());
        fs::File::create(workspace.join("wework/electron/resources/codex/codex"))
            .unwrap()
            .set_len(MAX_WORKSPACE_FILE_BYTES + 1)
            .unwrap();

        let archive_path = root.path().join("workspace.tgz");
        let output = fs::File::create(&archive_path).unwrap();
        let encoder = GzEncoder::new(output, Compression::default());
        let mut archive = Builder::new(encoder);
        let paths = prepare_workspace_paths(&workspace).await.unwrap().unwrap();
        append_workspace(&mut archive, &workspace, Some(&paths), None).unwrap();
        archive.into_inner().unwrap().finish().unwrap();

        let input = fs::File::open(archive_path).unwrap();
        let mut restored = Archive::new(GzDecoder::new(input));
        let paths = restored
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().to_path_buf())
            .collect::<Vec<_>>();

        assert!(paths.contains(&PathBuf::from("workspace/source.txt")));
        assert!(paths.contains(&PathBuf::from("workspace/node_modules/tracked.txt")));
        assert!(paths.contains(&PathBuf::from("workspace/wework/electron/.gitignore")));
        assert!(paths.contains(&PathBuf::from(
            "workspace/wework/electron/resources/codex/tracked.txt"
        )));
        assert!(!paths
            .iter()
            .any(|path| path.ends_with("wework/electron/resources/codex/codex")));
    }

    #[tokio::test]
    async fn workspace_path_preparation_rejects_broken_git_metadata() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(workspace.join("generated")).unwrap();
        fs::write(workspace.join(".git"), "gitdir: missing\n").unwrap();
        fs::write(workspace.join(".gitignore"), "generated/\n").unwrap();
        fs::File::create(workspace.join("generated/oversized"))
            .unwrap()
            .set_len(MAX_WORKSPACE_FILE_BYTES + 1)
            .unwrap();

        let error = prepare_workspace_paths(&workspace)
            .await
            .expect_err("broken Git metadata must not fall back to unfiltered traversal");

        assert!(error.contains("failed to inspect workspace repository"));
    }

    #[test]
    fn packages_a_deleted_workspace_from_its_managed_git_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&source).unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.name", "Wegent Test"],
            vec!["config", "user.email", "test@wegent.local"],
        ] {
            assert_git(&source, &args);
        }
        fs::write(source.join("tracked.txt"), "base\n").unwrap();
        assert_git(&source, &["add", "."]);
        assert_git(&source, &["commit", "-m", "base"]);
        assert_git(
            &source,
            &[
                "worktree",
                "add",
                "--detach",
                workspace.to_str().expect("temporary path must be UTF-8"),
            ],
        );
        fs::write(workspace.join("tracked.txt"), "snapshot content\n").unwrap();
        fs::create_dir_all(workspace.join("node_modules/package")).unwrap();
        fs::write(
            workspace.join("node_modules/package/ignored.txt"),
            "ignored\n",
        )
        .unwrap();
        assert_git(&workspace, &["add", "-f", "."]);
        assert_git(&workspace, &["commit", "-m", "snapshot"]);
        let reference = String::from_utf8(git(&workspace, &["rev-parse", "HEAD"]).stdout)
            .unwrap()
            .trim()
            .to_owned();
        assert_git(
            &source,
            &[
                "worktree",
                "remove",
                "--force",
                workspace.to_str().expect("temporary path must be UTF-8"),
            ],
        );

        let archive_path = root.path().join("workspace.tgz");
        let output = fs::File::create(&archive_path).unwrap();
        let encoder = GzEncoder::new(output, Compression::default());
        let mut archive = Builder::new(encoder);
        append_workspace(
            &mut archive,
            &workspace,
            None,
            Some(&WorkspaceSnapshot {
                git_common_dir: source.join(".git"),
                reference,
            }),
        )
        .unwrap();
        archive.into_inner().unwrap().finish().unwrap();

        let input = fs::File::open(archive_path).unwrap();
        let mut restored = Archive::new(GzDecoder::new(input));
        let mut files = restored
            .entries()
            .unwrap()
            .map(|entry| {
                let mut entry = entry.unwrap();
                let path = entry.path().unwrap().to_path_buf();
                let mut content = String::new();
                if entry.header().entry_type().is_file() {
                    entry.read_to_string(&mut content).unwrap();
                }
                (path, content)
            })
            .collect::<Vec<_>>();
        files.sort_by(|left, right| left.0.cmp(&right.0));

        assert!(files.iter().any(|(path, content)| {
            path == Path::new("workspace/tracked.txt") && content == "snapshot content\n"
        }));
        assert!(!files
            .iter()
            .any(|(path, _)| path.starts_with("workspace/node_modules")));
    }

    #[test]
    fn snapshot_and_delta_restore_native_rollout_workspace_and_state() {
        let _guard = environment_lock();
        let root = tempfile::tempdir().unwrap();
        let executor_home = root.path().join("executor");
        let codex_home = executor_home.join("codex");
        let workspace = root.path().join("source-workspace");
        let rollout_path = codex_home.join("sessions/source.jsonl");
        let thread_id = "00000000-0000-4000-8000-000000000001";
        fs::create_dir_all(rollout_path.parent().unwrap()).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(workspace.join(".git")).unwrap();
        fs::write(workspace.join(".git/config"), "local git metadata").unwrap();
        fs::write(workspace.join("result.txt"), "snapshot").unwrap();
        fs::write(workspace.join("deleted-after-snapshot.txt"), "temporary").unwrap();
        fs::write(
            &rollout_path,
            format!(
                "{{\"ordinal\":0,\"timestamp\":\"2026-09-08T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{thread_id}\",\"cwd\":\"{}\",\"history_mode\":\"paginated\"}}}}\n",
                workspace.to_string_lossy()
            ),
        )
        .unwrap();
        let database_path = codex_home.join(STATE_DB_FILENAME);
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    cwd TEXT NOT NULL,
                    rollout_path TEXT NOT NULL,
                    title TEXT NOT NULL,
                    history_mode TEXT NOT NULL
                );
                CREATE TABLE thread_dynamic_tools (
                    thread_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    PRIMARY KEY (thread_id, position)
                );
                ",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads (id, cwd, rollout_path, title, history_mode) VALUES (?, ?, ?, ?, 'paginated')",
                params![
                    thread_id,
                    workspace.to_string_lossy(),
                    rollout_path.to_string_lossy(),
                    "Task"
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO thread_dynamic_tools (thread_id, position, name) VALUES (?, 0, ?)",
                params![thread_id, "tool-a"],
            )
            .unwrap();
        drop(connection);
        std::env::set_var("WEGENT_EXECUTOR_HOME", &executor_home);
        std::env::set_var("WEGENT_CODEX_HOME", &codex_home);
        std::env::set_var("CODEX_SQLITE_HOME", &codex_home);

        let snapshot = export_segment(ExportRequest {
            transcript_id: "transcript-1".to_owned(),
            task_id: "task-1".to_owned(),
            title: "Task".to_owned(),
            workspace_path: workspace.clone(),
            workspace_paths: None,
            workspace_snapshot: None,
            thread_id: thread_id.to_owned(),
            sequence: 1,
            base_sequence: 0,
            rollout_start: 0,
            snapshot: true,
            encryption_key: BASE64.encode([7_u8; 32]),
        })
        .unwrap();
        let snapshot_retry = export_segment(ExportRequest {
            transcript_id: "transcript-1".to_owned(),
            task_id: "task-1".to_owned(),
            title: "Task".to_owned(),
            workspace_path: workspace.clone(),
            workspace_paths: None,
            workspace_snapshot: None,
            thread_id: thread_id.to_owned(),
            sequence: 1,
            base_sequence: 0,
            rollout_start: 0,
            snapshot: true,
            encryption_key: BASE64.encode([7_u8; 32]),
        })
        .unwrap();
        assert_eq!(snapshot.sha256, snapshot_retry.sha256);
        assert_eq!(
            &fs::read(&snapshot.path).unwrap()[..ENCRYPTED_MAGIC.len()],
            ENCRYPTED_MAGIC
        );
        cleanup(&snapshot_retry.path);
        fs::write(workspace.join("result.txt"), "delta").unwrap();
        fs::remove_file(workspace.join("deleted-after-snapshot.txt")).unwrap();
        let mut rollout = fs::OpenOptions::new()
            .append(true)
            .open(&rollout_path)
            .unwrap();
        writeln!(
            rollout,
            "{{\"ordinal\":3,\"timestamp\":\"2026-09-08T00:00:01Z\",\"type\":\"response_item\",\"payload\":{{\"thread_id\":\"{thread_id}\"}}}}"
        )
        .unwrap();
        drop(rollout);
        let delta = export_segment(ExportRequest {
            transcript_id: "transcript-1".to_owned(),
            task_id: "task-1".to_owned(),
            title: "Task".to_owned(),
            workspace_path: workspace.clone(),
            workspace_paths: None,
            workspace_snapshot: None,
            thread_id: thread_id.to_owned(),
            sequence: 2,
            base_sequence: 1,
            rollout_start: snapshot.rollout_end,
            snapshot: false,
            encryption_key: BASE64.encode([7_u8; 32]),
        })
        .unwrap();
        let restored = restore_segments(
            "transcript-1",
            &[
                RestoreSegment {
                    path: snapshot.path,
                    sha256: snapshot.sha256,
                    sequence: 1,
                    format: snapshot.format,
                },
                RestoreSegment {
                    path: delta.path,
                    sha256: delta.sha256,
                    sequence: 2,
                    format: delta.format,
                },
            ],
            &BASE64.encode([7_u8; 32]),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(restored.workspace_path.join("result.txt")).unwrap(),
            "delta"
        );
        assert!(!restored.workspace_path.join(".git").exists());
        assert!(!restored
            .workspace_path
            .join("deleted-after-snapshot.txt")
            .exists());
        assert_eq!(restored.sequence, 2);
        assert_ne!(restored.thread_id, thread_id);
        let rollout_path = read_rows(&database_path, "threads", "id", &restored.thread_id).unwrap()
            [0]["rollout_path"]
            .as_str()
            .map(PathBuf::from)
            .unwrap();
        assert!(rollout_path.starts_with(codex_home.join("sessions")));
        assert!(rollout_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with("rollout-")
                    && name.ends_with(&format!("-{}.jsonl", restored.thread_id))
            }));
        let restored_rollout = fs::read_to_string(&rollout_path).unwrap();
        assert_eq!(restored.rollout_end, restored_rollout.len() as u64);
        assert!(restored_rollout.contains(&restored.thread_id));
        assert!(!restored_rollout.contains(thread_id));
        let connection = Connection::open(database_path).unwrap();
        let restored_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM threads WHERE id = ?",
                params![restored.thread_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(restored_count, 1);
        let restored_history_mode: String = connection
            .query_row(
                "SELECT history_mode FROM threads WHERE id = ?",
                params![restored.thread_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(restored_history_mode, "paginated");
        assert!(restored_rollout.contains("\"history_mode\":\"paginated\""));
        assert!(restored_rollout.contains(restored.workspace_path.to_string_lossy().as_ref()));
        let continued = export_segment(ExportRequest {
            transcript_id: "transcript-1".to_owned(),
            task_id: "task-1".to_owned(),
            title: "Task".to_owned(),
            workspace_path: restored.workspace_path.clone(),
            workspace_paths: None,
            workspace_snapshot: None,
            thread_id: restored.thread_id.clone(),
            sequence: 3,
            base_sequence: 2,
            rollout_start: restored.rollout_end,
            snapshot: false,
            encryption_key: BASE64.encode([7_u8; 32]),
        })
        .expect("restored rollout cursor should permit the next delta");
        cleanup(&continued.path);
        assert!(remove_restored_transcript(&restored.workspace_path, &restored.thread_id).unwrap());
        assert!(!restored.workspace_path.exists());
        assert!(!rollout_path.exists());
        let restored_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM threads WHERE id = ?",
                params![restored.thread_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(restored_count, 0);
        assert!(workspace.exists());
        assert!(executor_home
            .join("runtime-work/transcript-restore")
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true));
        std::env::remove_var("WEGENT_EXECUTOR_HOME");
        std::env::remove_var("WEGENT_CODEX_HOME");
        std::env::remove_var("CODEX_SQLITE_HOME");
    }

    #[test]
    fn rejects_files_larger_than_the_native_segment_limit_before_reading() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("oversized-segment");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_ENCRYPTED_SEGMENT_BYTES + 1).unwrap();

        let error = read_limited(&path, MAX_ENCRYPTED_SEGMENT_BYTES, "transcript segment")
            .expect_err("oversized segment should be rejected");

        assert!(error.contains("exceeds"));
    }

    #[test]
    fn refuses_to_remove_a_workspace_outside_the_managed_restore_directory() {
        let _guard = environment_lock();
        let root = tempfile::tempdir().unwrap();
        std::env::set_var("WEGENT_EXECUTOR_HOME", root.path().join("executor"));

        assert!(
            !remove_restored_transcript(&root.path().join("ordinary-workspace"), "thread-1")
                .unwrap()
        );
        std::env::remove_var("WEGENT_EXECUTOR_HOME");
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Offline, restartable provider identity migration. Never replay conversation
//! history or restore a stale copy of it: only the session metadata is changed.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};

use fs2::FileExt;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::file_lease::FileLease;

const JOURNAL: &str = ".wework-provider-migration.json";
const ROUTER: &str = super::codex_model_catalog::PROVIDER_ID;
const JOURNAL_VERSION: u32 = 3;

#[derive(Deserialize)]
struct RawEnvelope<'a> {
    #[serde(rename = "type")]
    kind: String,
    #[serde(borrow)]
    payload: &'a RawValue,
}

#[derive(Deserialize)]
struct RawMetadata<'a> {
    id: String,
    #[serde(borrow)]
    model_provider: &'a RawValue,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    complete: bool,
    pending_from: usize,
    entries: Vec<Entry>,
    #[serde(default)]
    index_routes: BTreeMap<String, BTreeMap<String, BTreeSet<String>>>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: PathBuf,
    thread_id: String,
    provider: String,
    provider_raw: String,
    before_sha256: String,
    after_sha256: String,
}

fn metadata_hash(header: &str) -> String {
    format!("{:x}", Sha256::digest(header.as_bytes()))
}

fn parse_metadata(header: &str) -> Result<RawMetadata<'_>, String> {
    let envelope: RawEnvelope<'_> = serde_json::from_str(header).map_err(error)?;
    if envelope.kind != "session_meta" {
        return Err("Invalid Codex migration metadata identity".into());
    }
    serde_json::from_str(envelope.payload.get()).map_err(error)
}

fn plan_entry(path: PathBuf, before: &str) -> Result<Entry, String> {
    let metadata = parse_metadata(before)?;
    let raw = metadata.model_provider.get();
    let entry = Entry {
        path,
        thread_id: metadata.id,
        provider: serde_json::from_str(raw).map_err(error)?,
        provider_raw: raw.to_owned(),
        before_sha256: metadata_hash(before),
        after_sha256: metadata_hash(&rewrite_metadata(before)?),
    };
    validate_entry(&entry)?;
    Ok(entry)
}

#[path = "provider_migration_journal.rs"]
mod journal;

/// Must be held until publication completes. This is Codex's own coordination
/// namespace, so both native writers and its compression publisher are excluded.
fn acquire_writers(
    home: &Path,
    wait_for_writers: bool,
    checkpoint: &mut impl FnMut(Phase) -> Result<(), String>,
) -> Result<FileLease, String> {
    let directory = home.join("thread-writer-locks");
    reject_link(&directory)?;
    fs::create_dir_all(&directory).map_err(error)?;
    loop {
        let coordination = lock(&directory.join(".coordination.lock"), wait_for_writers)?;
        let Some(writer) = busy_writer(&directory)? else {
            return Ok(coordination);
        };
        if !wait_for_writers {
            return Err("Codex provider migration is blocked by a live writer".into());
        }
        // Native WriterLockGuard::drop needs coordination before closing its
        // thread file. Never wait for that file while retaining coordination.
        drop(coordination);
        checkpoint(Phase::WaitingForWriter)?;
        FileExt::lock_exclusive(&writer).map_err(error)?;
        drop(writer);
        // The old lock may have been unlinked. Recheck all current inodes under
        // coordination before admitting publication, not just the waited file.
    }
}

fn busy_writer(directory: &Path) -> Result<Option<File>, String> {
    for entry in fs::read_dir(&directory).map_err(error)? {
        let path = entry.map_err(error)?.path();
        if path.file_name().and_then(|s| s.to_str()) == Some(".coordination.lock") {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) == Some("lock") {
            // Coordination prevents new owners while existing owners are probed.
            let file = open_writer_lock(&path)?;
            match file.try_lock_exclusive() {
                Ok(()) => {}
                Err(e) if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                    return Ok(Some(file))
                }
                Err(e) => return Err(error(e)),
            }
        }
    }
    Ok(None)
}

fn lock(path: &Path, wait_for_writers: bool) -> Result<FileLease, String> {
    let file = open_writer_lock(path)?;
    (if wait_for_writers {
        FileExt::lock_exclusive(&file)
    } else {
        file.try_lock_exclusive()
    })
    .map_err(|_| "Codex provider migration is blocked by a live writer".to_owned())?;
    Ok(FileLease(file))
}

fn open_writer_lock(path: &Path) -> Result<File, String> {
    reject_link(path)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(error)
}

/// Called only under the Home's exclusive process lease, before app-server is
/// spawned. Errors deliberately prevent native startup and automatic Goal resume.
pub(super) fn migrate(home: &Path) -> Result<(), String> {
    migrate_with_checkpoint(home, &mut |_| Ok(()))
}

pub(super) fn migrate_stopped(home: &Path, wait_for_writers: bool) -> Result<(), String> {
    migrate_owned(home, &mut |_| Ok(()), wait_for_writers)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    WaitingForWriter,
    JournalPublished,
    RolloutPublished(usize),
    DatabaseCommitted(usize),
}

fn migrate_with_checkpoint(
    home: &Path,
    checkpoint: &mut impl FnMut(Phase) -> Result<(), String>,
) -> Result<(), String> {
    migrate_owned(home, checkpoint, false)
}

fn migrate_owned(
    home: &Path,
    checkpoint: &mut impl FnMut(Phase) -> Result<(), String>,
    wait_for_writers: bool,
) -> Result<(), String> {
    let _writers = acquire_writers(home, wait_for_writers, checkpoint)?;
    let journal_path = home.join(JOURNAL);
    reject_link(&journal_path)?;
    let (mut journal, compacted) = journal::load(&journal_path)?;
    if journal.version != JOURNAL_VERSION {
        return Err("Unsupported Codex provider migration journal version".into());
    }
    if compacted {
        save(&journal_path, &journal)?;
        checkpoint(Phase::JournalPublished)?;
    }
    if !journal.complete {
        let pending = journal
            .entries
            .get(journal.pending_from..)
            .ok_or("Invalid Codex migration cursor")?;
        let threads = affected_threads(pending)?;
        if record_index_routes(home, &mut journal, &threads)? {
            save(&journal_path, &journal)?;
        }
        apply(home, &journal, checkpoint)?;
    }
    let mut paths = Vec::new();
    for root in ["sessions", "archived_sessions"] {
        collect(&home.join(root), &mut paths)?;
    }
    let mut additions = Vec::new();
    let mut present_threads = BTreeSet::new();
    for path in paths {
        let mut reader = reader(&path)?;
        // An unpublished empty rollout has no provider or history to convert.
        // Keep native metadata-readiness recovery responsible for it. Pending
        // journal entries still require their exact header in apply().
        if reader.fill_buf().map_err(error)?.is_empty() {
            continue;
        }
        let before = first_line(&mut reader)?;
        let meta: Value = serde_json::from_str(&before).map_err(error)?;
        if meta["type"] != "session_meta" {
            return Err("Codex rollout does not start with session metadata".into());
        }
        let thread_id = meta["payload"]["id"]
            .as_str()
            .ok_or("Codex session metadata has no thread identity")?
            .to_owned();
        uuid::Uuid::parse_str(&thread_id).map_err(error)?;
        present_threads.insert(thread_id.clone());
        let provider = match &meta["payload"]["model_provider"] {
            // Native resume uses the requested/current provider when older
            // metadata has no saved selection. Do not insert a new field.
            Value::Null => continue,
            Value::String(s) if !s.is_empty() => s,
            _ => return Err("Invalid Codex session model provider".into()),
        }
        .to_owned();
        if provider == ROUTER {
            continue;
        }
        if journal
            .entries
            .iter()
            .any(|entry| entry.path == path.strip_prefix(home).unwrap())
        {
            return Err("Previously migrated Codex rollout changed provider unexpectedly".into());
        }
        additions.push(plan_entry(
            path.strip_prefix(home).map_err(error)?.into(),
            &before,
        )?);
    }
    if !additions.is_empty() {
        journal.pending_from = journal.entries.len();
        journal.entries.extend(additions);
        journal.complete = false;
        record_index_routes(home, &mut journal, &present_threads)?;
        // Persist the complete plan before changing any rollout or database.
        save(&journal_path, &journal)?;
        checkpoint(Phase::JournalPublished)?;
        apply(home, &journal, checkpoint)?;
    }
    // Older Codex can continue migrated rollouts, but its resume writes the
    // selected legacy provider back to SQLite without changing session_meta.
    // Reconcile derived indexes even when the migration journal is complete.
    if record_index_routes(home, &mut journal, &present_threads)? {
        save(&journal_path, &journal)?;
    }
    reconcile_indexes(home, &present_threads)?;
    if !journal.complete {
        journal.complete = true;
        save(&journal_path, &journal)?;
    }
    Ok(())
}

fn reconcile_indexes(home: &Path, threads: &BTreeSet<String>) -> Result<(), String> {
    if threads.is_empty() {
        return Ok(());
    }
    for mut database in databases(home)? {
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        for id in threads {
            transaction
                .execute(
                    "UPDATE threads SET model_provider=?1 WHERE id=?2 AND model_provider IS NOT ?1",
                    (ROUTER, id),
                )
                .map_err(error)?;
        }
        transaction.commit().map_err(error)?;
    }
    Ok(())
}

fn apply(
    home: &Path,
    journal: &Journal,
    checkpoint: &mut impl FnMut(Phase) -> Result<(), String>,
) -> Result<(), String> {
    let entries = journal
        .entries
        .get(journal.pending_from..)
        .ok_or("Invalid Codex provider migration journal cursor")?;
    let threads = affected_threads(entries)?;
    if entries.is_empty() {
        return Ok(());
    }
    for entry in entries {
        let path = checked_path(home, &entry.path)?;
        let current = first_line(&mut reader(&path)?)?;
        checked_rewrite(entry, &current)?;
    }
    let mut databases = databases(home)?;
    let transactions = databases
        .iter_mut()
        .map(|database| {
            database
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)
        })
        .collect::<Result<Vec<_>, _>>()?;
    for (index, entry) in entries.iter().enumerate() {
        let path = checked_path(home, &entry.path)?;
        let mut input = reader(&path)?;
        let current = first_line(&mut input)?;
        if let Some(after) = checked_rewrite(entry, &current)? {
            replace_metadata(&path, &after, input)?;
            checkpoint(Phase::RolloutPublished(index))?;
        }
    }
    for (index, transaction) in transactions.into_iter().enumerate() {
        for thread_id in &threads {
            transaction
                .execute(
                    "UPDATE threads SET model_provider=?1 WHERE id=?2 AND model_provider IS NOT ?1",
                    (ROUTER, thread_id),
                )
                .map_err(error)?;
        }
        transaction.commit().map_err(error)?;
        checkpoint(Phase::DatabaseCommitted(index))?;
    }
    Ok(())
}

fn affected_threads(entries: &[Entry]) -> Result<BTreeSet<String>, String> {
    let mut threads = BTreeSet::new();
    for entry in entries {
        validate_entry(entry)?;
        threads.insert(entry.thread_id.clone());
    }
    Ok(threads)
}

fn validate_entry(entry: &Entry) -> Result<(), String> {
    uuid::Uuid::parse_str(&entry.thread_id).map_err(error)?;
    let provider: String = serde_json::from_str(&entry.provider_raw).map_err(error)?;
    if provider.is_empty() || provider != entry.provider {
        return Err("Invalid Codex migration original provider".into());
    }
    for hash in [&entry.before_sha256, &entry.after_sha256] {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid Codex migration metadata digest".into());
        }
    }
    let mut components = entry.path.components();
    if !components.next().is_some_and(|part| {
        matches!(part,
        std::path::Component::Normal(name) if name == "sessions" || name == "archived_sessions")
    }) {
        return Err("Invalid Codex migration storage root".into());
    }
    let name = entry
        .path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if !name.starts_with("rollout-") || !(name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
    {
        return Err("Invalid Codex migration rollout name".into());
    }
    Ok(())
}

fn checked_rewrite(entry: &Entry, current: &str) -> Result<Option<String>, String> {
    let metadata = parse_metadata(current)?;
    if metadata.id != entry.thread_id {
        return Err("Invalid Codex migration metadata identity".into());
    }
    let hash = metadata_hash(current);
    let raw = metadata.model_provider.get();
    if hash == entry.before_sha256 && raw == entry.provider_raw {
        let after = rewrite_metadata(current)?;
        if metadata_hash(&after) == entry.after_sha256 {
            return Ok(Some(after));
        }
    } else if hash == entry.after_sha256 && raw == serde_json::to_string(ROUTER).map_err(error)? {
        let start = (raw.as_ptr() as usize)
            .checked_sub(current.as_ptr() as usize)
            .ok_or("Invalid Codex provider metadata span")?;
        let end = start
            .checked_add(entry.provider_raw.len())
            .ok_or("Invalid Codex metadata range")?;
        let padding = entry
            .provider_raw
            .len()
            .checked_sub(raw.len())
            .ok_or("Invalid Codex provider metadata padding")?;
        if current.get(start..end) == Some(format!("{raw}{}", " ".repeat(padding)).as_str()) {
            let original = format!(
                "{}{}{}",
                &current[..start],
                entry.provider_raw,
                &current[end..]
            );
            if metadata_hash(&original) == entry.before_sha256 {
                return Ok(None);
            }
        }
    } else {
        return Err("Codex rollout changed during provider migration".into());
    }
    Err("Codex migration may only change the provider identity".into())
}

/// Preserve every byte position, including cursors into inherited/compacted
/// history. Only the raw provider value is replaced; unused bytes become JSON
/// whitespace. Re-serializing the rest could also change unknown numeric or
/// Unicode encodings, so the original envelope is retained verbatim.
fn rewrite_metadata(before: &str) -> Result<String, String> {
    let metadata = parse_metadata(before)?;
    let raw = metadata.model_provider.get();
    let original: String = serde_json::from_str(raw).map_err(error)?;
    if original.is_empty() {
        return Err("Empty legacy Codex provider cannot be migrated losslessly".into());
    }
    let replacement = serde_json::to_string(ROUTER).map_err(error)?;
    let padding = raw
        .len()
        .checked_sub(replacement.len())
        .ok_or("Codex provider migration would move history byte offsets")?;
    let start = (raw.as_ptr() as usize)
        .checked_sub(before.as_ptr() as usize)
        .ok_or("Codex metadata does not borrow its original bytes")?;
    let end = start
        .checked_add(raw.len())
        .ok_or("Invalid Codex metadata range")?;
    if before.get(start..end) != Some(raw) {
        return Err("Invalid Codex provider metadata span".into());
    }
    Ok(format!(
        "{}{}{}{}",
        &before[..start],
        replacement,
        " ".repeat(padding),
        &before[end..]
    ))
}

fn databases(home: &Path) -> Result<Vec<Connection>, String> {
    let mut databases = Vec::new();
    for entry in fs::read_dir(home).map_err(error)? {
        let path = entry.map_err(error)?.path();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let Some(version) = name
            .strip_prefix("state_")
            .and_then(|s| s.strip_suffix(".sqlite"))
        else {
            continue;
        };
        if version.is_empty() || !version.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        reject_link(&path)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(suffix);
            reject_link(Path::new(&sidecar))?;
        }
        let connection =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(error)?;
        let integrity: String = connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(error)?;
        if integrity != "ok" {
            return Err("Codex state database integrity check failed".into());
        }
        // Unknown or damaged schemas must fail closed, never create a new database.
        connection
            .prepare("SELECT id, model_provider FROM threads LIMIT 0")
            .map_err(error)?;
        databases.push(connection);
    }
    Ok(databases)
}

fn record_index_routes(
    home: &Path,
    journal: &mut Journal,
    threads: &BTreeSet<String>,
) -> Result<bool, String> {
    let mut changed = false;
    if threads.is_empty() {
        return Ok(false);
    }
    for connection in databases(home)? {
        let name = Path::new(connection.path().ok_or("Codex index has no path")?)
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid Codex index name")?
            .to_owned();
        for id in threads {
            let provider: Option<String> = connection
                .query_row(
                    "SELECT model_provider FROM threads WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(error)?;
            if let Some(provider) = provider {
                changed |= journal
                    .index_routes
                    .entry(name.clone())
                    .or_default()
                    .entry(id.clone())
                    .or_default()
                    .insert(provider);
            }
        }
    }
    Ok(changed)
}

fn collect(directory: &Path, paths: &mut Vec<PathBuf>) -> Result<(), String> {
    reject_link(directory)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(error(e)),
    };
    for entry in entries {
        let entry = entry.map_err(error)?;
        let path = entry.path();
        let kind = entry.file_type().map_err(error)?;
        if kind.is_symlink() {
            return Err("Symlink found in Codex rollout storage; migration stopped".into());
        }
        if kind.is_dir() {
            collect(&path, paths)?;
        } else if kind.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("rollout-")
                && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
            {
                paths.push(path);
            }
        }
    }
    Ok(())
}

fn checked_path(home: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Invalid Codex provider migration path".into());
    }
    let mut relative = relative.to_owned();
    let mut path = home.join(&relative);
    if !path.try_exists().map_err(error)? {
        // Compatible rollback may materialize a compressed rollout for append.
        // Keep the logical rollout and all appended turns, not its old encoding.
        let alternate = if relative.extension().and_then(|s| s.to_str()) == Some("zst") {
            relative.with_extension("")
        } else {
            let mut name = relative.as_os_str().to_os_string();
            name.push(".zst");
            PathBuf::from(name)
        };
        if home.join(&alternate).try_exists().map_err(error)? {
            relative = alternate;
            path = home.join(&relative);
        }
    }
    let canonical = fs::canonicalize(&path).map_err(error)?;
    if canonical != fs::canonicalize(home).map_err(error)?.join(&relative) {
        return Err("Codex provider migration path escapes its Home".into());
    }
    Ok(path)
}

fn reject_link(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err("Symlink is not allowed in Codex provider migration".into())
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(error(e)),
    }
}

fn reader(path: &Path) -> Result<Box<dyn BufRead>, String> {
    reject_link(path)?;
    let file = File::open(path).map_err(error)?;
    if path.extension().and_then(|s| s.to_str()) == Some("zst") {
        Ok(Box::new(BufReader::new(
            zstd::stream::read::Decoder::new(file).map_err(error)?,
        )))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

fn first_line(reader: &mut dyn BufRead) -> Result<String, String> {
    let mut line = String::new();
    // Only metadata is buffered; large histories are streamed without replay.
    reader
        .take(16 * 1024 * 1024)
        .read_line(&mut line)
        .map_err(error)?;
    if !line.ends_with('\n') {
        return Err("Incomplete or oversized Codex session metadata".into());
    }
    Ok(line)
}

fn replace_metadata(
    path: &Path,
    metadata: &str,
    mut input: Box<dyn BufRead>,
) -> Result<(), String> {
    // tempfile's Windows publication calls Win32 directly. Match the shared
    // JSON publisher: retain the canonical verbatim prefix for long Homes.
    let parent =
        fs::canonicalize(path.parent().ok_or("Codex rollout has no parent")?).map_err(error)?;
    let target = parent.join(path.file_name().ok_or("Codex rollout has no file name")?);
    let original = fs::metadata(path).map_err(error)?;
    let mut output = tempfile::NamedTempFile::new_in(&parent).map_err(error)?;
    output
        .as_file()
        .set_permissions(original.permissions())
        .map_err(error)?;
    if path.extension().and_then(|s| s.to_str()) == Some("zst") {
        let mut encoder =
            zstd::stream::write::Encoder::new(output.as_file_mut(), 3).map_err(error)?;
        encoder.write_all(metadata.as_bytes()).map_err(error)?;
        std::io::copy(&mut input, &mut encoder).map_err(error)?;
        encoder.finish().map_err(error)?;
    } else {
        output.write_all(metadata.as_bytes()).map_err(error)?;
        std::io::copy(&mut input, &mut output).map_err(error)?;
    }
    // Preserve recency and archive order as well as permissions and identity.
    output
        .as_file()
        .set_times(fs::FileTimes::new().set_modified(original.modified().map_err(error)?))
        .map_err(error)?;
    output.as_file().sync_all().map_err(error)?;
    drop(input);
    output.persist(target).map_err(|e| error(e.error))?;
    sync_directory(&parent)
}

fn save(path: &Path, journal: &Journal) -> Result<(), String> {
    wegent_filesystem::json_file::write_json_file(path, journal)?;
    sync_directory(path.parent().ok_or("Codex journal has no parent")?)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(error)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn error(e: impl std::fmt::Display) -> String {
    format!("Codex provider migration failed: {e}")
}

#[cfg(test)]
#[path = "provider_migration_tests.rs"]
mod tests;

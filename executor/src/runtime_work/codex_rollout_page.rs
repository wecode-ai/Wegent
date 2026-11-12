// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Retain offsets, not a second in-memory copy of every historical item.
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::local::app_ipc::AppIpcError;

use super::{
    codex_transcript_page::{CodexTranscriptDirection, CodexTranscriptError, CodexTranscriptPage},
    transcript_work::{self, Cancellation},
    util::{item_type, string_field},
};

const PREFIX: &str = "wework-rollout-items:";
const ITEM_LIMIT: usize = 100;
const PAGE_BYTES: usize = 2 * 1024 * 1024;
const INDEX_LIMIT: usize = 8;

struct ItemOffset {
    offset: u64,
    position: u64,
    turn: usize,
}

#[derive(Default)]
struct Index {
    length: u64,
    items: Vec<ItemOffset>,
    turns: Vec<Value>,
    turn_ids: HashMap<String, usize>,
    context_usage: Option<Value>,
    item_ids: HashMap<(usize, String), usize>,
    identity: Option<FileIdentity>,
    modified: Option<SystemTime>,
    observed_length: u64,
    content_hash: Sha256,
    versions: Vec<SourceVersion>,
}

#[derive(PartialEq, Serialize)]
struct FileIdentity {
    created: Option<SystemTime>,
    native: Option<(u64, u64)>,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
struct SourceVersion {
    source: String,
    length: u64,
    digest: String,
}

#[derive(Deserialize, Serialize)]
struct RolloutCursor {
    version: SourceVersion,
    position: usize,
}

fn content_digest(hash: &Sha256) -> String {
    format!("{:x}", hash.clone().finalize())
}

fn remember_version(index: &mut Index, version: &SourceVersion) {
    if index.versions.contains(version) {
        return;
    }
    if index.versions.len() >= INDEX_LIMIT {
        index.versions.remove(0);
    }
    index.versions.push(version.clone());
}

fn decode_cursor(cursor: &str) -> Result<RolloutCursor, AppIpcError> {
    cursor
        .strip_prefix(PREFIX)
        .and_then(|value| serde_json::from_str::<RolloutCursor>(value).ok())
        .ok_or_else(|| failed("Invalid or expired rollout item cursor"))
}

fn encode_cursor(version: &SourceVersion, position: usize) -> String {
    format!("{PREFIX}{}", json!({"version":version,"position":position}))
}

fn file_identity(metadata: &std::fs::Metadata) -> FileIdentity {
    #[cfg(unix)]
    let native = {
        use std::os::unix::fs::MetadataExt;
        Some((metadata.dev(), metadata.ino()))
    };
    #[cfg(not(unix))]
    let native = None;
    FileIdentity {
        created: metadata.created().ok(),
        native,
    }
}

fn indexes() -> &'static Mutex<HashMap<PathBuf, Index>> {
    static INDEXES: OnceLock<Mutex<HashMap<PathBuf, Index>>> = OnceLock::new();
    INDEXES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn is_cursor(cursor: &str) -> bool {
    cursor.starts_with(PREFIX)
}

pub(super) async fn load(
    thread: Value,
    cursor: Option<String>,
    direction: CodexTranscriptDirection,
) -> Result<Option<CodexTranscriptPage>, CodexTranscriptError> {
    let Some(path) = string_field(&thread, "path") else {
        return Ok(None);
    };
    transcript_work::run(move |cancellation| {
        read_page(
            thread,
            PathBuf::from(path),
            cursor.as_deref(),
            direction,
            cancellation,
        )
    })
    .await
    .map_err(Into::into)
}

fn read_page(
    mut thread: Value,
    path: PathBuf,
    cursor: Option<&str>,
    direction: CodexTranscriptDirection,
    cancellation: &Cancellation,
) -> Result<Option<CodexTranscriptPage>, AppIpcError> {
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failed(error)),
    };
    let metadata = file.metadata().map_err(failed)?;
    let length = metadata.len();
    let identity = file_identity(&metadata);
    let modified = metadata.modified().ok();
    let source = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&identity).map_err(failed)?)
    );
    let cursor = cursor.map(decode_cursor).transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.version.source != source)
    {
        return Err(failed("Invalid or expired rollout item cursor"));
    }
    let mut indexes = indexes()
        .lock()
        .map_err(|_| failed("Rollout index lock is poisoned"))?;
    if !indexes.contains_key(&path) && indexes.len() >= INDEX_LIMIT {
        indexes.clear();
    }
    let index = indexes.entry(path).or_default();
    if index.identity.as_ref() != Some(&identity)
        || length < index.length
        || (length == index.observed_length && modified != index.modified)
        || cursor.as_ref().is_some_and(|cursor| {
            !index.versions.contains(&cursor.version)
                && (cursor.version.length != index.length
                    || cursor.version.digest != content_digest(&index.content_hash))
        })
    {
        *index = Index::default();
        index.identity = Some(identity);
    }
    index.modified = modified;
    index.observed_length = length;
    let mut reader = BufReader::new(file);
    let validation = cursor
        .as_ref()
        .map(|cursor| &cursor.version)
        .filter(|version| !index.versions.contains(version));
    if let Err(error) = update_index(index, &mut reader, validation, cancellation) {
        *index = Index::default();
        return Err(error);
    }
    let version = SourceVersion {
        source,
        length: index.length,
        digest: content_digest(&index.content_hash),
    };
    if let Some(cursor) = &cursor {
        remember_version(index, &cursor.version);
    }
    remember_version(index, &version);
    let ascending = direction == CodexTranscriptDirection::Ascending;
    let boundary = cursor
        .map(|cursor| {
            Some(cursor.position)
                .filter(|offset| *offset <= index.items.len())
                .ok_or_else(|| failed("Invalid or expired rollout item cursor"))
        })
        .transpose()?
        .unwrap_or(if ascending { 0 } else { index.items.len() });
    let mut position = boundary;
    let mut bytes = 0;
    let mut entries = Vec::new();
    while entries.len() < ITEM_LIMIT
        && if ascending {
            position < index.items.len()
        } else {
            position > 0
        }
    {
        cancellation.check()?;
        let at = if ascending { position } else { position - 1 };
        let item_offset = &index.items[at];
        reader
            .seek(SeekFrom::Start(item_offset.offset))
            .map_err(failed)?;
        let mut line = String::new();
        reader.read_line(&mut line).map_err(failed)?;
        let mut record: Value = serde_json::from_str(&line).map_err(failed)?;
        let mut item = record["payload"]["item"].take();
        let size = serde_json::to_vec(&item).map_err(failed)?.len();
        if !entries.is_empty() && bytes + size > PAGE_BYTES {
            break;
        }
        bytes += size;
        item["position"] = json!(item_offset.position);
        entries.push((item_offset.turn, item));
        position = if ascending {
            position + 1
        } else {
            position - 1
        };
    }
    if !ascending {
        entries.reverse();
    }
    let mut turns = Vec::<Value>::new();
    let mut positions = HashMap::new();
    for (turn_index, item) in entries {
        let at = *positions.entry(turn_index).or_insert_with(|| {
            let mut turn = index.turns[turn_index].clone();
            turn["items"] = json!([]);
            turn["itemsView"] = json!("summary");
            turn["ownsUserPresentation"] = json!(false);
            turn["position"] = item["position"].clone();
            turns.push(turn);
            turns.len() - 1
        });
        if item_type(&item) == "usermessage" {
            turns[at]["ownsUserPresentation"] = json!(true);
        }
        turns[at]["items"].as_array_mut().unwrap().push(item);
    }
    thread["turns"] = Value::Array(turns);
    thread["timeline"] = json!(true);
    thread["rolloutContextIndexed"] = json!(true);
    if let Some(usage) = &index.context_usage {
        thread["tokenUsage"] = usage.clone();
    }
    let before_cursor = (!ascending && position > 0).then(|| encode_cursor(&version, position));
    let after_cursor =
        (ascending && position < index.items.len()).then(|| encode_cursor(&version, position));
    Ok(Some(CodexTranscriptPage {
        thread,
        before_cursor,
        after_cursor,
    }))
}

fn update_index(
    index: &mut Index,
    reader: &mut BufReader<File>,
    validation: Option<&SourceVersion>,
    cancellation: &Cancellation,
) -> Result<(), AppIpcError> {
    let mut verified = validation.is_none()
        || validation.is_some_and(|version| {
            version.length == index.length && version.digest == content_digest(&index.content_hash)
        });
    reader.seek(SeekFrom::Start(index.length)).map_err(failed)?;
    loop {
        cancellation.check()?;
        let offset = reader.stream_position().map_err(failed)?;
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(failed)? == 0 {
            break;
        }
        if line.trim().is_empty() {
            hash_record(
                index,
                offset,
                &line,
                validation,
                &mut verified,
                cancellation,
            )?;
            index.length = reader.stream_position().map_err(failed)?;
            continue;
        }
        // A complete final JSON record is valid even without a trailing newline.
        let mut record: Value = match serde_json::from_str(&line) {
            Ok(record) => record,
            Err(error) if !line.ends_with('\n') && error.is_eof() => break,
            Err(error) => return Err(failed(error)),
        };
        hash_record(
            index,
            offset,
            &line,
            validation,
            &mut verified,
            cancellation,
        )?;
        if let Some(usage) = super::codex_rollout::record_context_usage(&record) {
            index.context_usage = Some(usage);
        }
        if record["type"] == "event_msg" {
            let payload = &mut record["payload"];
            if let Some(turn_id) =
                string_field(payload, "turn_id").or_else(|| string_field(payload, "turnId"))
            {
                let turn_index = *index.turn_ids.entry(turn_id.clone()).or_insert_with(|| {
                    index
                        .turns
                        .push(json!({"id":turn_id,"status":"inProgress"}));
                    index.turns.len() - 1
                });
                let turn = &mut index.turns[turn_index];
                match payload["type"].as_str() {
                    Some("item_completed") if payload["item"].is_object() => {
                        if let Some(id) = string_field(&payload["item"], "id") {
                            let key = (turn_index, id);
                            if let Some(existing) = index.item_ids.get(&key) {
                                index.items[*existing].offset = offset;
                            } else {
                                index.item_ids.insert(key, index.items.len());
                                index.items.push(ItemOffset {
                                    offset,
                                    position: offset,
                                    turn: turn_index,
                                });
                            }
                        } else {
                            index.items.push(ItemOffset {
                                offset,
                                position: offset,
                                turn: turn_index,
                            });
                        }
                    }
                    Some("task_started" | "turn_started") => {
                        if let Some(started) = payload["started_at"].as_i64() {
                            turn["startedAt"] = json!(started.saturating_mul(1000));
                        }
                    }
                    Some("task_complete" | "turn_complete") => {
                        turn["status"] = json!("completed");
                        turn["timelineCompleted"] = json!(true);
                        if let Some(completed) = payload["completed_at"].as_i64() {
                            turn["completedAt"] = json!(completed.saturating_mul(1000));
                        }
                        if let Some(duration) = payload["duration_ms"].as_i64() {
                            turn["durationMs"] = json!(duration);
                        }
                    }
                    Some("turn_aborted") => {
                        turn["status"] = json!("interrupted");
                    }
                    _ => {}
                }
            }
        }
        index.length = reader.stream_position().map_err(failed)?;
    }
    if !verified {
        return Err(failed("Invalid or expired rollout item cursor"));
    }
    Ok(())
}

fn hash_record(
    index: &mut Index,
    offset: u64,
    line: &str,
    validation: Option<&SourceVersion>,
    verified: &mut bool,
    cancellation: &Cancellation,
) -> Result<(), AppIpcError> {
    let mut consumed = 0;
    for chunk in line.as_bytes().chunks(64 * 1024) {
        cancellation.check()?;
        if let Some(version) = validation.filter(|_| !*verified) {
            let start = offset + consumed as u64;
            if version.length >= start && version.length <= start + chunk.len() as u64 {
                let at = (version.length - start) as usize;
                index.content_hash.update(&chunk[..at]);
                if content_digest(&index.content_hash) != version.digest {
                    return Err(failed("Invalid or expired rollout item cursor"));
                }
                *verified = true;
                index.content_hash.update(&chunk[at..]);
                consumed += chunk.len();
                continue;
            }
        }
        index.content_hash.update(chunk);
        consumed += chunk.len();
    }
    Ok(())
}

fn failed(error: impl std::fmt::Display) -> AppIpcError {
    AppIpcError::new(
        "codex_error",
        format!("Cannot read rollout history: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, io::Write};

    fn read_fixture_page(
        thread: Value,
        cursor: Option<String>,
        direction: CodexTranscriptDirection,
    ) -> Result<Option<CodexTranscriptPage>, AppIpcError> {
        let path = PathBuf::from(thread["path"].as_str().unwrap());
        read_page(
            thread,
            path,
            cursor.as_deref(),
            direction,
            &Cancellation::new(),
        )
    }

    fn write_item(file: &mut File, id: usize, text: &str) {
        writeln!(
            file,
            "{}",
            json!({"type":"event_msg","payload":{
                "type":"item_completed","turn_id":"long-turn",
                "item":{"id":format!("item-{id}"),"type":"AgentMessage","text":text}
            }})
        )
        .unwrap();
    }

    #[test]
    fn seven_thousand_items_in_one_turn_page_losslessly_and_keep_append_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        for item in 0..7_001 {
            write_item(&mut file, item, &format!("完整正文🙂-{item}"));
        }
        file.flush().unwrap();
        let thread = json!({"id":"thread-1","path":path});
        let mut cursor = None;
        let mut seen = HashSet::new();
        let mut pages = 0;
        loop {
            let page =
                read_fixture_page(thread.clone(), cursor, CodexTranscriptDirection::Descending)
                    .unwrap()
                    .unwrap();
            let items = page.thread["turns"][0]["items"].as_array().unwrap();
            assert!(items.len() <= ITEM_LIMIT);
            assert!(items
                .windows(2)
                .all(|items| items[0]["position"].as_u64() < items[1]["position"].as_u64()));
            for item in items {
                let id = item["id"].as_str().unwrap();
                assert!(seen.insert(id.to_owned()), "duplicate {id}");
                let number: usize = id.strip_prefix("item-").unwrap().parse().unwrap();
                assert_eq!(item["text"], format!("完整正文🙂-{number}"));
            }
            pages += 1;
            if pages == 1 {
                // A continuation is a stable older boundary even while the writer appends.
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&path)
                    .unwrap();
                write_item(&mut file, 7_001, "newer");
            }
            cursor = page.before_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(pages, 71);
        assert_eq!(seen.len(), 7_001);
        assert!(!seen.contains("item-7001"));
        let newest = read_fixture_page(thread, None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        assert_eq!(
            newest.thread["turns"][0]["items"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["id"],
            "item-7001"
        );
    }

    #[test]
    fn byte_budget_never_discards_an_indivisible_large_item() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        let text = "文".repeat(PAGE_BYTES / 2);
        write_item(&mut file, 0, "older");
        write_item(&mut file, 1, &text);
        write_item(&mut file, 2, "newer");
        drop(file);
        let thread = json!({"id":"thread-1","path":path});
        let first = read_fixture_page(thread.clone(), None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        assert_eq!(
            first.thread["turns"][0]["items"].as_array().unwrap().len(),
            1
        );
        let large = read_fixture_page(
            thread.clone(),
            first.before_cursor,
            CodexTranscriptDirection::Descending,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            large.thread["turns"][0]["items"].as_array().unwrap().len(),
            1
        );
        assert_eq!(large.thread["turns"][0]["items"][0]["text"], text);
        let oldest = read_fixture_page(
            thread,
            large.before_cursor,
            CodexTranscriptDirection::Descending,
        )
        .unwrap()
        .unwrap();
        assert_eq!(oldest.thread["turns"][0]["items"][0]["id"], "item-0");
        assert!(oldest.before_cursor.is_none());
    }

    #[test]
    fn an_unterminated_complete_record_is_visible_and_an_incomplete_tail_is_revisited() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        let record = |index| {
            json!({"type":"event_msg","payload":{
            "type":"item_completed","turn_id":"turn","item":{"id":format!("item-{index}"),"type":"AgentMessage","text":"正文"}
        }}).to_string()
        };
        std::fs::write(&path, record(0)).unwrap();
        let thread = json!({"id":"thread","path":path});
        let first = read_fixture_page(thread.clone(), None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        assert_eq!(first.thread["turns"][0]["items"][0]["id"], "item-0");
        let next = record(1);
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writer
            .write_all(format!("\n{}", &next[..30]).as_bytes())
            .unwrap();
        writer.flush().unwrap();
        let partial = read_fixture_page(thread.clone(), None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        assert_eq!(
            partial.thread["turns"][0]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        writer
            .write_all(format!("{}\n", &next[30..]).as_bytes())
            .unwrap();
        writer.flush().unwrap();
        let complete = read_fixture_page(thread, None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        assert_eq!(
            complete.thread["turns"][0]["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn repeated_completed_items_keep_the_latest_body_at_the_first_logical_position() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        for item in 0..151 {
            write_item(&mut file, item, "old");
        }
        file.flush().unwrap();
        let thread = json!({"id":"thread","path":path});
        let first = read_fixture_page(thread.clone(), None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        write_item(&mut file, 0, "latest revision");
        file.flush().unwrap();
        let older = read_fixture_page(
            thread.clone(),
            first.before_cursor,
            CodexTranscriptDirection::Descending,
        )
        .unwrap()
        .unwrap();
        let items = older.thread["turns"][0]["items"].as_array().unwrap();
        assert_eq!(items.len(), 51);
        assert_eq!(items[0]["id"], "item-0");
        assert_eq!(items[0]["text"], "latest revision");
        assert!(items
            .windows(2)
            .all(|items| items[0]["position"].as_u64() < items[1]["position"].as_u64()));
        assert!(older.before_cursor.is_none());
        let refreshed = read_fixture_page(thread, None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        assert_eq!(
            refreshed.thread["turns"][0]["items"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["id"],
            "item-150"
        );
    }

    #[test]
    fn cursors_survive_index_eviction_with_and_without_appended_records() {
        for append in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("rollout.jsonl");
            let mut file = File::create(&path).unwrap();
            for item in 0..151 {
                write_item(&mut file, item, "original");
            }
            file.flush().unwrap();
            let thread = json!({"id":"thread","path":path});
            let first =
                read_fixture_page(thread.clone(), None, CodexTranscriptDirection::Descending)
                    .unwrap()
                    .unwrap();
            if append {
                write_item(&mut file, 151, "appended after the cursor was issued");
                file.flush().unwrap();
            }
            // Real reads of more than the bounded cache capacity evict this source.
            for source in 0..INDEX_LIMIT {
                let other = directory.path().join(format!("other-{source}.jsonl"));
                write_item(&mut File::create(&other).unwrap(), 0, "other source");
                read_fixture_page(
                    json!({"id":format!("other-{source}"),"path":other}),
                    None,
                    CodexTranscriptDirection::Descending,
                )
                .unwrap()
                .unwrap();
            }
            // A fresh newest-page read may rebuild a different appended version
            // before the user resumes an older pane's persisted boundary.
            let newest =
                read_fixture_page(thread.clone(), None, CodexTranscriptDirection::Descending)
                    .unwrap()
                    .unwrap();
            assert_eq!(
                newest.thread["turns"][0]["items"]
                    .as_array()
                    .unwrap()
                    .last()
                    .unwrap()["id"],
                if append { "item-151" } else { "item-150" }
            );
            let older = read_fixture_page(
                thread,
                first.before_cursor,
                CodexTranscriptDirection::Descending,
            )
            .unwrap()
            .unwrap();
            let items = older.thread["turns"][0]["items"].as_array().unwrap();
            assert_eq!(items.len(), 51);
            for (position, item) in items.iter().enumerate() {
                assert_eq!(item["id"], format!("item-{position}"));
                assert_eq!(item["text"], "original");
            }
            assert!(older.before_cursor.is_none());
        }
    }

    #[test]
    fn rebuilding_an_index_verifies_the_full_prefix_and_rejects_same_length_rewrites() {
        for rebuild in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("rollout.jsonl");
            let mut file = File::create(&path).unwrap();
            for item in 0..151 {
                write_item(&mut file, item, &format!("original-body-{item:03}"));
            }
            file.flush().unwrap();
            let thread = json!({"id":"thread","path":path});
            let first =
                read_fixture_page(thread.clone(), None, CodexTranscriptDirection::Descending)
                    .unwrap()
                    .unwrap();
            let before = std::fs::metadata(&path).unwrap();
            let contents = std::fs::read_to_string(&path).unwrap();
            let at = contents.find("original-body-075").unwrap();
            let mut writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            writer.seek(SeekFrom::Start(at as u64)).unwrap();
            writer.write_all(b"modified-body-075").unwrap();
            writer.flush().unwrap();
            writer
                .set_modified(before.modified().unwrap() + std::time::Duration::from_secs(1))
                .unwrap();
            assert_eq!(before.len(), writer.metadata().unwrap().len());
            assert!(file_identity(&before) == file_identity(&writer.metadata().unwrap()));
            if rebuild {
                // Reconstructing from no retained state also covers executor restart.
                indexes().lock().unwrap().remove(&path);
            }
            let error = read_fixture_page(
                thread,
                first.before_cursor,
                CodexTranscriptDirection::Descending,
            )
            .err()
            .unwrap();
            assert!(error.message.contains("expired"));
        }
    }

    #[test]
    fn rebuilding_after_a_partial_tail_completes_keeps_the_old_committed_prefix() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        for item in 0..151 {
            write_item(&mut file, item, "original");
        }
        file.write_all(b"{\"type\":\"event_msg\",").unwrap();
        file.flush().unwrap();
        let thread = json!({"id":"thread","path":path});
        let first = read_fixture_page(thread.clone(), None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        file.write_all(b"\"payload\":{\"type\":\"item_completed\",\"turn_id\":\"long-turn\",\"item\":{\"id\":\"late-item\",\"type\":\"AgentMessage\",\"text\":\"late\"}}}\n").unwrap();
        file.flush().unwrap();
        indexes().lock().unwrap().remove(&path);
        let older = read_fixture_page(
            thread,
            first.before_cursor,
            CodexTranscriptDirection::Descending,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            older.thread["turns"][0]["items"].as_array().unwrap().len(),
            51
        );
        assert_eq!(older.thread["turns"][0]["items"][0]["id"], "item-0");
        assert!(older.before_cursor.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_rollout_invalidates_its_generation_and_old_page_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        for item in 0..151 {
            write_item(&mut file, item, "old");
        }
        file.flush().unwrap();
        let thread = json!({"id":"thread","path":path});
        let first = read_fixture_page(thread.clone(), None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        let replacement = directory.path().join("replacement.jsonl");
        let mut file = File::create(&replacement).unwrap();
        for item in 0..201 {
            write_item(&mut file, item, "replacement");
        }
        drop(file);
        std::fs::rename(replacement, &path).unwrap();
        let error = read_fixture_page(
            thread.clone(),
            first.before_cursor,
            CodexTranscriptDirection::Descending,
        )
        .err()
        .unwrap();
        assert!(error.message.contains("expired"));
        let latest = read_fixture_page(thread, None, CodexTranscriptDirection::Descending)
            .unwrap()
            .unwrap();
        assert_eq!(
            latest.thread["turns"][0]["items"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["id"],
            "item-200"
        );
    }
}

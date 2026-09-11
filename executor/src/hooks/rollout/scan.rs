// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{self, BufRead, BufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::{parser::Parser, store::Store};

/// Records consumed per file per pass, so one busy rollout cannot stall a scan.
const MAX_RECORDS_PER_PASS: usize = 512;

#[derive(Default)]
pub(super) struct ScanOutcome {
    pub files: usize,
    pub unresolved: usize,
    pub errors: usize,
    pub reports: usize,
}

enum State {
    Resolved,
    Unresolved,
}

pub(super) fn scan(
    store: &mut Store,
    home: &Path,
    enabled: bool,
    startup: &BTreeSet<PathBuf>,
) -> Result<ScanOutcome, String> {
    let mut paths = Vec::new();
    collect_paths(&home.join("sessions"), &mut paths)?;
    collect_paths(&home.join("archived_sessions"), &mut paths)?;
    paths.sort();
    paths.dedup();

    let mut outcome = ScanOutcome::default();
    // Sessions are resolved from the root outwards; repeat discovery so
    // arbitrarily nested subagent rollouts resolve whatever the order.
    let mut remaining = paths;
    loop {
        let before = remaining.len();
        let mut unresolved = Vec::new();
        for path in remaining {
            match scan_file(store, &path, enabled, startup) {
                Ok((State::Resolved, reports)) => {
                    outcome.files += 1;
                    outcome.reports += reports;
                }
                Ok((State::Unresolved, _)) => unresolved.push(path),
                Err(error) => {
                    outcome.errors += 1;
                    eprintln!("codex rollout scan failed for {}: {error}", path.display());
                }
            }
        }
        if unresolved.is_empty() || unresolved.len() == before {
            outcome.unresolved = unresolved.len();
            break;
        }
        remaining = unresolved;
    }
    Ok(outcome)
}

pub(super) fn collect_paths(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            collect_paths(&entry.path(), paths)?;
        } else if kind.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                paths.push(entry.path());
            }
        }
    }
    Ok(())
}

fn scan_file(
    store: &mut Store,
    path: &Path,
    enabled: bool,
    startup: &BTreeSet<PathBuf>,
) -> Result<(State, usize), String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    let cursor = store.cursor(path)?;
    let has_cursor = cursor.is_some();
    let mut offset = cursor.as_ref().map_or(0, |(offset, _)| *offset);
    let mut parser = cursor.map_or_else(Parser::default, |(_, parser)| parser);
    if offset > 0 && offset == size {
        return Ok((State::Resolved, 0));
    }

    let mut reader = BufReader::new(file);
    let Some(header) = read_header(&mut reader)? else {
        // Codex has not flushed (or is still rewriting) the session header.
        return Ok((State::Unresolved, 0));
    };
    let Some(thread) = resolve_thread(store, &header)? else {
        return Ok((State::Unresolved, 0));
    };
    let header_end = header.end;

    if !has_cursor {
        // Rollouts that predate this observer are history: resume at the end.
        // Rollouts created while running start right after the session header,
        // which also skips the forked history Codex replays into subagents.
        offset = if startup.contains(path) {
            size
        } else {
            header_end
        };
        parser = Parser::default();
        store.set_cursor(path, offset, &parser)?;
    } else if size < offset {
        // Truncated or rotated: replay from the header again, keyed duplicates
        // are absorbed by the report dedup key.
        offset = header_end.min(size);
        parser = Parser::default();
    }
    if offset >= size {
        return Ok((State::Resolved, 0));
    }

    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut reports = 0;
    let mut line = String::new();
    for _ in 0..MAX_RECORDS_PER_PASS {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if bytes == 0 || !line.ends_with('\n') {
            break;
        }
        let record: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        offset += bytes as u64;
        reports += store.consume(path, offset, &thread, &mut parser, &record, enabled)?;
    }
    Ok((State::Resolved, reports))
}

struct RolloutHeader {
    session_id: String,
    cwd: Option<String>,
    git_url: Option<String>,
    parent: Option<String>,
    end: u64,
}

fn read_header(reader: &mut BufReader<File>) -> Result<Option<RolloutHeader>, String> {
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    if line.trim().is_empty() || !line.ends_with('\n') {
        return Ok(None);
    }
    let record: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if record["type"] != "session_meta" {
        return Err("rollout does not start with session_meta".to_owned());
    }
    let meta = &record["payload"];
    let session_id = meta["id"]
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or("session_meta has no session id")?
        .to_owned();
    Ok(Some(RolloutHeader {
        session_id,
        cwd: meta["cwd"].as_str().map(ToOwned::to_owned),
        git_url: meta
            .pointer("/git/repository_url")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        parent: rollout_parent_thread_id(meta),
        end: line.len() as u64,
    }))
}

fn resolve_thread(
    store: &mut Store,
    header: &RolloutHeader,
) -> Result<Option<super::store::ThreadRow>, String> {
    if store.thread(&header.session_id)?.is_none() {
        // Only subagent rollouts can be adopted; a thread we never started and
        // that has no parent link is not ours to report.
        let Some(parent) = header.parent.as_deref() else {
            return Ok(None);
        };
        if !store.bind_child(&header.session_id, parent)? {
            return Ok(None);
        }
    }
    store.enrich_thread(
        &header.session_id,
        header.cwd.as_deref(),
        header.git_url.as_deref(),
    )?;
    store.thread(&header.session_id)
}

/// Subagent rollouts link to their parent thread either at the top level (all
/// current versions) or inside the nested session source (0.149 era).
fn rollout_parent_thread_id(meta: &Value) -> Option<String> {
    let candidate = meta
        .get("parent_thread_id")
        .and_then(Value::as_str)
        .or_else(|| {
            meta.pointer("/source/subagent/thread_spawn/parent_thread_id")
                .and_then(Value::as_str)
        })?;
    let candidate = candidate.trim();
    (!candidate.is_empty()).then(|| candidate.to_owned())
}

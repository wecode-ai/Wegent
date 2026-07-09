// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

use serde_json::Value;

use super::util::now_ms;

const RUNNING_TRANSCRIPT_CACHE_TTL_MS: i64 = 1_200;
const COMPLETED_TRANSCRIPT_CACHE_TTL_MS: i64 = 60_000;

#[derive(Clone, Default)]
pub(crate) struct TranscriptCache {
    entries: Arc<Mutex<HashMap<String, CachedTranscript>>>,
}

#[derive(Clone)]
pub(crate) struct CachedTranscript {
    pub workspace_path: String,
    pub runtime: String,
    pub messages: Vec<Value>,
    pub context_usage: Option<Value>,
    pub running: bool,
    pub source_signature: Option<TranscriptSourceSignature>,
    pub rollout_turns: Option<Vec<Value>>,
    cached_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TranscriptSourceSignature {
    path: String,
    len: u64,
    modified_ms: i64,
}

impl CachedTranscript {
    pub fn new(
        workspace_path: String,
        runtime: String,
        messages: Vec<Value>,
        running: bool,
        source_signature: Option<TranscriptSourceSignature>,
    ) -> Self {
        Self {
            workspace_path,
            runtime,
            messages,
            context_usage: None,
            running,
            source_signature,
            rollout_turns: None,
            cached_at: now_ms(),
        }
    }

    pub fn with_context_usage(mut self, context_usage: Option<Value>) -> Self {
        self.context_usage = context_usage;
        self
    }

    pub fn with_rollout_turns(mut self, turns: Option<Vec<Value>>) -> Self {
        self.rollout_turns = turns;
        self
    }
}

impl TranscriptSourceSignature {
    pub fn from_path(path: &str) -> Option<Self> {
        let metadata = fs::metadata(path).ok()?;
        if !path_has_complete_tail(path, metadata.len())? {
            return None;
        }
        let modified_ms = metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis();
        let modified_ms = i64::try_from(modified_ms).ok()?;
        Some(Self {
            path: path.to_owned(),
            len: metadata.len(),
            modified_ms,
        })
    }

    fn is_current(&self) -> bool {
        Self::from_path(&self.path).as_ref() == Some(self)
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn len(&self) -> u64 {
        self.len
    }
}

impl TranscriptCache {
    pub fn get(
        &self,
        key: &str,
        running_hint: bool,
        require_current_source: bool,
    ) -> Option<CachedTranscript> {
        let mut entries = self.entries.lock().ok()?;
        let entry = entries.get(key)?;
        if require_current_source {
            let is_current = entry
                .source_signature
                .as_ref()
                .is_some_and(TranscriptSourceSignature::is_current);
            if !is_current {
                entries.remove(key);
                return None;
            }
            return Some(entry.clone());
        }
        let ttl = if running_hint || entry.running {
            RUNNING_TRANSCRIPT_CACHE_TTL_MS
        } else {
            COMPLETED_TRANSCRIPT_CACHE_TTL_MS
        };
        if now_ms().saturating_sub(entry.cached_at) > ttl {
            entries.remove(key);
            return None;
        }
        Some(entry.clone())
    }

    pub fn peek(&self, key: &str) -> Option<CachedTranscript> {
        let entries = self.entries.lock().ok()?;
        entries.get(key).cloned()
    }

    pub fn insert(&self, key: impl Into<String>, transcript: CachedTranscript) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(key.into(), transcript);
        }
    }

    pub fn invalidate(&self, key: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(key);
        }
    }
}

fn path_has_complete_tail(path: &str, len: u64) -> Option<bool> {
    if len == 0 {
        return Some(true);
    }
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(len.saturating_sub(1))).ok()?;
    let mut byte = [0_u8; 1];
    file.read_exact(&mut byte).ok()?;
    Some(byte[0] == b'\n')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_signature_requires_complete_jsonl_tail() {
        let path = temp_path("partial-tail");
        fs::write(&path, r#"{"type":"event"}"#).unwrap();

        let signature = TranscriptSourceSignature::from_path(&path.display().to_string());

        assert!(signature.is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn source_signature_accepts_newline_terminated_jsonl_tail() {
        let path = temp_path("complete-tail");
        fs::write(&path, "{\"type\":\"event\"}\n").unwrap();

        let signature = TranscriptSourceSignature::from_path(&path.display().to_string());

        assert!(signature.is_some());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn refresh_cache_misses_entries_without_current_source_signature() {
        let cache = TranscriptCache::default();
        cache.insert(
            "thread-1",
            CachedTranscript::new(
                "/tmp/project".to_owned(),
                "codex".to_owned(),
                Vec::new(),
                true,
                None,
            ),
        );

        assert!(cache.get("thread-1", true, true).is_none());
        assert!(cache.peek("thread-1").is_none());
    }

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "wegent-transcript-cache-{label}-{}-{}.jsonl",
            std::process::id(),
            now_ms()
        ))
    }
}

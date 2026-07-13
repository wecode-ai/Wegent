// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

use serde_json::Value;

use super::util::now_ms;

const RUNNING_TRANSCRIPT_CACHE_TTL_MS: i64 = 1_200;
const COMPLETED_TRANSCRIPT_CACHE_TTL_MS: i64 = 60_000;
const MAX_TRANSCRIPT_CACHE_ENTRIES: usize = 8;

#[derive(Clone, Default)]
pub(crate) struct TranscriptCache {
    state: Arc<Mutex<TranscriptCacheState>>,
}

#[derive(Default)]
struct TranscriptCacheState {
    entries: HashMap<String, CachedTranscript>,
    lru: VecDeque<String>,
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
        let mut state = self.state.lock().ok()?;
        remove_expired_entries(&mut state);
        let entry = state.entries.get(key)?;
        if require_current_source {
            let is_current = entry
                .source_signature
                .as_ref()
                .is_some_and(TranscriptSourceSignature::is_current);
            if !is_current {
                remove_entry(&mut state, key);
                return None;
            }
            let entry = entry.clone();
            touch_entry(&mut state, key);
            return Some(entry);
        }
        let ttl = if running_hint || entry.running {
            RUNNING_TRANSCRIPT_CACHE_TTL_MS
        } else {
            COMPLETED_TRANSCRIPT_CACHE_TTL_MS
        };
        if now_ms().saturating_sub(entry.cached_at) > ttl {
            remove_entry(&mut state, key);
            return None;
        }
        let entry = entry.clone();
        touch_entry(&mut state, key);
        Some(entry)
    }

    pub fn peek(&self, key: &str) -> Option<CachedTranscript> {
        let mut state = self.state.lock().ok()?;
        remove_expired_entries(&mut state);
        let entry = state.entries.get(key)?.clone();
        touch_entry(&mut state, key);
        Some(entry)
    }

    pub fn insert(&self, key: impl Into<String>, transcript: CachedTranscript) {
        if let Ok(mut state) = self.state.lock() {
            remove_expired_entries(&mut state);
            let key = key.into();
            state.entries.insert(key.clone(), transcript);
            touch_entry(&mut state, &key);
            while state.entries.len() > MAX_TRANSCRIPT_CACHE_ENTRIES {
                let Some(oldest_key) = state.lru.pop_front() else {
                    break;
                };
                state.entries.remove(&oldest_key);
            }
        }
    }

    pub fn invalidate(&self, key: &str) {
        if let Ok(mut state) = self.state.lock() {
            remove_entry(&mut state, key);
        }
    }
}

fn remove_expired_entries(state: &mut TranscriptCacheState) {
    let timestamp = now_ms();
    let expired = state
        .entries
        .iter()
        .filter_map(|(key, entry)| {
            let ttl = if entry.running {
                RUNNING_TRANSCRIPT_CACHE_TTL_MS
            } else {
                COMPLETED_TRANSCRIPT_CACHE_TTL_MS
            };
            (timestamp.saturating_sub(entry.cached_at) > ttl).then(|| key.clone())
        })
        .collect::<Vec<_>>();
    for key in expired {
        remove_entry(state, &key);
    }
}

fn touch_entry(state: &mut TranscriptCacheState, key: &str) {
    state.lru.retain(|candidate| candidate != key);
    state.lru.push_back(key.to_owned());
}

fn remove_entry(state: &mut TranscriptCacheState, key: &str) {
    state.entries.remove(key);
    state.lru.retain(|candidate| candidate != key);
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

    #[test]
    fn cache_evicts_least_recently_used_entries() {
        let cache = TranscriptCache::default();
        for index in 0..MAX_TRANSCRIPT_CACHE_ENTRIES {
            cache.insert(
                format!("thread-{index}"),
                cached_transcript(format!("message-{index}")),
            );
        }
        assert!(cache.get("thread-0", false, false).is_some());

        cache.insert("thread-new", cached_transcript("new".to_owned()));

        assert!(cache.peek("thread-0").is_some());
        assert!(cache.peek("thread-1").is_none());
        assert!(cache.peek("thread-new").is_some());
    }

    fn cached_transcript(message: String) -> CachedTranscript {
        CachedTranscript::new(
            "/tmp/project".to_owned(),
            "codex".to_owned(),
            vec![Value::String(message)],
            false,
            None,
        )
    }

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "wegent-transcript-cache-{label}-{}-{}.jsonl",
            std::process::id(),
            now_ms()
        ))
    }
}

use std::{
    collections::VecDeque,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};

const MAX_HISTORY_ENTRIES: usize = 5000;
const HISTORY_FILE_NAME: &str = "browser-history.json";

static HISTORY_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserHistoryEntry {
    pub id: String,
    pub url: String,
    pub title: Option<String>,
    pub visit_time_ms: i64,
}

#[derive(Default)]
pub struct EmbeddedBrowserHistoryStore {
    // Entries are ordered by ascending visit time; the newest visit is last.
    entries: VecDeque<EmbeddedBrowserHistoryEntry>,
    loaded: bool,
}

impl EmbeddedBrowserHistoryStore {
    pub fn record_visit(&mut self, url: &str, visit_time_ms: i64, title: Option<String>) {
        let id = format!(
            "history-{}-{}",
            visit_time_ms,
            HISTORY_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let title = title.filter(|value| !value.is_empty());
        self.entries.push_back(EmbeddedBrowserHistoryEntry {
            id,
            url: url.to_string(),
            title,
            visit_time_ms,
        });
        while self.entries.len() > MAX_HISTORY_ENTRIES {
            self.entries.pop_front();
        }
    }

    pub fn backfill_title(&mut self, url: &str, title: &str) {
        if title.is_empty() {
            return;
        }
        if let Some(entry) = self
            .entries
            .iter_mut()
            .rev()
            .find(|entry| entry.url == url && entry.title.is_none())
        {
            entry.title = Some(title.to_string());
        }
    }

    pub fn search(
        &self,
        text: &str,
        end_time_ms: Option<i64>,
        offset: usize,
        max_results: usize,
    ) -> Vec<EmbeddedBrowserHistoryEntry> {
        let needle = text.trim().to_lowercase();
        self.entries
            .iter()
            .rev()
            .filter(|entry| end_time_ms.map_or(true, |end| entry.visit_time_ms < end))
            .filter(|entry| {
                needle.is_empty()
                    || entry.url.to_lowercase().contains(&needle)
                    || entry
                        .title
                        .as_deref()
                        .is_some_and(|title| title.to_lowercase().contains(&needle))
            })
            .skip(offset)
            .take(max_results)
            .cloned()
            .collect()
    }

    pub fn remove(&mut self, ids: &[String]) -> usize {
        let before = self.entries.len();
        self.entries
            .retain(|entry| !ids.iter().any(|id| id == &entry.id));
        before - self.entries.len()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    // Marks the store as not loaded so the next access re-reads the persisted
    // file; used to recover when clearing in memory succeeded but persisting
    // the empty state failed.
    pub fn mark_unloaded(&mut self) {
        self.loaded = false;
    }

    pub fn load(&mut self, path: &PathBuf) -> Result<(), String> {
        if self.loaded {
            return Ok(());
        }
        self.loaded = true;
        let Ok(raw) = fs::read_to_string(path) else {
            return Ok(());
        };
        let mut entries: Vec<EmbeddedBrowserHistoryEntry> = serde_json::from_str(&raw)
            .map_err(|error| format!("Failed to parse browser history file: {error}"))?;
        entries.sort_by_key(|entry| entry.visit_time_ms);
        if entries.len() > MAX_HISTORY_ENTRIES {
            entries.drain(..entries.len() - MAX_HISTORY_ENTRIES);
        }
        self.entries = entries.into_iter().collect();
        Ok(())
    }

    pub fn persist(&self, path: &PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create browser history directory: {error}"))?;
        }
        let raw = serde_json::to_string(&self.entries.iter().collect::<Vec<_>>())
            .map_err(|error| format!("Failed to serialize browser history: {error}"))?;
        let temporary_path = path.with_extension("json.tmp");
        fs::write(&temporary_path, raw)
            .map_err(|error| format!("Failed to write browser history file: {error}"))?;
        fs::rename(&temporary_path, path)
            .map_err(|error| format!("Failed to persist browser history file: {error}"))?;
        Ok(())
    }
}

pub fn history_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|path| path.join(HISTORY_FILE_NAME))
        .map_err(|error| format!("Failed to locate browser history file: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visit(store: &mut EmbeddedBrowserHistoryStore, url: &str, visit_time_ms: i64) {
        store.record_visit(url, visit_time_ms, None);
    }

    #[test]
    fn records_visit_with_title_and_drops_empty_titles() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        store.record_visit("https://a.example", 1000, Some("Example".to_string()));
        store.record_visit("https://b.example", 2000, Some(String::new()));
        let results = store.search("", None, 0, 100);
        assert_eq!(results[0].title, None);
        assert_eq!(results[1].title.as_deref(), Some("Example"));
    }

    #[test]
    fn titled_entries_are_not_backfilled_again() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        store.record_visit("https://a.example", 1000, Some("Example".to_string()));
        store.backfill_title("https://a.example", "Other");
        assert_eq!(
            store.search("", None, 0, 100)[0].title.as_deref(),
            Some("Example")
        );
    }

    #[test]
    fn records_visits_in_ascending_order() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        visit(&mut store, "https://a.example", 1000);
        visit(&mut store, "https://b.example", 2000);
        let results = store.search("", None, 0, 100);
        assert_eq!(results[0].url, "https://b.example");
        assert_eq!(results[1].url, "https://a.example");
    }

    #[test]
    fn backfills_title_on_latest_untitled_entry() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        visit(&mut store, "https://a.example", 1000);
        visit(&mut store, "https://a.example", 2000);
        store.backfill_title("https://a.example", "Example A");
        let results = store.search("", None, 0, 100);
        assert_eq!(results[0].title.as_deref(), Some("Example A"));
        assert_eq!(results[1].title, None);
    }

    #[test]
    fn ignores_empty_title_backfill() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        visit(&mut store, "https://a.example", 1000);
        store.backfill_title("https://a.example", "");
        assert_eq!(store.search("", None, 0, 100)[0].title, None);
    }

    #[test]
    fn search_matches_url_and_title_case_insensitively() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        visit(&mut store, "https://Docs.Example/rust", 1000);
        store.backfill_title("https://Docs.Example/rust", "Rust Book");
        visit(&mut store, "https://other.example", 2000);
        assert_eq!(store.search("docs.example", None, 0, 100).len(), 1);
        assert_eq!(store.search("RUST", None, 0, 100).len(), 1);
        assert_eq!(store.search("missing", None, 0, 100).len(), 0);
        assert_eq!(store.search("  ", None, 0, 100).len(), 2);
    }

    #[test]
    fn paginates_with_end_time_and_offset() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        for index in 0..5 {
            let url = format!("https://a.example/{index}");
            visit(&mut store, &url, 1000 * (index + 1));
        }
        let first_page = store.search("", None, 0, 2);
        assert_eq!(first_page[0].visit_time_ms, 5000);
        assert_eq!(first_page[1].visit_time_ms, 4000);
        let cursor = first_page.last().unwrap().visit_time_ms + 1;
        // The offset only counts previously returned entries with visitTime < cursor.
        let second_page = store.search("", Some(cursor), 1, 2);
        assert_eq!(second_page[0].visit_time_ms, 3000);
        assert_eq!(second_page[1].visit_time_ms, 2000);
        let third_page = store.search("", Some(2001), 1, 2);
        assert_eq!(third_page[0].visit_time_ms, 1000);
    }

    #[test]
    fn offset_skips_entries_sharing_the_cursor_millisecond() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        visit(&mut store, "https://a.example/1", 1000);
        visit(&mut store, "https://a.example/2", 1000);
        visit(&mut store, "https://a.example/3", 1000);
        let first_page = store.search("", None, 0, 2);
        assert_eq!(first_page[0].url, "https://a.example/3");
        assert_eq!(first_page[1].url, "https://a.example/2");
        let second_page = store.search("", Some(1001), 2, 2);
        assert_eq!(second_page.len(), 1);
        assert_eq!(second_page[0].url, "https://a.example/1");
    }

    #[test]
    fn removes_entries_by_id() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        visit(&mut store, "https://a.example", 1000);
        visit(&mut store, "https://a.example", 2000);
        // Same URL in the same millisecond: only the targeted id is removed.
        visit(&mut store, "https://a.example", 1000);
        let target_id = store.entries[0].id.clone();
        let other_same_millis_id = store.entries[2].id.clone();
        let removed = store.remove(&[target_id.clone()]);
        assert_eq!(removed, 1);
        let results = store.search("", None, 0, 100);
        assert_eq!(results.len(), 2);
        let remaining_ids: Vec<&str> = results.iter().map(|entry| entry.id.as_str()).collect();
        assert!(!remaining_ids.contains(&target_id.as_str()));
        assert!(remaining_ids.contains(&other_same_millis_id.as_str()));
    }

    #[test]
    fn clear_removes_all_entries() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        visit(&mut store, "https://a.example", 1000);
        store.clear();
        assert!(store.search("", None, 0, 100).is_empty());
    }

    #[test]
    fn evicts_oldest_entries_beyond_capacity() {
        let mut store = EmbeddedBrowserHistoryStore::default();
        for index in 0..MAX_HISTORY_ENTRIES + 10 {
            visit(&mut store, "https://a.example", index as i64);
        }
        assert_eq!(store.entries.len(), MAX_HISTORY_ENTRIES);
        assert_eq!(store.entries.front().unwrap().visit_time_ms, 10);
    }

    #[test]
    fn persists_and_loads_entries() {
        let directory = std::env::temp_dir().join(format!(
            "wework-browser-history-test-{}",
            std::process::id()
        ));
        let path = directory.join("browser-history.json");
        let _ = fs::remove_dir_all(&directory);
        let mut store = EmbeddedBrowserHistoryStore::default();
        visit(&mut store, "https://a.example", 2000);
        visit(&mut store, "https://b.example", 1000);
        store.backfill_title("https://a.example", "Example A");
        store.persist(&path).unwrap();
        let mut restored = EmbeddedBrowserHistoryStore::default();
        restored.load(&path).unwrap();
        let results = restored.search("", None, 0, 100);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://a.example");
        assert_eq!(results[0].title.as_deref(), Some("Example A"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn load_is_idempotent_and_tolerates_missing_file() {
        let path = std::env::temp_dir().join("wework-browser-history-missing.json");
        let mut store = EmbeddedBrowserHistoryStore::default();
        store.load(&path).unwrap();
        store.record_visit("https://a.example", 1000, None);
        store.load(&path).unwrap();
        assert_eq!(store.search("", None, 0, 100).len(), 1);
    }
}

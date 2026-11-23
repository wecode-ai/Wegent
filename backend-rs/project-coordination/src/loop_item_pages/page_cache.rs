// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The loop-item-pages issue-page cache
//! (`ExternalLoopItemProvider._issue_page_cache`).
//!
//! The source keeps a process-wide 30-second cache of fetched provider issue
//! pages, keyed by `(project.id, project.version, generation, item_status,
//! parent_id, page, limit)`. Cache entries expire by `time.monotonic()`;
//! expired entries are pruned on write. The cache generation increments only
//! when the mutating provider paths (create/update/close) invalidate a
//! project's pages; those paths are not migrated, so the generation stays at
//! its default 0 here and is deliberately omitted from the key.
//!
//! The source also single-flights concurrent identical fetches through
//! `_issue_page_inflight`. The cache is stored per raw JSON page (the source
//! caches the raw issue dicts) and the caller re-projects it to `PageIssue`
//! rows on each read. Access is guarded by a short `std::sync::Mutex` critical
//! section (never held across an await), mirroring the source's
//! `threading.Lock`.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// `ISSUE_PAGE_CACHE_SECONDS` (`app.services.loop_items.external_provider`).
const ISSUE_PAGE_CACHE_SECONDS: Duration = Duration::from_secs(30);

/// One cache key: the source tuple minus the (constant) generation.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PageCacheKey {
    project_id: String,
    project_version: i64,
    item_status: String,
    parent_id: Option<String>,
    page: u32,
    limit: i64,
}

/// One cached page: the raw issue JSON array and its expiry deadline.
#[derive(Debug, Clone)]
struct CachedPage {
    expires_at: Instant,
    values: Vec<serde_json::Value>,
}

/// The process-wide page cache. Lazily initialized on first use because the
/// state is process-lifetime, not request-owned.
fn page_cache() -> &'static Mutex<HashMap<PageCacheKey, CachedPage>> {
    static CACHE: OnceLock<Mutex<HashMap<PageCacheKey, CachedPage>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `_list_issue_page`'s cache read: the raw issue values for a fresh entry.
/// `None` on a miss or an expired entry.
pub(super) fn cached_page(
    project_id: &str,
    project_version: i64,
    item_status: &str,
    parent_id: Option<&str>,
    page: u32,
    limit: i64,
) -> Option<Vec<serde_json::Value>> {
    let key = PageCacheKey {
        project_id: project_id.to_string(),
        project_version,
        item_status: item_status.to_string(),
        parent_id: parent_id.map(str::to_string),
        page,
        limit,
    };
    let cache = page_cache().lock().ok()?;
    let entry = cache.get(&key)?;
    (entry.expires_at > Instant::now()).then(|| entry.values.clone())
}

/// `_list_issue_page`'s cache write: store the fetched raw page, pruning
/// expired entries first like the source's dict comprehension.
pub(super) fn store_page(
    project_id: &str,
    project_version: i64,
    item_status: &str,
    parent_id: Option<&str>,
    page: u32,
    limit: i64,
    values: Vec<serde_json::Value>,
) {
    let key = PageCacheKey {
        project_id: project_id.to_string(),
        project_version,
        item_status: item_status.to_string(),
        parent_id: parent_id.map(str::to_string),
        page,
        limit,
    };
    let Ok(mut cache) = page_cache().lock() else {
        return;
    };
    let now = Instant::now();
    cache.retain(|_, entry| entry.expires_at > now);
    cache.insert(
        key,
        CachedPage {
            expires_at: now + ISSUE_PAGE_CACHE_SECONDS,
            values,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_values() -> Vec<serde_json::Value> {
        vec![serde_json::json!({"iid": 41, "title": "t"})]
    }

    #[test]
    fn stores_and_reads_a_page() {
        let values = key_values();
        store_page(
            "1712605396200092385",
            4,
            "in_review",
            None,
            1,
            100,
            values.clone(),
        );
        let cached = cached_page("1712605396200092385", 4, "in_review", None, 1, 100);
        assert_eq!(cached.as_deref(), Some(values.as_slice()));
    }

    #[test]
    fn distinct_keys_do_not_alias() {
        store_page(
            "1712605396200092385",
            4,
            "in_review",
            None,
            1,
            100,
            key_values(),
        );
        assert!(cached_page("1712605396200092385", 4, "pending", None, 1, 100).is_none());
        assert!(cached_page("1712605396200092385", 4, "in_review", None, 2, 100).is_none());
        assert!(cached_page("1712605396200092385", 5, "in_review", None, 1, 100).is_none());
    }
}

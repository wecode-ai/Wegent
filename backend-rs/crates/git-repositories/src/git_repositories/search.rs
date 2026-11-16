// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `search_repositories` for the `app.repository.*_provider` implementations
//! behind `GET /api/git/repositories/search`.
//!
//! Every provider searches the same way: filter the domain's fully fetched
//! repository list when it is cached, otherwise wait for a concurrent full
//! fetch, run one synchronously, and finally fall back to a live first page.
//! The filter compares the lowercased query against `name` and `full_name`
//! (exact for `fullmatch`, substring otherwise) and re-projects each match with
//! the entry's domain and the provider's own type.
use std::time::{Duration, Instant};

use brz_http::Client;

use crate::git_repositories::cache::{RepositoryCache, full_cache_key};
use crate::git_repositories::projection::{ProviderRepo, decode_cached, map_cached};
use crate::git_repositories::providers::{
    self, MapError, Provider, ProviderEntry, RefreshRequest, UserRef,
};

/// `await asyncio.sleep(1)` between `building:` polls.
const BUILDING_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// The `building:` wait's hard poll bound. The route validates `timeout` to
/// `5..=60`, so the source's loop sleeps at most 61 times; the bound also keeps
/// a clock-observed stall from outliving the request's budget.
const MAX_BUILDING_POLLS: u32 = 61;

/// A provider-local failure that discards the provider's whole contribution,
/// mirroring `RepositoryService.search_repositories`'s `except Exception:
/// continue`.
#[derive(Debug)]
pub(crate) enum SearchError {
    /// A malformed cached entry or an undecryptable token (the source's
    /// `KeyError`/decryption failure).
    Malformed,
    /// The `408` the `building:` wait raises. The service's `except Exception`
    /// swallows it, so the provider is dropped instead of answering `408`.
    TimedOut,
}

impl From<MapError> for SearchError {
    fn from(_: MapError) -> Self {
        SearchError::Malformed
    }
}

/// One request's search criteria.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Criteria<'a> {
    /// The lowercased `q` the filter compares against; lowercasing happens once
    /// per request instead of once per candidate row.
    pub(crate) needle: &'a str,
    /// The endpoint's validated `timeout`, in seconds.
    pub(crate) timeout: Duration,
    pub(crate) fullmatch: bool,
}

/// `provider.search_repositories(user, query, timeout, fullmatch)`: every entry
/// of one provider, in `git_info` order.
pub(crate) async fn search(
    client: &Client,
    cache: &dyn RepositoryCache,
    provider: Provider,
    entries: &[ProviderEntry],
    criteria: Criteria<'_>,
    user: UserRef<'_>,
) -> Result<Vec<ProviderRepo>, SearchError> {
    let mut results = Vec::new();
    for entry in entries {
        // `if not git_token: continue`; gerrit also requires `user_name`.
        if entry.git_token.is_empty()
            || (provider == Provider::Gerrit && entry.user_name.is_empty())
        {
            continue;
        }
        // 1) The domain's full cache.
        if let Some(matches) = cached_matches(cache, provider, entry, criteria, user).await? {
            results.extend(matches);
            continue;
        }
        // 2) A concurrent full fetch: wait for it, then retry the cache.
        wait_for_build(cache, user, &entry.git_domain, criteria.timeout).await?;
        if let Some(matches) = cached_matches(cache, provider, entry, criteria, user).await? {
            results.extend(matches);
            continue;
        }
        // 3) No cache and no concurrent fetch: run the domain full fetch in
        // place (`await self._fetch_all_repositories_async(...)`).
        providers::refresh(client, cache, &refresh_request(provider, entry, user)).await;
        // 4) Retry the cache the full fetch just replaced.
        if let Some(matches) = cached_matches(cache, provider, entry, criteria, user).await? {
            results.extend(matches);
            continue;
        }
        // 5) Fallback: this domain's first page only.
        if let Some(page) = providers::search_fallback_page(client, provider, entry).await? {
            results.extend(select(page, criteria.needle, criteria.fullmatch));
        }
    }
    Ok(results)
}

/// One cached-list read and filter: the domain's `git_repos:` key, treated as a
/// miss when absent, undecodable, or empty (`if full_cached:`).
async fn cached_matches(
    cache: &dyn RepositoryCache,
    provider: Provider,
    entry: &ProviderEntry,
    criteria: Criteria<'_>,
    user: UserRef<'_>,
) -> Result<Option<Vec<ProviderRepo>>, SearchError> {
    let key = full_cache_key(user.id, &entry.git_domain);
    let Some(items) = cache
        .get(&key)
        .await
        .and_then(|bytes| decode_cached(&bytes))
        .filter(|items| !items.is_empty())
    else {
        return Ok(None);
    };
    let mapped = map_cached(provider, &entry.git_domain, &items)?;
    Ok(Some(select(mapped, criteria.needle, criteria.fullmatch)))
}

/// The `fullmatch`/substring filter over the lowercased `name` and `full_name`.
fn select(repos: Vec<ProviderRepo>, needle: &str, fullmatch: bool) -> Vec<ProviderRepo> {
    repos
        .into_iter()
        .filter(|repo| {
            let name = repo.name.to_lowercase();
            let full_name = repo.full_name.to_lowercase();
            if fullmatch {
                needle == name || needle == full_name
            } else {
                name.contains(needle) || full_name.contains(needle)
            }
        })
        .collect()
}

/// `cache_manager.is_building` polling loop. The source raises
/// `HTTPException(408, ...)` once `timeout` elapses, which the service's
/// `except Exception` then turns into a dropped provider.
async fn wait_for_build(
    cache: &dyn RepositoryCache,
    user: UserRef<'_>,
    git_domain: &str,
    timeout: Duration,
) -> Result<(), SearchError> {
    if !cache.is_building(user.id, git_domain).await {
        return Ok(());
    }
    let start = Instant::now();
    let mut polls = 0;
    while cache.is_building(user.id, git_domain).await {
        if polls >= MAX_BUILDING_POLLS || start.elapsed() > timeout {
            return Err(SearchError::TimedOut);
        }
        polls += 1;
        tokio::time::sleep(BUILDING_POLL_INTERVAL).await;
    }
    Ok(())
}

/// The full-fetch job for one entry, shared with the background worker's shape.
fn refresh_request(provider: Provider, entry: &ProviderEntry, user: UserRef<'_>) -> RefreshRequest {
    RefreshRequest {
        provider,
        user_id: user.id,
        user_name: user.name.to_string(),
        git_domain: entry.git_domain.clone(),
        git_token: entry.git_token.clone(),
        gerrit_user: entry.user_name.clone(),
        auth_type: entry.auth_type.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::HashMap;

    /// A cache whose reads are scripted, so the cached/missing/building paths
    /// can be exercised without Redis or a provider service.
    struct StubCache {
        entries: HashMap<String, Vec<u8>>,
        building: bool,
    }

    #[async_trait]
    impl RepositoryCache for StubCache {
        async fn get(&self, key: &str) -> Option<Vec<u8>> {
            self.entries.get(key).cloned()
        }
        async fn set(&self, _key: &str, _value: Vec<u8>) {}
        async fn is_building(&self, _user_id: i32, _git_domain: &str) -> bool {
            self.building
        }
        async fn set_building(&self, _user_id: i32, _git_domain: &str, _building: bool) {}
    }

    fn entry(git_domain: &str) -> ProviderEntry {
        ProviderEntry {
            git_domain: git_domain.to_string(),
            git_token: "***".to_string(),
            git_login: "example-user".to_string(),
            user_name: String::new(),
            auth_type: "digest".to_string(),
        }
    }

    fn user() -> UserRef<'static> {
        UserRef {
            id: 42,
            name: "example-user",
        }
    }

    fn criteria(needle: &str, fullmatch: bool) -> Criteria<'_> {
        Criteria {
            needle,
            timeout: Duration::from_secs(30),
            fullmatch,
        }
    }

    fn cached_gitlab() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!([
            {
                "id": 14370,
                "name": "other-repo",
                "full_name": "owner/other-repo",
                "clone_url": "https://git.example.invalid/owner/other-repo.git",
                "git_domain": "git.example.invalid",
                "type": "gitlab",
                "private": true
            },
            {
                "id": 11872,
                "name": "example-repo",
                "full_name": "group/example-repo",
                "clone_url": "https://git.example.invalid/group/example-repo.git",
                "git_domain": "git.example.invalid",
                "type": "gitlab",
                "private": true
            }
        ]))
        .unwrap()
    }

    fn cache_with_cached_gitlab() -> StubCache {
        StubCache {
            entries: HashMap::from([(full_cache_key(42, "git.example.invalid"), cached_gitlab())]),
            building: false,
        }
    }

    /// `fullmatch` compares `q` against the cached row's whole `name` or
    /// `full_name`, so only the exactly matching row is kept.
    #[tokio::test]
    async fn a_cached_fullmatch_search_keeps_only_the_exact_row() {
        let client = providers::build_client().unwrap();
        let found = search(
            &client,
            &cache_with_cached_gitlab(),
            Provider::Gitlab,
            &[entry("git.example.invalid")],
            criteria("group/example-repo", true),
            user(),
        )
        .await
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].full_name, "group/example-repo");
        assert_eq!(found[0].git_domain, "git.example.invalid");
        assert_eq!(found[0].kind, "gitlab");
    }

    #[tokio::test]
    async fn a_cached_substring_search_keeps_every_containing_row() {
        let client = providers::build_client().unwrap();
        let found = search(
            &client,
            &cache_with_cached_gitlab(),
            Provider::Gitlab,
            &[entry("git.example.invalid")],
            criteria("example", false),
            user(),
        )
        .await
        .unwrap();
        assert_eq!(
            found
                .iter()
                .map(|repo| repo.name.as_str())
                .collect::<Vec<_>>(),
            vec!["example-repo"]
        );
    }

    #[tokio::test]
    async fn an_empty_cached_list_is_a_miss_and_times_out_while_building() {
        let client = providers::build_client().unwrap();
        let cache = StubCache {
            entries: HashMap::from([(full_cache_key(42, "git.example.invalid"), b"[]".to_vec())]),
            building: true,
        };
        let error = search(
            &client,
            &cache,
            Provider::Gitlab,
            &[entry("git.example.invalid")],
            // A zero budget fails on the first poll instead of sleeping.
            Criteria {
                needle: "example",
                timeout: Duration::ZERO,
                fullmatch: false,
            },
            user(),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, SearchError::TimedOut));
    }

    #[tokio::test]
    async fn a_tokenless_entry_contributes_nothing() {
        let client = providers::build_client().unwrap();
        let mut tokenless = entry("git.example.invalid");
        tokenless.git_token = String::new();
        let found = search(
            &client,
            &cache_with_cached_gitlab(),
            Provider::Gitlab,
            &[tokenless],
            criteria("example-repo", false),
            user(),
        )
        .await
        .unwrap();
        assert!(found.is_empty());
    }

    #[test]
    fn select_prefers_exact_names_for_fullmatch_only() {
        let repos = vec![
            ProviderRepo {
                id: 1,
                name: "example-repo".to_string(),
                full_name: "group/example-repo".to_string(),
                clone_url: "u".to_string(),
                git_domain: "git.example.invalid".to_string(),
                kind: "gitlab",
                private: true,
            },
            ProviderRepo {
                id: 2,
                name: "example-repo-extra".to_string(),
                full_name: "group/example-repo-extra".to_string(),
                clone_url: "u".to_string(),
                git_domain: "git.example.invalid".to_string(),
                kind: "gitlab",
                private: true,
            },
        ];
        assert_eq!(
            select(repos.clone(), "example-repo", true)
                .into_iter()
                .map(|repo| repo.id)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(
            select(repos, "example-repo", false)
                .into_iter()
                .map(|repo| repo.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }
}

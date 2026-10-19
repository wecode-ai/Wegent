// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.services.repository.RepositoryService` over the migrated providers.
//!
//! `GET /api/git/repositories` aggregates every configured provider's list for
//! the current user, then applies the route's outer pagination. The service
//! owns the process-lifetime provider HTTP client, the Redis cache adapter, and
//! the background full-fetch worker.
use std::sync::Arc;
use std::time::Duration;

use brz_http::Client;
use brz_http_server::StatusCode;
use brz_redis::RedisService;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::auth::UserRow;
use crate::git_repositories::Branch;
use crate::git_repositories::RepositoryResult;
use crate::git_repositories::branch_providers;
use crate::git_repositories::cache::{RedisRepositoryCache, RepositoryCache};
use crate::git_repositories::providers::{self, MapError, Provider, ProviderEntry};
use crate::git_repositories::search;
use crate::git_repositories::worker;
use crate::http_compat::FastApiError;
use crate::repository_tokens::RepositoryTokenResolver;
use brz_json::OpaqueJson;

/// Bound on queued background full-fetch jobs. The source deduplicates work
/// with the `building:` flag; a bounded queue keeps the request path from
/// accumulating an unbounded backlog when many domains miss at once.
const REFRESH_QUEUE_CAPACITY: usize = 64;

/// `RepositoryService` state reused across requests.
pub struct GitRepositoriesService {
    cache: Arc<dyn RepositoryCache>,
    client: Client,
    refresh: mpsc::Sender<providers::RefreshRequest>,
}

impl GitRepositoriesService {
    /// Build the retained service. Called once at process startup so the
    /// refresh worker is initialization-owned.
    pub fn new(redis: Option<RedisService>) -> Result<Self, brz_http::Error> {
        let cache: Arc<dyn RepositoryCache> = Arc::new(RedisRepositoryCache { redis });
        let client = providers::build_client()?;
        let (refresh, receiver) = mpsc::channel(REFRESH_QUEUE_CAPACITY);
        tokio::spawn(worker::run(Arc::clone(&cache), client.clone(), receiver));
        Ok(Self {
            cache,
            client,
            refresh,
        })
    }

    /// The retained provider HTTP client
    /// (`settings.REPOSITORY_READ_TIMEOUT_SECONDS`), shared with the Git-token
    /// validation the current-user update performs.
    pub(crate) fn client(&self) -> Client {
        self.client.clone()
    }

    /// `repository_service.get_repositories`: the provider aggregation plus the
    /// outer `page`/`limit` slice. `page=1, limit=100` is what the source passes
    /// to every provider.
    pub async fn get_repositories(
        &self,
        resolver: &dyn RepositoryTokenResolver,
        user: &UserRow,
        page: i64,
        limit: i64,
    ) -> Result<Vec<RepositoryResult>, FastApiError> {
        let providers = user_providers(&user.git_info.0);
        // `if not user_providers: raise HTTPException(400, ...)`.
        if providers.is_empty() {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                "No git token configured. Please add your git token.",
            ));
        }
        let mut repos: Vec<providers::ProviderRepo> = Vec::new();
        for name in providers {
            let Some(provider) = Provider::from_name(&name) else {
                continue;
            };
            // The source wraps each provider call in `except Exception:
            // continue`, so any provider-local failure (a decryption
            // configuration error, a malformed cached entry) drops that
            // provider's contribution instead of failing the request.
            match self.fetch_provider(resolver, provider, user).await {
                Ok((fetched, refresh)) => {
                    repos.extend(fetched);
                    // The source's `all_repos.sort(key=... updated_at ...)` is a
                    // no-op here: no provider projection carries `updated_at`,
                    // so Python's stable sort preserves provider order.
                    for job in refresh {
                        self.enqueue(job);
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        error = ?error,
                        provider = provider.name(),
                        "could not fetch repositories"
                    );
                }
            }
        }
        Ok(providers::page_slice(&repos, page, limit)
            .into_iter()
            .map(RepositoryResult::from_repo)
            .collect())
    }

    /// One provider's `get_repositories`: the entry projection, the GitLab
    /// placeholder resolution, and the aggregation call.
    async fn fetch_provider(
        &self,
        resolver: &dyn RepositoryTokenResolver,
        provider: Provider,
        user: &UserRow,
    ) -> Result<(Vec<providers::ProviderRepo>, Vec<providers::RefreshRequest>), MapError> {
        let mut entries = providers::entries(provider, &user.git_info.0)?;
        if provider == Provider::Gitlab {
            resolve_gitlab_tokens(resolver, &mut entries).await;
        }
        let fetched = providers::get_repositories(
            &self.client,
            self.cache.as_ref(),
            provider,
            &entries,
            1,
            100,
            providers::UserRef {
                id: user.id,
                name: &user.user_name,
            },
        )
        .await?;
        Ok((fetched.repos, fetched.refresh))
    }

    /// `asyncio.create_task(self._fetch_all_repositories_async(...))`: admission
    /// into the bounded refresh queue. A full queue drops the job and logs it.
    fn enqueue(&self, job: providers::RefreshRequest) {
        if let Err(error) = self.refresh.try_send(job) {
            tracing::warn!(%error, "repository full-fetch queue is full; dropping job");
        }
    }

    /// `repository_service.get_branches(user_context, git_repo, type=...,
    /// git_domain=...)`: the provider dispatch over the user's `git_info`.
    /// A provider failure is already the service's wrapped
    /// `Error getting branches from {type}: ...` text; no matching entry
    /// answers an empty list.
    pub async fn get_branches(
        &self,
        resolver: &dyn RepositoryTokenResolver,
        user: &UserRow,
        git_repo: &str,
        kind: &str,
        git_domain: &str,
    ) -> Result<Vec<Branch>, FastApiError> {
        branch_providers::get_branches(
            &self.client,
            resolver,
            &user.git_info.0,
            git_repo,
            kind,
            git_domain,
        )
        .await
        .map_err(|detail| FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, detail))
    }

    /// `repository_service.search_repositories(user_context, q, timeout,
    /// fullmatch)`: each configured provider's matches, then the relevance
    /// sort. Unlike `get_repositories`, an empty provider list is an empty
    /// result rather than `400`.
    pub async fn search_repositories(
        &self,
        resolver: &dyn RepositoryTokenResolver,
        user: &UserRow,
        query: &str,
        timeout_seconds: u64,
        fullmatch: bool,
    ) -> Result<Vec<RepositoryResult>, FastApiError> {
        let providers = user_providers(&user.git_info.0);
        // `if not user_providers: return []`.
        if providers.is_empty() {
            return Ok(Vec::new());
        }
        // `query_lower = query.lower()`, computed once for the filter and the
        // relevance sort.
        let needle = query.to_lowercase();
        let criteria = search::Criteria {
            needle: &needle,
            timeout: Duration::from_secs(timeout_seconds),
            fullmatch,
        };
        let mut found: Vec<providers::ProviderRepo> = Vec::new();
        for name in providers {
            let Some(provider) = Provider::from_name(&name) else {
                continue;
            };
            // The source wraps each provider call in `except Exception:
            // continue`, so a provider-local failure (an undecryptable token,
            // a malformed cached entry, or the `building:` wait's `408`) drops
            // that provider's whole contribution instead of failing the
            // request.
            match self
                .search_provider(resolver, provider, user, criteria)
                .await
            {
                Ok(mut repos) => found.append(&mut repos),
                Err(error) => {
                    tracing::error!(
                        error = ?error,
                        provider = provider.name(),
                        "could not search repositories"
                    );
                }
            }
        }
        sort_by_relevance(&mut found, &needle);
        Ok(found.into_iter().map(RepositoryResult::from_repo).collect())
    }

    /// One provider's `search_repositories`: the entry projection, the GitLab
    /// placeholder resolution, and the per-domain search.
    async fn search_provider(
        &self,
        resolver: &dyn RepositoryTokenResolver,
        provider: Provider,
        user: &UserRow,
        criteria: search::Criteria<'_>,
    ) -> Result<Vec<providers::ProviderRepo>, search::SearchError> {
        let mut entries = providers::entries(provider, &user.git_info.0)?;
        if provider == Provider::Gitlab {
            resolve_gitlab_tokens(resolver, &mut entries).await;
        }
        search::search(
            &self.client,
            self.cache.as_ref(),
            provider,
            &entries,
            criteria,
            providers::UserRef {
                id: user.id,
                name: &user.user_name,
            },
        )
        .await
    }
}

/// `all_results.sort(key=lambda x: (not <query matches>, -len(x["name"])))`:
/// matching rows first, then the longest `name`s; Python's stable sort keeps
/// the provider order for equal keys. `needle` is already lowercased.
fn sort_by_relevance(repos: &mut [providers::ProviderRepo], needle: &str) {
    repos.sort_by(|left, right| {
        let rank = |repo: &providers::ProviderRepo| {
            let matches = repo.name.to_lowercase().contains(needle)
                || repo.full_name.to_lowercase().contains(needle);
            (!matches, std::cmp::Reverse(repo.name.chars().count()))
        };
        rank(left).cmp(&rank(right))
    });
}

/// `_get_user_providers`: configured provider types in `git_info` order, with
/// duplicates retained. A provider counts only when `git_info[].git_token` is
/// truthy.
fn user_providers(git_info: &OpaqueJson) -> Vec<String> {
    let Some(Value::Array(items)) = git_info.project::<Value>() else {
        return Vec::new();
    };
    let mut providers = Vec::new();
    for item in items {
        let Value::Object(map) = item else {
            continue;
        };
        let Some(Value::String(kind)) = map.get("type") else {
            continue;
        };
        if Provider::from_name(kind).is_none() {
            continue;
        }
        if map.get("git_token").is_some_and(truthy) {
            providers.push(kind.clone());
        }
    }
    providers
}

/// Python truthiness for the `if info.get("git_token")` guard.
use brz_json::adapters::python_truthy as truthy;

/// `gitlab_provider_patch._resolve_tokens_for_user`: resolve every `"***"`
/// placeholder before the provider call, keeping the stored value when the
/// service returns nothing.
pub(crate) async fn resolve_gitlab_tokens(
    resolver: &dyn RepositoryTokenResolver,
    entries: &mut [ProviderEntry],
) {
    for entry in entries.iter_mut() {
        if entry.git_token == "***" {
            let resolved = resolver
                .resolve_gitlab_token(&entry.git_login, &entry.git_domain, &entry.git_token)
                .await;
            if !resolved.is_empty() {
                entry.git_token = resolved;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn json_git_info(value: Value) -> OpaqueJson {
        OpaqueJson::from(value)
    }

    #[test]
    fn configured_providers_follow_git_info_order_with_duplicates() {
        let git_info = json_git_info(json!([
            {"type": "gitlab", "git_token": "***", "git_domain": "git.example.invalid"},
            {"type": "github", "git_token": "ghp_x", "git_domain": "github.com"},
            {"type": "gitee", "git_token": "", "git_domain": "gitee.com"},
            {"type": "unknown", "git_token": "x"},
            {"type": "gitlab", "git_token": "***", "git_domain": "git2.example.invalid"}
        ]));
        assert_eq!(
            user_providers(&git_info),
            vec!["gitlab", "github", "gitlab"]
        );
    }

    #[test]
    fn empty_or_non_list_git_info_configures_no_providers() {
        assert!(user_providers(&json_git_info(json!(null))).is_empty());
        assert!(user_providers(&json_git_info(json!([]))).is_empty());
    }

    #[test]
    fn python_truthiness_matches_the_token_guard() {
        assert!(truthy(&json!("***")));
        assert!(!truthy(&json!("")));
        assert!(!truthy(&json!(null)));
        assert!(!truthy(&json!(false)));
        assert!(!truthy(&json!(0)));
        assert!(!truthy(&json!([])));
        assert!(truthy(&json!(["x"])));
    }

    fn repo(id: i64, name: &str) -> providers::ProviderRepo {
        providers::ProviderRepo {
            id,
            name: name.to_string(),
            full_name: format!("owner/{name}"),
            clone_url: "u".to_string(),
            git_domain: "git.example.invalid".to_string(),
            kind: "gitlab",
            private: true,
        }
    }

    /// `(not <name or full_name contains the query>, -len(name))`: matching
    /// rows first, then the longest names; the sort is stable.
    #[test]
    fn relevance_sorts_matching_rows_then_longest_names() {
        let mut found = vec![
            repo(1, "delta"),
            repo(2, "alphabet"),
            repo(3, "alpha"),
            repo(4, "q"),
        ];
        sort_by_relevance(&mut found, "alpha");
        assert_eq!(
            found.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![2, 3, 1, 4]
        );
    }

    /// Equal keys keep the provider order the aggregation produced.
    #[test]
    fn relevance_sort_is_stable_for_equal_keys() {
        let mut found = vec![repo(1, "alpha"), repo(2, "alpha"), repo(3, "alpha")];
        sort_by_relevance(&mut found, "nomatch");
        assert_eq!(
            found.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }
}

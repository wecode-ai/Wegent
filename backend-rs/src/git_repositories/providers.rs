// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Provider-specific repository fetching for `GET /api/git/repositories`.
//!
//! Mirrors the `get_repositories` / `_fetch_all_repositories_async` pair of
//! each `app.repository.*_provider` implementation: the domain-level Redis list
//! is preferred, and only a cache miss performs the provider HTTP call. Every
//! provider maps its response into the same seven-field projection
//! (`id`, `name`, `full_name`, `clone_url`, `git_domain`, `type`, `private`).
use std::time::Duration;

use brz_http::{Client, RequestBuilder};
use serde_json::Value;

use crate::git_repositories::cache::{RepositoryCache, full_cache_key};
use crate::git_repositories::crypto::decrypt_git_token;
pub(crate) use crate::git_repositories::projection::ProviderRepo;
pub(crate) use crate::git_repositories::projection::page_slice;
use crate::git_repositories::projection::{
    decode_cached, git_info_items, map_cached, map_gerrit, map_gitea, map_gitee, map_gitlab,
    map_strict, opt_str, provider_api_base_url, repo_values, write_cache,
};
use brz_json::OpaqueJson;

/// `settings.REPOSITORY_READ_TIMEOUT_SECONDS` (default 15), applied to the
/// connect and read phases like `requests(timeout=...)`.
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// `_get_api_base_url`'s fixed defaults.
const GITHUB_API: &str = "https://api.github.com";
const GITLAB_API: &str = "https://gitlab.com/api/v4";
const GITEE_API: &str = "https://gitee.com/api/v5";
const GITEA_API: &str = "https://gitea.com/api/v1";

/// `RepositoryService.providers` registers exactly these five types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Provider {
    Github,
    Gitlab,
    Gitee,
    Gitea,
    Gerrit,
}

impl Provider {
    /// `RepositoryProvider.type`.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Provider::Github => "github",
            Provider::Gitlab => "gitlab",
            Provider::Gitee => "gitee",
            Provider::Gitea => "gitea",
            Provider::Gerrit => "gerrit",
        }
    }

    /// `RepositoryService.providers[type]`; an unknown type is not configured.
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "github" => Some(Provider::Github),
            "gitlab" => Some(Provider::Gitlab),
            "gitee" => Some(Provider::Gitee),
            "gitea" => Some(Provider::Gitea),
            "gerrit" => Some(Provider::Gerrit),
            _ => None,
        }
    }

    /// `_get_api_base_url`: the fixed default for the provider's own domain,
    /// otherwise a per-domain API root.
    fn api_base_url(self, git_domain: &str) -> String {
        match self {
            Provider::Github => {
                provider_api_base_url(git_domain, "github.com", GITHUB_API, "/api/v3")
            }
            Provider::Gitlab => {
                provider_api_base_url(git_domain, "gitlab.com", GITLAB_API, "/api/v4")
            }
            Provider::Gitee => provider_api_base_url(git_domain, "gitee.com", GITEE_API, "/api/v5"),
            Provider::Gitea => provider_api_base_url(git_domain, "gitea.com", GITEA_API, "/api/v1"),
            Provider::Gerrit => crate::git_repositories::projection::build_url(git_domain, "/a"),
        }
    }
}

/// A provider-local source exception that is not a per-domain
/// `RequestException`: a token-decryption configuration error or a malformed
/// entry/response field. `RepositoryService.get_repositories` wraps each
/// provider call in `except Exception: continue`, so the caller drops that
/// provider's contribution rather than failing the request. Per-domain HTTP
/// failures are handled separately (they skip the domain inside the provider).
#[derive(Debug)]
pub(crate) enum MapError {
    Decryption,
    Malformed,
}

/// One `_get_git_infos` entry.
#[derive(Clone, Debug)]
pub(crate) struct ProviderEntry {
    pub(crate) git_domain: String,
    pub(crate) git_token: String,
    pub(crate) git_login: String,
    pub(crate) user_name: String,
    pub(crate) auth_type: String,
}

/// The current user's identity, used for cache keys and refresh jobs.
#[derive(Clone, Copy, Debug)]
pub(crate) struct UserRef<'a> {
    pub(crate) id: i32,
    pub(crate) name: &'a str,
}

/// A provider's `get_repositories` result for one request.
pub(crate) struct ProviderFetch {
    pub(crate) repos: Vec<ProviderRepo>,
    /// Full-fetch jobs scheduled for a full page.
    pub(crate) refresh: Vec<RefreshRequest>,
}

/// One background full-fetch (`_fetch_all_repositories_async`) request.
#[derive(Clone, Debug)]
pub(crate) struct RefreshRequest {
    pub(crate) provider: Provider,
    pub(crate) user_id: i32,
    pub(crate) user_name: String,
    pub(crate) git_domain: String,
    pub(crate) git_token: String,
    pub(crate) gerrit_user: String,
    pub(crate) auth_type: String,
}

/// `settings.REPOSITORY_READ_TIMEOUT_SECONDS` for the background worker.
/// The shared provider HTTP client (`requests` with a 15s connect/read budget
/// and default redirect following). `requests` validates HTTPS against the
/// system trust store, so the client also trusts the deployment's mounted
/// anchor when one exists; a normal host keeps the built-in roots.
pub(crate) fn build_client() -> Result<Client, brz_http::Error> {
    Client::builder()
        .connect_timeout(READ_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .timeout(READ_TIMEOUT)
        .configure(|builder| match crate::http_trust::trust_anchor() {
            Some(anchor) => builder.add_root_certificate(anchor),
            None => builder,
        })
        .build()
}

/// `_get_git_infos`: this provider's `user.git_info` entries with decrypted
/// tokens.
pub(crate) fn entries(
    provider: Provider,
    git_info: &OpaqueJson,
) -> Result<Vec<ProviderEntry>, MapError> {
    let mut entries = Vec::new();
    for item in git_info_items(git_info) {
        if opt_str(&item, "type") != provider.name() {
            continue;
        }
        let token =
            decrypt_git_token(&opt_str(&item, "git_token")).map_err(|_| MapError::Decryption)?;
        entries.push(ProviderEntry {
            git_domain: opt_str(&item, "git_domain"),
            git_token: token,
            git_login: opt_str(&item, "git_login"),
            user_name: opt_str(&item, "user_name"),
            auth_type: {
                let value = opt_str(&item, "auth_type");
                if value.is_empty() {
                    "digest".to_string()
                } else {
                    value
                }
            },
        });
    }
    Ok(entries)
}

/// `provider.get_repositories(user, page, limit)`: the domain-cache read, then
/// the cache-miss HTTP fetch, for every entry of this provider.
pub(crate) async fn get_repositories(
    client: &Client,
    cache: &dyn RepositoryCache,
    provider: Provider,
    entries: &[ProviderEntry],
    page: i64,
    limit: i64,
    user: UserRef<'_>,
) -> Result<ProviderFetch, MapError> {
    let mut repos = Vec::new();
    let mut refresh = Vec::new();
    for entry in entries {
        // `if not git_token: continue`; gerrit also needs `user_name`.
        if entry.git_token.is_empty()
            || (provider == Provider::Gerrit && entry.user_name.is_empty())
        {
            continue;
        }
        // Domain-level full cache; an empty list is a miss (`if full_cached:`).
        let key = full_cache_key(user.id, &entry.git_domain);
        let cached = cache
            .get(&key)
            .await
            .and_then(|bytes| decode_cached(&bytes));
        if let Some(items) = cached.filter(|items| !items.is_empty()) {
            let mapped = map_cached(provider, &entry.git_domain, &items)?;
            repos.extend(page_slice(&mapped, page, limit));
            continue;
        }
        match live_entry(client, cache, provider, entry, page, limit, user).await? {
            Some(fetched) => {
                repos.extend(fetched.repos);
                refresh.extend(fetched.refresh);
            }
            None => continue,
        }
    }
    Ok(ProviderFetch { repos, refresh })
}

/// The cache-miss provider HTTP call. `None` mirrors the source's
/// `except requests.exceptions.RequestException: continue` domain skip.
async fn live_entry(
    client: &Client,
    cache: &dyn RepositoryCache,
    provider: Provider,
    entry: &ProviderEntry,
    page: i64,
    limit: i64,
    user: UserRef<'_>,
) -> Result<Option<ProviderFetch>, MapError> {
    match provider {
        Provider::Github | Provider::Gitee => {
            fetch_flat(client, cache, provider, entry, page, limit, user).await
        }
        Provider::Gitlab => fetch_gitlab(client, cache, entry, page, limit, user).await,
        Provider::Gitea => fetch_gitea(client, cache, entry, page, limit, user).await,
        Provider::Gerrit => fetch_gerrit(client, cache, entry, page, limit, user).await,
    }
}

/// github/gitee: a flat `/user/repos` list, mapped directly, with a single-page
/// cache write or a full-fetch schedule.
async fn fetch_flat(
    client: &Client,
    cache: &dyn RepositoryCache,
    provider: Provider,
    entry: &ProviderEntry,
    page: i64,
    limit: i64,
    user: UserRef<'_>,
) -> Result<Option<ProviderFetch>, MapError> {
    let url = format!("{}/user/repos", provider.api_base_url(&entry.git_domain));
    let builder = match provider {
        Provider::Github => client.get(&url).map(|request| {
            request
                .header("authorization", format!("token {}", entry.git_token))
                .header("accept", "application/vnd.github.v3+json")
                .query(&page_query(limit, page, "sort"))
        }),
        Provider::Gitee => client.get(&url).map(|request| {
            request.query(&[
                ("access_token", entry.git_token.clone()),
                ("per_page", limit.to_string()),
                ("page", page.to_string()),
                ("sort", "updated".to_string()),
                ("affiliation", "owner,collaborator".to_string()),
            ])
        }),
        _ => unreachable!("fetch_flat handles github and gitee only"),
    };
    let Ok(builder) = builder else {
        return Ok(None);
    };
    let Some(body) = send_json(builder).await else {
        return Ok(None);
    };
    let Value::Array(items) = body else {
        return Ok(None);
    };
    let mapped = match provider {
        Provider::Github => map_strict(&items, &entry.git_domain, "github")?,
        Provider::Gitee => map_gitee(&items, &entry.git_domain)?,
        _ => unreachable!(),
    };
    let mut refresh = Vec::new();
    if (items.len() as i64) < limit {
        write_cache(cache, user.id, &entry.git_domain, &items).await;
    } else {
        refresh.push(refresh_request(provider, entry, user));
    }
    Ok(Some(ProviderFetch {
        repos: mapped,
        refresh,
    }))
}

/// gitlab `/projects` with the Bearer-then-Private-Token 401 retry.
async fn fetch_gitlab(
    client: &Client,
    cache: &dyn RepositoryCache,
    entry: &ProviderEntry,
    page: i64,
    limit: i64,
    user: UserRef<'_>,
) -> Result<Option<ProviderFetch>, MapError> {
    let url = format!(
        "{}/projects",
        Provider::Gitlab.api_base_url(&entry.git_domain)
    );
    let query = [
        ("per_page", limit.to_string()),
        ("page", page.to_string()),
        ("order_by", "last_activity_at".to_string()),
        ("membership", "true".to_string()),
    ];
    let Ok(bearer) = client.get(&url).map(|request| {
        request
            .header("authorization", format!("Bearer {}", entry.git_token))
            .header("accept", "application/json")
            .query(&query)
    }) else {
        return Ok(None);
    };
    let body = match send_status_json(bearer).await {
        None => return Ok(None),
        Some((401, None)) => {
            let Ok(private) = client.get(&url).map(|request| {
                request
                    .header("private-token", entry.git_token.clone())
                    .header("accept", "application/json")
                    .query(&query)
            }) else {
                return Ok(None);
            };
            match send_json(private).await {
                Some(body) => body,
                None => return Ok(None),
            }
        }
        Some((_, Some(body))) => body,
        Some(_) => return Ok(None),
    };
    let Value::Array(items) = body else {
        return Ok(None);
    };
    let mapped: Vec<ProviderRepo> = items
        .iter()
        .map(|item| map_gitlab(item, &entry.git_domain))
        .collect::<Result<_, _>>()?;
    let mut refresh = Vec::new();
    if (mapped.len() as i64) < limit {
        write_cache(cache, user.id, &entry.git_domain, &repo_values(&mapped)).await;
    } else {
        refresh.push(refresh_request(Provider::Gitlab, entry, user));
    }
    Ok(Some(ProviderFetch {
        repos: mapped,
        refresh,
    }))
}

/// gitea `/user/repos` with the `X-Total-Count` completeness check.
async fn fetch_gitea(
    client: &Client,
    cache: &dyn RepositoryCache,
    entry: &ProviderEntry,
    page: i64,
    limit: i64,
    user: UserRef<'_>,
) -> Result<Option<ProviderFetch>, MapError> {
    let url = format!(
        "{}/user/repos",
        Provider::Gitea.api_base_url(&entry.git_domain)
    );
    let Ok(builder) = client.get(&url).map(|request| {
        request
            .header("authorization", format!("token {}", entry.git_token))
            .header("accept", "application/json")
            .query(&[
                ("limit", limit.to_string()),
                ("page", page.to_string()),
                ("sort", "updated".to_string()),
            ])
    }) else {
        return Ok(None);
    };
    let Some(response) = send_full(builder).await else {
        return Ok(None);
    };
    let Value::Array(items) = response.value else {
        return Ok(None);
    };
    let mapped = map_gitea(&items, &entry.git_domain)?;
    let total = response
        .headers
        .get("x-total-count")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok());
    let has_more = match total {
        Some(total) => (mapped.len() as i64) < total,
        None => (mapped.len() as i64) >= limit,
    };
    let mut refresh = Vec::new();
    if has_more {
        refresh.push(refresh_request(Provider::Gitea, entry, user));
    } else {
        write_cache(cache, user.id, &entry.git_domain, &repo_values(&mapped)).await;
    }
    Ok(Some(ProviderFetch {
        repos: mapped,
        refresh,
    }))
}

/// gerrit `/projects/` (XSSI-stripped); it always caches the full result.
async fn fetch_gerrit(
    client: &Client,
    cache: &dyn RepositoryCache,
    entry: &ProviderEntry,
    page: i64,
    limit: i64,
    user: UserRef<'_>,
) -> Result<Option<ProviderFetch>, MapError> {
    let url = format!(
        "{}/projects/",
        Provider::Gerrit.api_base_url(&entry.git_domain)
    );
    let basic = entry.auth_type == "basic";
    let Some(text) = crate::git_repositories::digest::authenticated_get(
        client,
        &url,
        &[("d", String::new())],
        &entry.user_name,
        &entry.git_token,
        basic,
    )
    .await
    else {
        return Ok(None);
    };
    let stripped = text.strip_prefix(")]}'").unwrap_or(&text);
    let Ok(Value::Object(projects)) = serde_json::from_str::<Value>(stripped) else {
        return Ok(None);
    };
    let mut repos = map_gerrit(&entry.git_domain, &projects);
    repos.sort_by(|a, b| a.full_name.cmp(&b.full_name));
    write_cache(cache, user.id, &entry.git_domain, &repo_values(&repos)).await;
    Ok(Some(ProviderFetch {
        repos: page_slice(&repos, page, limit),
        refresh: Vec::new(),
    }))
}

/// `_fetch_all_repositories_async`: paginate the provider's full list and
/// replace the domain cache. Runs on the background worker, never the request.
pub(crate) async fn refresh(
    client: &Client,
    cache: &dyn RepositoryCache,
    request: &RefreshRequest,
) {
    if cache
        .is_building(request.user_id, &request.git_domain)
        .await
    {
        return;
    }
    cache
        .set_building(request.user_id, &request.git_domain, true)
        .await;
    let result = refresh_inner(client, cache, request).await;
    if let Err(error) = result {
        tracing::warn!(
            provider = request.provider.name(),
            user = request.user_name.as_str(),
            error = ?error,
            "repository full fetch failed"
        );
    }
    cache
        .set_building(request.user_id, &request.git_domain, false)
        .await;
}

async fn refresh_inner(
    client: &Client,
    cache: &dyn RepositoryCache,
    request: &RefreshRequest,
) -> Result<(), MapError> {
    let mut all: Vec<ProviderRepo> = Vec::new();
    // github/gitlab/gitee page at 100 (max 50 pages); gitea pages at its
    // `MAX_RESPONSE_ITEMS`-safe 50 (max 100 pages).
    let per_page: i64 = if request.provider == Provider::Gitea {
        50
    } else {
        100
    };
    let max_page: i64 = if request.provider == Provider::Gitea {
        100
    } else {
        50
    };
    let mut page = 1;
    loop {
        let items = match refresh_page(client, request, page, per_page).await? {
            Some(items) if !items.is_empty() => items,
            _ => break,
        };
        let len = items.len() as i64;
        all.extend(items);
        if len < per_page || page >= max_page {
            break;
        }
        page += 1;
    }
    write_cache(
        cache,
        request.user_id,
        &request.git_domain,
        &repo_values(&all),
    )
    .await;
    Ok(())
}

/// One full-fetch page. `None` means the page request failed or ended; the
/// source's `except Exception` then aborts the loop. The gitea loop uses the
/// page-size fallback rather than its `X-Total-Count` shortcut: the fetched
/// content is identical, at most one extra empty page.
async fn refresh_page(
    client: &Client,
    request: &RefreshRequest,
    page: i64,
    per_page: i64,
) -> Result<Option<Vec<ProviderRepo>>, MapError> {
    match request.provider {
        Provider::Github | Provider::Gitee => {
            let url = format!(
                "{}/user/repos",
                request.provider.api_base_url(&request.git_domain)
            );
            let Some(builder) = client.get(&url).ok() else {
                return Ok(None);
            };
            let builder = match request.provider {
                Provider::Github => builder
                    .header("authorization", format!("token {}", request.git_token))
                    .header("accept", "application/vnd.github.v3+json")
                    .query(&page_query(per_page, page, "sort")),
                Provider::Gitee => builder.query(&[
                    ("access_token", request.git_token.clone()),
                    ("per_page", per_page.to_string()),
                    ("page", page.to_string()),
                    ("sort", "updated".to_string()),
                    ("affiliation", "owner,collaborator".to_string()),
                ]),
                _ => unreachable!(),
            };
            let Some(body) = send_json(builder).await else {
                return Ok(None);
            };
            let Value::Array(items) = body else {
                return Ok(None);
            };
            Ok(Some(match request.provider {
                Provider::Github => map_strict(&items, &request.git_domain, "github")?,
                Provider::Gitee => map_gitee(&items, &request.git_domain)?,
                _ => unreachable!(),
            }))
        }
        Provider::Gitlab => {
            let url = format!(
                "{}/projects",
                Provider::Gitlab.api_base_url(&request.git_domain)
            );
            let Some(builder) = client
                .get(&url)
                .map(|request_builder| {
                    request_builder
                        .header("private-token", request.git_token.clone())
                        .header("accept", "application/json")
                        .query(&[
                            ("per_page", per_page.to_string()),
                            ("page", page.to_string()),
                            ("order_by", "last_activity_at".to_string()),
                            ("membership", "true".to_string()),
                        ])
                })
                .ok()
            else {
                return Ok(None);
            };
            let Some(response) = send_full(builder).await else {
                return Ok(None);
            };
            let Value::Array(items) = response.value else {
                return Ok(None);
            };
            Ok(Some(
                items
                    .iter()
                    .map(|item| map_gitlab(item, &request.git_domain))
                    .collect::<Result<_, _>>()?,
            ))
        }
        Provider::Gitea => {
            let url = format!(
                "{}/user/repos",
                Provider::Gitea.api_base_url(&request.git_domain)
            );
            let Some(builder) = client
                .get(&url)
                .map(|request_builder| {
                    request_builder
                        .header("authorization", format!("token {}", request.git_token))
                        .header("accept", "application/json")
                        .query(&[
                            ("limit", per_page.to_string()),
                            ("page", page.to_string()),
                            ("sort", "updated".to_string()),
                        ])
                })
                .ok()
            else {
                return Ok(None);
            };
            let Some(body) = send_json(builder).await else {
                return Ok(None);
            };
            let Value::Array(items) = body else {
                return Ok(None);
            };
            Ok(Some(map_gitea(&items, &request.git_domain)?))
        }
        Provider::Gerrit => {
            let url = format!(
                "{}/projects/",
                Provider::Gerrit.api_base_url(&request.git_domain)
            );
            let Some(text) = crate::git_repositories::digest::authenticated_get(
                client,
                &url,
                &[("d", String::new())],
                &request.gerrit_user,
                &request.git_token,
                request.auth_type == "basic",
            )
            .await
            else {
                return Ok(None);
            };
            let stripped = text.strip_prefix(")]}'").unwrap_or(&text);
            let Ok(Value::Object(projects)) = serde_json::from_str::<Value>(stripped) else {
                return Ok(None);
            };
            let mut repos = map_gerrit(&request.git_domain, &projects);
            repos.sort_by(|a, b| a.full_name.cmp(&b.full_name));
            Ok(Some(repos))
        }
    }
}

fn page_query(limit: i64, page: i64, sort_key: &str) -> [(String, String); 3] {
    [
        ("per_page".to_string(), limit.to_string()),
        ("page".to_string(), page.to_string()),
        (sort_key.to_string(), "updated".to_string()),
    ]
}

/// The first-page request every provider's `search_repositories` performs when
/// its domain cache is still empty after the full fetch (`step 5`).
///
/// It repeats the provider's live `get_repositories` first-page request without
/// the cache write or the background full-fetch schedule, which the source's
/// fallback does not perform. `None` mirrors the source's
/// `except requests.exceptions.RequestException: continue`; gerrit's search has
/// no fallback step, so it never issues this request.
pub(crate) async fn search_fallback_page(
    client: &Client,
    provider: Provider,
    entry: &ProviderEntry,
) -> Result<Option<Vec<ProviderRepo>>, MapError> {
    match provider {
        Provider::Github => {
            let url = format!(
                "{}/user/repos",
                Provider::Github.api_base_url(&entry.git_domain)
            );
            let Ok(builder) = client.get(&url).map(|request| {
                request
                    .header("authorization", format!("token {}", entry.git_token))
                    .header("accept", "application/vnd.github.v3+json")
                    .query(&page_query(100, 1, "sort"))
            }) else {
                return Ok(None);
            };
            let Some(body) = send_json(builder).await else {
                return Ok(None);
            };
            let Value::Array(items) = body else {
                return Ok(None);
            };
            Ok(Some(map_strict(&items, &entry.git_domain, "github")?))
        }
        Provider::Gitee => {
            let url = format!(
                "{}/user/repos",
                Provider::Gitee.api_base_url(&entry.git_domain)
            );
            let Ok(builder) = client.get(&url).map(|request| {
                request.query(&[
                    ("access_token", entry.git_token.clone()),
                    ("per_page", "100".to_string()),
                    ("page", "1".to_string()),
                    ("sort", "updated".to_string()),
                    ("affiliation", "owner,collaborator".to_string()),
                ])
            }) else {
                return Ok(None);
            };
            let Some(body) = send_json(builder).await else {
                return Ok(None);
            };
            let Value::Array(items) = body else {
                return Ok(None);
            };
            Ok(Some(map_gitee(&items, &entry.git_domain)?))
        }
        Provider::Gitlab => {
            let url = format!(
                "{}/projects",
                Provider::Gitlab.api_base_url(&entry.git_domain)
            );
            let query = [
                ("per_page", "100".to_string()),
                ("page", "1".to_string()),
                ("order_by", "last_activity_at".to_string()),
                ("membership", "true".to_string()),
            ];
            let Ok(bearer) = client.get(&url).map(|request| {
                request
                    .header("authorization", format!("Bearer {}", entry.git_token))
                    .header("accept", "application/json")
                    .query(&query)
            }) else {
                return Ok(None);
            };
            let body = match send_status_json(bearer).await {
                None => return Ok(None),
                Some((401, None)) => {
                    let Ok(private) = client.get(&url).map(|request| {
                        request
                            .header("private-token", entry.git_token.clone())
                            .header("accept", "application/json")
                            .query(&query)
                    }) else {
                        return Ok(None);
                    };
                    match send_json(private).await {
                        Some(body) => body,
                        None => return Ok(None),
                    }
                }
                Some((_, Some(body))) => body,
                Some(_) => return Ok(None),
            };
            let Value::Array(items) = body else {
                return Ok(None);
            };
            Ok(Some(
                items
                    .iter()
                    .map(|item| map_gitlab(item, &entry.git_domain))
                    .collect::<Result<_, _>>()?,
            ))
        }
        Provider::Gitea => {
            let url = format!(
                "{}/user/repos",
                Provider::Gitea.api_base_url(&entry.git_domain)
            );
            let Ok(builder) = client.get(&url).map(|request| {
                request
                    .header("authorization", format!("token {}", entry.git_token))
                    .header("accept", "application/json")
                    .query(&[
                        ("limit", "100".to_string()),
                        ("page", "1".to_string()),
                        ("sort", "updated".to_string()),
                    ])
            }) else {
                return Ok(None);
            };
            let Some(body) = send_json(builder).await else {
                return Ok(None);
            };
            let Value::Array(items) = body else {
                return Ok(None);
            };
            Ok(Some(map_gitea(&items, &entry.git_domain)?))
        }
        Provider::Gerrit => Ok(None),
    }
}

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

/// Send a request and decode a successful JSON body; `None` on transport,
/// status, or decode failure (the source's `RequestException` domain skip).
async fn send_json(builder: RequestBuilder) -> Option<Value> {
    let response = builder.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

/// Like [`send_json`] but keeps the status so gitlab's 401 retry can react.
/// A non-2xx, non-401 status is a domain skip.
async fn send_status_json(builder: RequestBuilder) -> Option<(u16, Option<Value>)> {
    let response = builder.send().await.ok()?;
    let status = response.status().as_u16();
    if status == 401 {
        return Some((401, None));
    }
    if !response.status().is_success() {
        return None;
    }
    let value = response.json::<Value>().await.ok()?;
    Some((status, Some(value)))
}

/// Send a request and decode a successful body with its response headers.
async fn send_full(builder: RequestBuilder) -> Option<JsonBody> {
    let response = builder.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let headers = response.headers().clone();
    let value = response.json::<Value>().await.ok()?;
    Some(JsonBody { value, headers })
}

/// A decoded JSON body with its response headers.
struct JsonBody {
    value: Value,
    headers: brz_http::reqwest::header::HeaderMap,
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::HashMap;

    /// A cache lookup that never performs HTTP, so the recorded cache-hit path
    /// can be exercised without a provider service.
    struct StubCache {
        entries: HashMap<String, Vec<u8>>,
    }

    #[async_trait]
    impl RepositoryCache for StubCache {
        async fn get(&self, key: &str) -> Option<Vec<u8>> {
            self.entries.get(key).cloned()
        }
        async fn set(&self, _key: &str, _value: Vec<u8>) {}
        async fn is_building(&self, _user_id: i32, _git_domain: &str) -> bool {
            false
        }
        async fn set_building(&self, _user_id: i32, _git_domain: &str, _building: bool) {}
    }

    fn entry(git_domain: &str) -> ProviderEntry {
        ProviderEntry {
            git_domain: git_domain.to_string(),
            git_token: "***".to_string(),
            git_login: "hongyu9".to_string(),
            user_name: String::new(),
            auth_type: "digest".to_string(),
        }
    }

    fn client() -> Client {
        build_client().unwrap()
    }

    /// The recorded `git_repos:86:github.com` cache hit: the stored list is
    /// mapped and paginated without contacting GitHub.
    #[tokio::test]
    async fn a_domain_cache_hit_maps_and_paginates_without_http() {
        let cached = serde_json::to_vec(&serde_json::json!([
            {
                "id": 1131734767,
                "name": "Wegent",
                "full_name": "wecode-ai/Wegent",
                "clone_url": "https://github.com/wecode-ai/Wegent.git",
                "git_domain": "github.com",
                "type": "github",
                "private": false
            },
            {
                "id": 2,
                "name": "second",
                "full_name": "x/second",
                "clone_url": "https://github.com/x/second.git",
                "git_domain": "github.com",
                "type": "github",
                "private": true
            }
        ]))
        .unwrap();
        let cache = StubCache {
            entries: HashMap::from([(full_cache_key(86, "github.com"), cached)]),
        };
        let fetched = get_repositories(
            &client(),
            &cache,
            Provider::Github,
            &[entry("github.com")],
            1,
            100,
            UserRef {
                id: 86,
                name: "hongyu9",
            },
        )
        .await
        .unwrap();
        assert_eq!(fetched.repos.len(), 2);
        assert_eq!(fetched.repos[0].full_name, "wecode-ai/Wegent");
        assert!(!fetched.repos[0].private);
        assert_eq!(fetched.repos[1].kind, "github");
        assert!(fetched.refresh.is_empty());
    }

    /// An entry with no token is skipped (`if not git_token: continue`) even
    /// when the domain has a cached list.
    #[tokio::test]
    async fn an_empty_token_entry_is_skipped() {
        let cache = StubCache {
            entries: HashMap::new(),
        };
        let mut tokenless = entry("github.com");
        tokenless.git_token = String::new();
        let fetched = get_repositories(
            &client(),
            &cache,
            Provider::Github,
            &[tokenless],
            1,
            100,
            UserRef {
                id: 86,
                name: "hongyu9",
            },
        )
        .await
        .unwrap();
        assert!(fetched.repos.is_empty());
    }
}

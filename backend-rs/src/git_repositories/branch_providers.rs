// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Provider branch fetching for `GET /api/git/repositories/branches`.
//!
//! Mirrors the `get_branches` method of every `app.repository.*_provider`:
//! pick the entry with an exact stored-domain match (`_pick_git_info`), then
//! page the provider's branch list and map it into `app.schemas.github.Branch`
//! rows. Unlike `get_repositories`, no Redis cache is involved.

use brz_http::{Client, RequestBuilder};
use serde_json::Value;

use crate::git_repositories::branches::Branch;
use crate::git_repositories::crypto::decrypt_git_token;
use crate::git_repositories::projection::{build_url, git_info_items, opt_str};
use crate::git_repositories::providers::Provider;
use crate::repository_tokens::RepositoryTokenResolver;
use brz_json::OpaqueJson;

/// A provider-local failure carrying the source `HTTPException` status and
/// detail, so the service can render
/// `Error getting branches from {type}: {status}: {detail}`.
#[derive(Debug)]
pub(crate) struct BranchError {
    status: u16,
    detail: String,
}

impl BranchError {
    /// `HTTPException(status_code, detail)`.
    fn new(status: u16, detail: String) -> Self {
        Self { status, detail }
    }

    /// `str(HTTPException)`: `"{status}: {detail}"`.
    pub(crate) fn message(&self) -> String {
        format!("{}: {}", self.status, self.detail)
    }
}

/// `RepositoryService.get_branches`: the first `git_info` entry whose `type`
/// and normalized domain match, dispatched to its provider. Any provider
/// failure becomes the service's `500` wrapper; no matching entry returns an
/// empty list.
pub(crate) async fn get_branches(
    client: &Client,
    resolver: &dyn RepositoryTokenResolver,
    git_info: &OpaqueJson,
    repo_name: &str,
    kind: &str,
    git_domain: &str,
) -> Result<Vec<Branch>, String> {
    let Some(provider) = Provider::from_name(kind) else {
        // `self.providers[type]` is only consulted inside a matching entry, so
        // an unknown type never matches and the route answers `[]`.
        return Ok(Vec::new());
    };
    for item in git_info_items(git_info) {
        if opt_str(&item, "type") != kind {
            continue;
        }
        if !domains_match(&opt_str(&item, "git_domain"), git_domain) {
            continue;
        }
        // The deployment token resolver replaces the `"***"` placeholder
        // before the GitLab branch request runs.
        let mut entry = BranchEntry::new(&item);
        if provider == Provider::Gitlab && entry.git_token == "***" {
            let placeholder = entry.git_token.clone();
            let resolved = resolver
                .resolve_gitlab_token(&entry.git_login, &entry.git_domain, &placeholder)
                .await;
            if !resolved.is_empty() {
                entry.git_token = resolved;
            }
        }
        return match provider
            .get_branches(client, &entry, repo_name, git_domain)
            .await
        {
            Ok(branches) => Ok(branches),
            Err(error) => Err(format!(
                "Error getting branches from {}: {}",
                kind,
                error.message()
            )),
        };
    }
    Ok(Vec::new())
}

/// `shared.utils.url_util.domains_match`: normalized equality (protocol and
/// trailing slashes stripped; case preserved).
pub(crate) fn domains_match(left: &str, right: &str) -> bool {
    normalize_domain(left) == normalize_domain(right)
}

/// `shared.utils.url_util.normalize_domain`.
fn normalize_domain(domain: &str) -> String {
    let domain = domain.trim();
    let domain = domain
        .strip_prefix("http://")
        .or_else(|| domain.strip_prefix("https://"))
        .unwrap_or(domain);
    domain.trim_end_matches('/').to_string()
}

/// One `git_info` entry as the provider's `_get_git_infos` renders it: the
/// stored domain, the decrypted token, the login, and gerrit's
/// username/auth type.
pub(crate) struct BranchEntry {
    git_domain: String,
    git_token: String,
    git_login: String,
    user_name: String,
    auth_type: String,
}

impl BranchEntry {
    /// `_get_git_infos`'s per-entry projection (decrypted token; `user_name`
    /// and `auth_type` exist only for gitea/gerrit entries).
    fn new(item: &serde_json::Map<String, Value>) -> Self {
        Self {
            git_domain: opt_str(item, "git_domain"),
            git_token: decrypt_git_token(&opt_str(item, "git_token")).unwrap_or_default(),
            git_login: opt_str(item, "git_login"),
            user_name: opt_str(item, "user_name"),
            auth_type: {
                let value = opt_str(item, "auth_type");
                if value.is_empty() {
                    "digest".to_string()
                } else {
                    value
                }
            },
        }
    }
}

impl Provider {
    /// The provider's own `get_branches(user, repo_name, git_domain)`.
    async fn get_branches(
        self,
        client: &Client,
        entry: &BranchEntry,
        repo_name: &str,
        git_domain: &str,
    ) -> Result<Vec<Branch>, BranchError> {
        // `_pick_git_info`'s exact-domain filter: the provider re-selects the
        // entry with `e.get("git_domain") == git_domain` (no normalization),
        // so a stored domain that only matches after normalization answers
        // the provider's `400 Git information for {domain} not configured`.
        if entry.git_domain != git_domain {
            return Err(BranchError::new(
                400,
                format!("Git information for {git_domain} not configured"),
            ));
        }
        match self {
            Provider::Gitlab => gitlab_branches(client, entry, repo_name).await,
            Provider::Github | Provider::Gitee | Provider::Gitea => {
                flat_branches(client, self, entry, repo_name).await
            }
            Provider::Gerrit => gerrit_branches(client, entry, repo_name).await,
        }
    }
}

/// github/gitee/gitea: page `/repos/{repo}/branches` and mark the default
/// branch from a separate repo lookup, exactly like each provider's
/// `get_branches` + `_get_default_branch` pair.
async fn flat_branches(
    client: &Client,
    provider: Provider,
    entry: &BranchEntry,
    repo_name: &str,
) -> Result<Vec<Branch>, BranchError> {
    if entry.git_token.is_empty() {
        return Err(BranchError::new(
            400,
            "Git token not configured".to_string(),
        ));
    }
    let api_base = api_base(provider, &entry.git_domain);
    let default_branch = default_branch(client, provider, entry, repo_name, &api_base).await;
    let mut all: Vec<Value> = Vec::new();
    let mut page: i64 = 1;
    loop {
        let query: Vec<(String, String)> = match provider {
            Provider::Gitea => vec![
                ("limit".to_string(), "100".to_string()),
                ("page".to_string(), page.to_string()),
            ],
            _ => vec![
                ("per_page".to_string(), "100".to_string()),
                ("page".to_string(), page.to_string()),
            ],
        };
        let builder = client
            .get(format!("{api_base}/repos/{repo_name}/branches"))
            .map_err(|_| request_error(provider))?
            .query(&query);
        let builder = match provider {
            Provider::Github => builder
                .header("authorization", format!("token {}", entry.git_token))
                .header("accept", "application/vnd.github.v3+json"),
            Provider::Gitea => builder
                .header("authorization", format!("token {}", entry.git_token))
                .header("accept", "application/json"),
            Provider::Gitee => builder.query(&[("access_token", entry.git_token.clone())]),
            _ => unreachable!("flat_branches handles github, gitee and gitea only"),
        };
        let items = send_page(builder, provider).await?;
        let done = items.is_empty();
        all.extend(items);
        page += 1;
        if done || page > 50 {
            break;
        }
    }
    Ok(map_flat_branches(&all, &default_branch))
}

/// `Branch(name=..., protected=..., default=... or name == default_branch)`.
fn map_flat_branches(all: &[Value], default_branch: &str) -> Vec<Branch> {
    all.iter()
        .filter_map(|branch| {
            let name = branch.get("name")?.as_str()?.to_string();
            let protected = branch.get("protected").and_then(Value::as_bool) == Some(true);
            let is_default = branch.get("default").and_then(Value::as_bool) == Some(true)
                || name == default_branch;
            Some(Branch::new(name, protected, is_default))
        })
        .collect()
}

/// `_get_default_branch`: the repo lookup's `default_branch` field with the
/// provider's fallback (`main` for github/gitea, `master` for gitee); every
/// failure keeps the fallback.
async fn default_branch(
    client: &Client,
    provider: Provider,
    entry: &BranchEntry,
    repo_name: &str,
    api_base: &str,
) -> String {
    let fallback = match provider {
        Provider::Gitee => "master",
        _ => "main",
    };
    let Ok(builder) = client.get(format!("{api_base}/repos/{repo_name}")) else {
        return fallback.to_string();
    };
    let builder = match provider {
        Provider::Github => builder
            .header("authorization", format!("token {}", entry.git_token))
            .header("accept", "application/vnd.github.v3+json"),
        Provider::Gitee => builder.query(&[("access_token", entry.git_token.clone())]),
        Provider::Gitea => builder
            .header("authorization", format!("token {}", entry.git_token))
            .header("accept", "application/json"),
        _ => unreachable!("default_branch handles github, gitee and gitea only"),
    };
    let Ok(response) = builder.send().await else {
        return fallback.to_string();
    };
    if !response.status().is_success() {
        return fallback.to_string();
    }
    let Ok(Value::Object(repo)) = response.json::<Value>().await else {
        return fallback.to_string();
    };
    repo.get("default_branch")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

/// `_make_request_with_auth_retry` + pagination for gitlab:
/// `Bearer` first, `Private-Token` after a 401, paging to the first empty
/// page, with the provider's 404-to-empty mapping.
async fn gitlab_branches(
    client: &Client,
    entry: &BranchEntry,
    repo_name: &str,
) -> Result<Vec<Branch>, BranchError> {
    if entry.git_token.is_empty() {
        return Err(BranchError::new(
            400,
            "Git token not configured".to_string(),
        ));
    }
    let api_base = api_base(Provider::Gitlab, &entry.git_domain);
    let encoded = repo_name.replace('/', "%2F");
    let url = format!("{api_base}/projects/{encoded}/repository/branches");
    let mut all: Vec<Value> = Vec::new();
    let mut page: i64 = 1;
    loop {
        let query = [
            ("per_page".to_string(), "100".to_string()),
            ("page".to_string(), page.to_string()),
        ];
        let bearer = client
            .get(&url)
            .map_err(|_| gitlab_request_error())?
            .header("authorization", format!("Bearer {}", entry.git_token))
            .header("accept", "application/json")
            .query(&query);
        match send_gitlab_page(client, &url, &query, bearer, &entry.git_token).await? {
            Some(items) if items.is_empty() => break,
            Some(items) => {
                all.extend(items);
                page += 1;
                if page > 50 {
                    break;
                }
            }
            None => break,
        }
    }
    Ok(all
        .iter()
        .filter_map(|branch| {
            let name = branch.get("name")?.as_str()?.to_string();
            Some(Branch::new(
                name,
                branch.get("protected").and_then(Value::as_bool) == Some(true),
                branch.get("default").and_then(Value::as_bool) == Some(true),
            ))
        })
        .collect())
}

/// One gitlab page through the Bearer-then-Private-Token retry. `Some(empty)`
/// is the provider's 404-to-empty mapping; `None` ends pagination for a
/// transport-shaped failure the service reports.
async fn send_gitlab_page(
    client: &Client,
    url: &str,
    query: &[(String, String); 2],
    bearer: RequestBuilder,
    token: &str,
) -> Result<Option<Vec<Value>>, BranchError> {
    let response = bearer.send().await.map_err(|_| gitlab_request_error())?;
    let status = response.status().as_u16();
    if status == 404 {
        // `e.response.status_code == 404` -> `return []`.
        return Ok(Some(Vec::new()));
    }
    if status == 401 {
        let private = client
            .get(url)
            .map_err(|_| gitlab_request_error())?
            .header("private-token", token)
            .header("accept", "application/json")
            .query(query);
        let response = private.send().await.map_err(|_| gitlab_request_error())?;
        let status = response.status().as_u16();
        if status == 404 {
            return Ok(Some(Vec::new()));
        }
        if !(200..300).contains(&status) {
            return Err(gitlab_request_error_with_status(status));
        }
        return match response.json::<Value>().await {
            Ok(Value::Array(items)) => Ok(Some(items)),
            _ => Err(gitlab_request_error_with_status(status)),
        };
    }
    if !(200..300).contains(&status) {
        return Err(gitlab_request_error_with_status(status));
    }
    match response.json::<Value>().await {
        Ok(Value::Array(items)) => Ok(Some(items)),
        _ => Err(gitlab_request_error_with_status(status)),
    }
}

/// `HTTPException(502, f"GitLab API error: {e}")`.
fn gitlab_request_error() -> BranchError {
    BranchError::new(502, "GitLab API error".to_string())
}

/// The same 502 with the refused status in the exception text, matching
/// `str(HTTPError)`'s leading status.
fn gitlab_request_error_with_status(status: u16) -> BranchError {
    BranchError::new(
        502,
        format!("{status} Error for url: gitlab branches request"),
    )
}

/// gerrit: `GET /projects/{quoted}/branches/` plus the `HEAD` default-branch
/// lookup, both through the digest/basic authenticated helper.
async fn gerrit_branches(
    client: &Client,
    entry: &BranchEntry,
    repo_name: &str,
) -> Result<Vec<Branch>, BranchError> {
    if entry.git_token.is_empty() || entry.user_name.is_empty() {
        return Err(BranchError::new(
            400,
            "Gerrit credentials not configured".to_string(),
        ));
    }
    let api_base = api_base(Provider::Gerrit, &entry.git_domain);
    let basic = entry.auth_type == "basic";
    let encoded = percent_encode(repo_name);
    let Some(text) = crate::git_repositories::digest::authenticated_get(
        client,
        &format!("{api_base}/projects/{encoded}/branches/"),
        &[],
        &entry.user_name,
        &entry.git_token,
        basic,
    )
    .await
    else {
        return Err(gerrit_request_error());
    };
    let stripped = text.strip_prefix(")]}'").unwrap_or(&text);
    let Ok(Value::Array(branches)) = serde_json::from_str::<Value>(stripped) else {
        return Err(gerrit_request_error());
    };
    let default_branch = gerrit_default_branch(client, entry, &api_base, &encoded).await;
    let mut mapped = Vec::new();
    for branch in &branches {
        let Some(reference) = branch.get("ref").and_then(Value::as_str) else {
            continue;
        };
        let name = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        if name.is_empty() {
            continue;
        }
        // Gerrit does not expose a protected flag in the branch list.
        mapped.push(Branch::new(name.to_string(), false, name == default_branch));
    }
    Ok(mapped)
}

/// `GerritProvider._get_default_branch`: the quoted `HEAD` reference with the
/// `refs/heads/` prefix stripped, defaulting to `master`.
async fn gerrit_default_branch(
    client: &Client,
    entry: &BranchEntry,
    api_base: &str,
    encoded: &str,
) -> String {
    let Some(text) = crate::git_repositories::digest::authenticated_get(
        client,
        &format!("{api_base}/projects/{encoded}/HEAD"),
        &[],
        &entry.user_name,
        &entry.git_token,
        entry.auth_type == "basic",
    )
    .await
    else {
        return "master".to_string();
    };
    let head = text.trim().trim_matches('"');
    head.strip_prefix("refs/heads/")
        .unwrap_or("master")
        .to_string()
}

/// `HTTPException(502, f"Gerrit API error: {e}")`.
fn gerrit_request_error() -> BranchError {
    BranchError::new(502, "Gerrit API error".to_string())
}

/// One provider page request; a failed or non-2xx response is the provider's
/// 502 (`raise_for_status` inside the `except RequestException` arm).
async fn send_page(builder: RequestBuilder, provider: Provider) -> Result<Vec<Value>, BranchError> {
    let response = builder.send().await.map_err(|_| request_error(provider))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(request_error(provider));
    }
    match response.json::<Value>().await {
        Ok(Value::Array(items)) => Ok(items),
        _ => Err(request_error(provider)),
    }
}

/// `HTTPException(502, f"{Provider} API error: {e}")`.
fn request_error(provider: Provider) -> BranchError {
    BranchError::new(502, format!("{} API error", provider.name()))
}

/// `_get_api_base_url` for the branch endpoints: the provider's fixed default
/// for its own domain, otherwise the per-domain API root.
fn api_base(provider: Provider, git_domain: &str) -> String {
    match provider {
        Provider::Github => provider_api_base_url(git_domain, "github.com", GITHUB_API, "/api/v3"),
        Provider::Gitlab => provider_api_base_url(git_domain, "gitlab.com", GITLAB_API, "/api/v4"),
        Provider::Gitee => provider_api_base_url(git_domain, "gitee.com", GITEE_API, "/api/v5"),
        Provider::Gitea => provider_api_base_url(git_domain, "gitea.com", GITEA_API, "/api/v1"),
        Provider::Gerrit => build_url(git_domain, "/a"),
    }
}

use crate::git_repositories::projection::provider_api_base_url;

/// `_get_api_base_url`'s fixed defaults.
const GITHUB_API: &str = "https://api.github.com";
const GITLAB_API: &str = "https://gitlab.com/api/v4";
const GITEE_API: &str = "https://gitee.com/api/v5";
const GITEA_API: &str = "https://gitea.com/api/v1";

/// `requests.utils.quote(name, safe="")` for a gerrit project path.
fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_match_uses_protocol_and_slash_normalization() {
        assert!(domains_match("github.com", "github.com"));
        assert!(domains_match("http://github.com", "https://github.com"));
        assert!(domains_match(
            "https://gitlab.example.cn/",
            "gitlab.example.cn"
        ));
        assert!(!domains_match("github.com", "gitlab.com"));
        assert!(!domains_match("GitHub.com", "github.com"));
        assert!(domains_match("", ""));
    }

    #[test]
    fn gerrit_project_names_are_fully_percent_encoded() {
        assert_eq!(percent_encode("path/to/project"), "path%2Fto%2Fproject");
        assert_eq!(percent_encode("plain"), "plain");
        assert_eq!(percent_encode("a b"), "a%20b");
    }

    #[test]
    fn flat_branch_mapping_marks_the_default_branch() {
        let all = serde_json::json!([
            {"name": "main", "protected": true, "default": false},
            {"name": "dev", "protected": false}
        ]);
        let branches = map_flat_branches(all.as_array().unwrap(), "main");
        assert_eq!(branches.len(), 2);
        let rendered = crate::json_contract_tests::serialized(&branches).unwrap();
        assert_eq!(
            rendered[0],
            serde_json::json!({"name": "main", "protected": true, "default": true})
        );
        assert_eq!(
            rendered[1],
            serde_json::json!({"name": "dev", "protected": false, "default": false})
        );
    }

    #[test]
    fn api_base_uses_the_fixed_default_for_the_own_domain() {
        assert_eq!(api_base(Provider::Gitlab, ""), GITLAB_API);
        assert_eq!(api_base(Provider::Gitlab, "gitlab.com"), GITLAB_API);
        assert_eq!(
            api_base(Provider::Gitlab, "git.example.com"),
            "https://git.example.com/api/v4"
        );
        assert_eq!(
            api_base(Provider::Gerrit, "gerrit.example.com"),
            "https://gerrit.example.com/a"
        );
    }

    #[test]
    fn branch_error_message_renders_the_http_exception_string() {
        let error = BranchError::new(502, "GitLab API error: boom".to_string());
        assert_eq!(error.message(), "502: GitLab API error: boom");
    }
}

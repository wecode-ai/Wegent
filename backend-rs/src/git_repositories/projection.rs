// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The repository projection shared by the provider cache and live paths.
//!
//! Every provider's `get_repositories` maps its API shape (or the cached list)
//! into the same seven-field row — `id`, `name`, `full_name`, `clone_url`,
//! `git_domain`, `type`, `private` — which is both what the route renders and
//! what the domain cache stores. These helpers also carry the source's
//! `_get_api_base_url`/`build_url` URL construction and the request page slice.
use serde_json::{Map, Value};

use crate::git_repositories::cache::{RepositoryCache, full_cache_key};
use crate::git_repositories::providers::{MapError, Provider};
use brz_json::OpaqueJson;

/// One mapped repository row (`Repository.model_dump()` / the cached dict).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderRepo {
    pub(crate) id: i64,
    pub(crate) name: String,
    pub(crate) full_name: String,
    pub(crate) clone_url: String,
    pub(crate) git_domain: String,
    pub(crate) kind: &'static str,
    pub(crate) private: bool,
}

impl ProviderRepo {
    /// The cached/mapped projection in the source dict's key order.
    pub(crate) fn to_json(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "full_name": self.full_name,
            "clone_url": self.clone_url,
            "git_domain": self.git_domain,
            "type": self.kind,
            "private": self.private,
        })
    }
}

/// `_fetch_all_repositories_async`/single-page cache writes: `orjson.dumps`.
pub(crate) async fn write_cache(
    cache: &dyn RepositoryCache,
    user_id: i32,
    git_domain: &str,
    value: &[Value],
) {
    cache
        .set(
            &full_cache_key(user_id, git_domain),
            serde_json::to_vec(value).unwrap_or_default(),
        )
        .await;
}

/// `all_repos[start:end]`: Python slice semantics for the request's page.
pub(crate) fn page_slice<T: Clone>(items: &[T], page: i64, limit: i64) -> Vec<T> {
    let start = (page.max(1) - 1).saturating_mul(limit.max(0));
    let start = usize::try_from(start).unwrap_or(usize::MAX);
    let take = usize::try_from(limit.max(0)).unwrap_or(usize::MAX);
    items.iter().skip(start).take(take).cloned().collect()
}

fn fixed_default(domain: &str, own: &str, fixed: &str, path: &str) -> String {
    if domain.is_empty() || domain == own {
        fixed.to_string()
    } else {
        build_url(domain, path)
    }
}

/// The provider's `_get_api_base_url` for its own domain or a custom domain.
pub(crate) fn provider_api_base_url(domain: &str, own: &str, fixed: &str, path: &str) -> String {
    fixed_default(domain, own, fixed, path)
}

/// `shared.utils.url_util.build_url(domain, path)`.
pub(crate) fn build_url(domain: &str, path: &str) -> String {
    let base = if domain.starts_with("http://") || domain.starts_with("https://") {
        domain.trim_end_matches('/').to_string()
    } else {
        format!("https://{domain}")
    };
    if path.is_empty() {
        return base;
    }
    format!("{base}/{}", path.trim_start_matches('/'))
}

/// The stored `git_info` list's object members (`isinstance(item, dict)`).
pub(crate) fn git_info_items(git_info: &OpaqueJson) -> Vec<Map<String, Value>> {
    match git_info.project::<Value>() {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| match item {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `str(value or "")`.
pub(crate) fn opt_str(map: &Map<String, Value>, key: &str) -> String {
    match map.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

pub(crate) fn repo_values(repos: &[ProviderRepo]) -> Vec<Value> {
    repos.iter().map(ProviderRepo::to_json).collect()
}

/// `_decode` on the cached value: the stored list, or `None` when the bytes
/// are absent or not a JSON array.
pub(crate) fn decode_cached(bytes: &[u8]) -> Option<Vec<Value>> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Array(items)) => Some(items),
        _ => None,
    }
}

/// The cached list's entries rendered through the provider's own mapper.
pub(crate) fn map_cached(
    provider: Provider,
    domain: &str,
    items: &[Value],
) -> Result<Vec<ProviderRepo>, MapError> {
    match provider {
        Provider::Gitea => map_gitea(items, domain),
        Provider::Github => map_strict(items, domain, "github"),
        Provider::Gitlab => map_strict(items, domain, "gitlab"),
        Provider::Gitee => map_strict(items, domain, "gitee"),
        Provider::Gerrit => map_strict(items, domain, "gerrit"),
    }
}

/// The strict mapping shared by github/gitlab/gitee/gerrit.
pub(crate) fn map_strict(
    items: &[Value],
    domain: &str,
    kind: &'static str,
) -> Result<Vec<ProviderRepo>, MapError> {
    items
        .iter()
        .map(|item| {
            Ok(ProviderRepo {
                id: int_of(item, "id")?,
                name: str_of(item, "name")?,
                full_name: str_of(item, "full_name")?,
                clone_url: str_of(item, "clone_url")?,
                git_domain: domain.to_string(),
                kind,
                private: bool_of(item, "private")?,
            })
        })
        .collect()
}

/// gitee's mapping (`clone_url` is the stored `html_url`).
pub(crate) fn map_gitee(items: &[Value], domain: &str) -> Result<Vec<ProviderRepo>, MapError> {
    items
        .iter()
        .map(|item| {
            Ok(ProviderRepo {
                id: int_of(item, "id")?,
                name: str_of(item, "name")?,
                full_name: str_of(item, "full_name")?,
                clone_url: opt_str_object(item, "html_url"),
                git_domain: domain.to_string(),
                kind: "gitee",
                private: item
                    .get("private")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// gitlab's `/projects` mapping.
pub(crate) fn map_gitlab(item: &Value, domain: &str) -> Result<ProviderRepo, MapError> {
    Ok(ProviderRepo {
        id: int_of(item, "id")?,
        name: str_of(item, "name")?,
        full_name: str_of(item, "path_with_namespace")?,
        clone_url: str_of(item, "http_url_to_repo")?,
        git_domain: domain.to_string(),
        kind: "gitlab",
        private: item.get("visibility").and_then(Value::as_str) == Some("private"),
    })
}

/// gitea's lenient mapping (`full_name`/`clone_url` fall back to
/// `name`/`html_url`); a missing `id` is the source's `KeyError`.
pub(crate) fn map_gitea(items: &[Value], domain: &str) -> Result<Vec<ProviderRepo>, MapError> {
    items
        .iter()
        .map(|item| {
            Ok(ProviderRepo {
                id: int_of(item, "id")?,
                name: opt_str_object(item, "name"),
                full_name: fallback(item, "full_name", "name"),
                clone_url: first_nonempty(item, "clone_url", "html_url"),
                git_domain: domain.to_string(),
                kind: "gitea",
                private: item
                    .get("private")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// gerrit's project map (`project_name -> info`), with a stable name-derived
/// id and the `<domain>/<project>.git` clone URL.
pub(crate) fn map_gerrit(domain: &str, projects: &Map<String, Value>) -> Vec<ProviderRepo> {
    projects
        .keys()
        .map(|project_name| ProviderRepo {
            id: gerrit_id(project_name),
            name: project_name
                .rsplit('/')
                .next()
                .unwrap_or(project_name)
                .to_string(),
            full_name: project_name.clone(),
            clone_url: format!("{}/{}.git", build_url(domain, ""), project_name),
            git_domain: domain.to_string(),
            kind: "gerrit",
            private: true,
        })
        .collect()
}

/// `abs(hash(project_name)) % 10**10`. Python's `hash` is randomized per
/// process, so the target uses a stable FNV-1a digest: the value is only an
/// internal identifier for the cached row.
fn gerrit_id(name: &str) -> i64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in name.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    (hash % 10_000_000_000) as i64
}

fn object(map: &Value) -> Result<&Map<String, Value>, MapError> {
    map.as_object().ok_or(MapError::Malformed)
}

fn int_of(value: &Value, key: &str) -> Result<i64, MapError> {
    object(value)?
        .get(key)
        .and_then(Value::as_i64)
        .ok_or(MapError::Malformed)
}

fn str_of(value: &Value, key: &str) -> Result<String, MapError> {
    object(value)?
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or(MapError::Malformed)
}

fn bool_of(value: &Value, key: &str) -> Result<bool, MapError> {
    object(value)?
        .get(key)
        .and_then(Value::as_bool)
        .ok_or(MapError::Malformed)
}

fn opt_str_object(value: &Value, key: &str) -> String {
    match value.as_object().and_then(|map| map.get(key)) {
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn fallback(value: &Value, key: &str, alt: &str) -> String {
    match value.as_object().and_then(|map| map.get(key)) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => opt_str_object(value, alt),
        Some(_) => opt_str_object(value, alt),
    }
}

/// `repo.get("clone_url") or repo.get("html_url", "")`.
fn first_nonempty(value: &Value, key: &str, alt: &str) -> String {
    match value.as_object().and_then(|map| map.get(key)) {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        _ => opt_str_object(value, alt),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_url_matches_the_source_helper() {
        assert_eq!(build_url("example.com", "/api"), "https://example.com/api");
        assert_eq!(
            build_url("http://example.com", "/api"),
            "http://example.com/api"
        );
        assert_eq!(
            build_url("https://example.com/", "api"),
            "https://example.com/api"
        );
        assert_eq!(
            build_url("git.example.invalid", ""),
            "https://git.example.invalid"
        );
    }

    #[test]
    fn page_slice_matches_python_slicing_and_clamps() {
        let items: Vec<i64> = (0..5).collect();
        assert_eq!(page_slice(&items, 1, 2), vec![0, 1]);
        assert_eq!(page_slice(&items, 2, 2), vec![2, 3]);
        assert_eq!(page_slice(&items, 3, 2), vec![4]);
        // A limit beyond the list keeps every remaining element.
        assert_eq!(page_slice(&items, 1, 5000), items);
    }

    #[test]
    fn strict_mapping_rejects_a_missing_field() {
        let items = vec![serde_json::json!({"id": 1, "name": "a"})];
        assert!(matches!(
            map_strict(&items, "github.com", "github"),
            Err(MapError::Malformed)
        ));
    }

    #[test]
    fn gitea_mapping_uses_the_lenient_field_fallbacks() {
        let items = vec![serde_json::json!({
            "id": 7,
            "name": "plain",
            "html_url": "https://gitea.example.invalid/plain.git"
        })];
        let mapped = map_gitea(&items, "gitea.example.invalid").unwrap();
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].full_name, "plain");
        assert_eq!(
            mapped[0].clone_url,
            "https://gitea.example.invalid/plain.git"
        );
        assert!(!mapped[0].private);
    }

    #[test]
    fn gitlab_mapping_reads_the_path_namespace_and_visibility() {
        let item = serde_json::json!({
            "id": 25,
            "name": "proj",
            "path_with_namespace": "group/proj",
            "http_url_to_repo": "https://git.example.invalid/group/proj.git",
            "visibility": "private"
        });
        let mapped = map_gitlab(&item, "git.example.invalid").unwrap();
        assert_eq!(mapped.full_name, "group/proj");
        assert!(mapped.private);
        assert_eq!(mapped.kind, "gitlab");
    }

    #[test]
    fn cached_projection_round_trips_through_to_json() {
        let repo = ProviderRepo {
            id: 1,
            name: "n".to_string(),
            full_name: "o/n".to_string(),
            clone_url: "https://git.example.invalid/o/n.git".to_string(),
            git_domain: "git.example.invalid".to_string(),
            kind: "gitlab",
            private: true,
        };
        assert_eq!(
            repo.to_json(),
            serde_json::json!({
                "id": 1,
                "name": "n",
                "full_name": "o/n",
                "clone_url": "https://git.example.invalid/o/n.git",
                "git_domain": "git.example.invalid",
                "type": "gitlab",
                "private": true,
            })
        );
    }
}

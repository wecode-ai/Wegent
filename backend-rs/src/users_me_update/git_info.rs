// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `git_info` update for `PUT /api/users/me`:
//! `app.services.user.UserService._validate_git_info` plus the merge inside
//! `update_current_user`.
//!
//! Every incoming `GitInfo` is `model_dump()`-materialized (all nine declared
//! fields, unset as `null`), validated against its provider's `validate_token`
//! (`app.repository.*_provider`), its token encrypted for storage, and its
//! `id` filled with a fresh UUID when absent. The validated entries are then
//! merged onto the stored list by `id`, falling back to a `git_domain:git_token`
//! key, exactly like the source's two ordered maps.
use brz_http::Client;
use serde_json::{Map, Value};

use crate::git_repositories::crypto::{decrypt_git_token, encrypt_git_token, is_token_encrypted};
use crate::wework_auth_tokens::uuid4_hex;

/// `GitInfo` field names in declaration order (`model_dump()` order).
const GIT_INFO_FIELDS: [&str; 9] = [
    "id",
    "git_domain",
    "git_token",
    "type",
    "user_name",
    "git_id",
    "git_login",
    "git_email",
    "auth_type",
];

/// `_validate_git_info` + the merge: the validated, encrypted incoming entries
/// merged onto the stored list. `Err` is the source exception message.
pub(super) async fn merge(
    client: &Client,
    existing: &Value,
    incoming: &[Map<String, Value>],
) -> Result<Vec<Value>, String> {
    let existing_items: Vec<Map<String, Value>> = match existing {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_object().cloned())
            .collect(),
        _ => Vec::new(),
    };
    let mut validated = Vec::with_capacity(incoming.len());
    for entry in incoming {
        validated.push(validate_entry(client, entry).await?);
    }
    Ok(merge_lists(&existing_items, &validated))
}

/// One validated provider identity: `git_id`, `git_login`, `git_email`.
struct ProviderUser {
    id: String,
    login: String,
    email: String,
}

/// `_validate_git_info` for one entry: the required-field checks, the provider
/// `validate_token` call, token encryption and the UUID default.
async fn validate_entry(
    client: &Client,
    entry: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let mut item: Map<String, Value> = GIT_INFO_FIELDS
        .iter()
        .map(|field| {
            (
                (*field).to_string(),
                entry.get(*field).cloned().unwrap_or(Value::Null),
            )
        })
        .collect();

    let token = non_empty(&item, "git_token").ok_or("git_token is required")?;
    let domain = non_empty(&item, "git_domain").ok_or("git_domain is required")?;
    let kind = non_empty(&item, "type").ok_or("type is required")?;
    if !matches!(
        kind.as_str(),
        "github" | "gitlab" | "gitee" | "gitea" | "gerrit"
    ) {
        return Err(format!("Unsupported provider type: {kind}"));
    }
    let user_name = non_empty(&item, "user_name");
    if kind == "gerrit" && user_name.is_none() {
        return Err("username is required for Gerrit".to_string());
    }

    let plain = decrypt_git_token(&token).map_err(|_| format!("{kind} token validation failed"))?;
    let user = provider_validate(client, &kind, &plain, &domain, &item).await?;

    item.insert("git_id".to_string(), Value::String(user.id));
    item.insert("git_login".to_string(), Value::String(user.login));
    item.insert("git_email".to_string(), Value::String(user.email));
    if !is_token_encrypted(&token) {
        let encrypted = encrypt_git_token(&token)
            .map_err(|error| format!("{kind} token validation failed: {error:?}"))?;
        item.insert("git_token".to_string(), Value::String(encrypted));
    }
    if non_empty(&item, "id").is_none() {
        let id = uuid4_hex().map_err(|error| error.validation_detail())?;
        item.insert("id".to_string(), Value::String(id));
    }
    Ok(item)
}

fn non_empty(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// `provider.validate_token(...)`: the provider identity, or the source
/// `ValidationException` message.
async fn provider_validate(
    client: &Client,
    kind: &str,
    token: &str,
    domain: &str,
    item: &Map<String, Value>,
) -> Result<ProviderUser, String> {
    match kind {
        "github" => {
            let url = format!(
                "{}/user",
                base_url(domain, "github.com", "https://api.github.com", "/api/v3")
            );
            let builder = client
                .get(&url)
                .map(|request| {
                    request
                        .header("authorization", format!("token {token}"))
                        .header("accept", "application/vnd.github.v3+json")
                })
                .map_err(|error| format!("github token validation failed: {error}"))?;
            github_like(builder, "github", "login").await
        }
        "gitea" => {
            let url = format!(
                "{}/user",
                base_url(domain, "gitea.com", "https://gitea.com/api/v1", "/api/v1")
            );
            let builder = client
                .get(&url)
                .map(|request| {
                    request
                        .header("authorization", format!("token {token}"))
                        .header("accept", "application/json")
                })
                .map_err(|error| format!("gitea token validation failed: {error}"))?;
            github_like(builder, "gitea", "login").await
        }
        "gitlab" => {
            let url = format!(
                "{}/user",
                base_url(domain, "gitlab.com", "https://gitlab.com/api/v4", "/api/v4")
            );
            // Bearer first, then Private-Token on 401.
            let bearer = client
                .get(&url)
                .map(|request| {
                    request
                        .header("authorization", format!("Bearer {token}"))
                        .header("accept", "application/json")
                })
                .map_err(|error| format!("gitlab token validation failed: {error}"))?;
            if let Some((status, body)) = send_status(bearer).await {
                if status == 401 {
                    let private = client
                        .get(&url)
                        .map(|request| {
                            request
                                .header("private-token", token)
                                .header("accept", "application/json")
                        })
                        .map_err(|error| format!("gitlab token validation failed: {error}"))?;
                    if let Some((status, body)) = send_status(private).await {
                        if status == 401 {
                            return Err("Invalid gitlab token".to_string());
                        }
                        return Ok(gitlab_user(body));
                    }
                    return Err("gitlab API error".to_string());
                }
                return Ok(gitlab_user(body));
            }
            Err("gitlab API error".to_string())
        }
        "gitee" => {
            let url = format!(
                "{}/user",
                base_url(domain, "gitee.com", "https://gitee.com/api/v5", "/api/v5")
            );
            let builder = client
                .get(&url)
                .map(|request| request.query(&[("access_token", token.to_string())]))
                .map_err(|error| format!("gitee token validation failed: {error}"))?;
            github_like(builder, "gitee", "login").await
        }
        "gerrit" => gerrit_validate(client, token, domain, item).await,
        _ => Err(format!("Unsupported provider type: {kind}")),
    }
}

/// A GitHub/Gitea/Gitee-style `GET /user` where `401` means an invalid token.
async fn github_like(
    builder: brz_http::RequestBuilder,
    kind: &str,
    login_field: &str,
) -> Result<ProviderUser, String> {
    let Some((status, body)) = send_status(builder).await else {
        return Err(format!("{kind} API error"));
    };
    if status == 401 {
        return Err(format!("Invalid {kind} token"));
    }
    let body = body.unwrap_or(Value::Null);
    let mut user = provider_user(&body, login_field, "login");
    user.id = body.get("id").map(id_string).unwrap_or_default();
    Ok(user)
}

fn gitlab_user(body: Option<Value>) -> ProviderUser {
    let body = body.unwrap_or(Value::Null);
    ProviderUser {
        id: body.get("id").map(id_string).unwrap_or_default(),
        login: body
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        email: body
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn provider_user(body: &Value, login_field: &str, _default: &str) -> ProviderUser {
    ProviderUser {
        id: body.get("id").map(id_string).unwrap_or_default(),
        login: body
            .get(login_field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        email: body
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

/// `str(user_data.get("id", ""))`.
fn id_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Gerrit HTTP auth (`GET {base}/accounts/self/`).
async fn gerrit_validate(
    client: &Client,
    token: &str,
    domain: &str,
    item: &Map<String, Value>,
) -> Result<ProviderUser, String> {
    use base64::Engine as _;
    let user_name = non_empty(item, "user_name").unwrap_or_default();
    let auth_type = non_empty(item, "auth_type").unwrap_or_else(|| "digest".to_string());
    if auth_type != "basic" {
        // Gerrit's default `digest` HTTP auth has no counterpart in the
        // retained HTTP client; reported as a missing capability.
        return Err(format!(
            "Authentication failed. Please check if the auth method ({auth_type}) is correct."
        ));
    }
    let url = format!("{}/accounts/self/", base_url(domain, "", "", "/a"));
    let credential =
        base64::engine::general_purpose::STANDARD.encode(format!("{user_name}:{token}"));
    let builder = client
        .get(&url)
        .map(|request| {
            request
                .header("authorization", format!("Basic {credential}"))
                .header("accept", "application/json")
        })
        .map_err(|error| format!("gerrit token validation failed: {error}"))?;
    let Some(response) = send_raw(builder).await else {
        return Err("Gerrit API error".to_string());
    };
    if response.0 == 401 {
        return Err(format!(
            "Authentication failed. Please check if the auth method ({auth_type}) is correct."
        ));
    }
    if !(200..300).contains(&response.0) {
        return Err(format!("Gerrit API error: status {}", response.0));
    }
    let text = response.1.strip_prefix(")]}'").unwrap_or(&response.1);
    let body: Value =
        serde_json::from_str(text.trim_start_matches(['\n', '\r'])).unwrap_or(Value::Null);
    Ok(ProviderUser {
        id: body.get("_account_id").map(id_string).unwrap_or_default(),
        login: body
            .get("user_name")
            .and_then(Value::as_str)
            .unwrap_or(&user_name)
            .to_string(),
        email: body
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// `self.api_base_url` for the provider's default domain, else the
/// `_get_api_base_url` enterprise URL (`build_url(domain, path)`).
fn base_url(domain: &str, default_domain: &str, default_base: &str, path: &str) -> String {
    if domain.is_empty() || domain == default_domain {
        return default_base.to_string();
    }
    if domain.starts_with("http://") || domain.starts_with("https://") {
        return format!(
            "{}/{}",
            domain.trim_end_matches('/'),
            path.trim_start_matches('/')
        );
    }
    format!("https://{domain}/{}", path.trim_start_matches('/'))
}

/// Send a request keeping the status and JSON body (`None` on transport
/// failure).
async fn send_status(builder: brz_http::RequestBuilder) -> Option<(u16, Option<Value>)> {
    let response = builder.send().await.ok()?;
    let status = response.status().as_u16();
    if status == 401 {
        return Some((401, None));
    }
    if !(200..300).contains(&status) {
        return Some((status, None));
    }
    Some((status, response.json::<Value>().await.ok()))
}

async fn send_raw(builder: brz_http::RequestBuilder) -> Option<(u16, String)> {
    let response = builder.send().await.ok()?;
    let status = response.status().as_u16();
    let text = response.text().await.ok()?;
    Some((status, text))
}

/// `f"{git_domain}:{git_token}"`.
fn domain_token_key(item: &Map<String, Value>) -> String {
    let field = |key: &str| match item.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    };
    format!("{}:{}", field("git_domain"), field("git_token"))
}

/// The `update_current_user` merge: replace by `id` when the incoming entry
/// carries one already present, otherwise key by `git_domain:git_token`.
fn merge_lists(existing: &[Map<String, Value>], incoming: &[Map<String, Value>]) -> Vec<Value> {
    let mut by_id: Map<String, Value> = Map::new();
    let mut by_key: Map<String, Value> = Map::new();
    for item in existing {
        if let Some(id) = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            by_id.insert(id.to_string(), Value::Object(item.clone()));
        }
    }
    for item in existing {
        by_key.insert(domain_token_key(item), Value::Object(item.clone()));
    }
    for item in incoming {
        let value = Value::Object(item.clone());
        let item_id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        if let Some(id) = item_id
            && let Some(old) = by_id.get(id).and_then(Value::as_object)
        {
            by_key.shift_remove(&domain_token_key(old));
            by_id.insert(id.to_string(), value);
            continue;
        }
        by_key.insert(domain_token_key(item), value);
    }
    let mut result: Map<String, Value> = Map::new();
    for (id, item) in &by_id {
        result.insert(id.clone(), item.clone());
    }
    for (key, item) in &by_key {
        match item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            Some(id) => {
                result.entry(id.to_string()).or_insert_with(|| item.clone());
            }
            None => {
                result.insert(key.clone(), item.clone());
            }
        }
    }
    result.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_replaces_by_id_and_keeps_new_domain_tokens() {
        let existing = vec![
            json!({"id": "a", "git_domain": "git.example", "git_token": "old"}),
            json!({"id": "b", "git_domain": "git.other", "git_token": "keep"}),
        ]
        .into_iter()
        .map(|value| value.as_object().unwrap().clone())
        .collect::<Vec<_>>();
        let incoming = vec![
            json!({"id": "a", "git_domain": "git.example", "git_token": "new"}),
            json!({"git_domain": "git.fresh", "git_token": "fresh"}),
        ]
        .into_iter()
        .map(|value| value.as_object().unwrap().clone())
        .collect::<Vec<_>>();
        let merged = merge_lists(&existing, &incoming);
        let tokens: Vec<&str> = merged
            .iter()
            .map(|item| item.get("git_token").and_then(Value::as_str).unwrap())
            .collect();
        assert!(tokens.contains(&"new"));
        assert!(tokens.contains(&"keep"));
        assert!(tokens.contains(&"fresh"));
        assert!(!tokens.contains(&"old"));
    }
}

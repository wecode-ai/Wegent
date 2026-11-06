//! Task-scoped Git identities for native execution requests.
//!
//! `build_execution_git_user_info` + `classify_git_auth_transport`
//! (`app/services/execution/git_credentials.py`) are shared by every service
//! that builds an `ExecutionRequest`: the responses create path resolves the
//! identity from the reloaded request user, while native background jobs load
//! `users.git_info` themselves before enriching the request.
use crate::{AppState, responses::create::dispatch::ExecutionRequest};
use anyhow::Result;
use brz_mysql::Json;
use serde_json::Value;

/// The domain-matched Git identity and the transport the executor must expect.
pub(crate) struct GitIdentity {
    pub git_domain: Value,
    pub git_token: Value,
    pub git_id: Value,
    pub git_login: Value,
    pub git_email: Value,
    pub transport: &'static str,
}

impl Default for GitIdentity {
    fn default() -> Self {
        Self {
            git_domain: Value::Null,
            git_token: Value::Null,
            git_id: Value::Null,
            git_login: Value::Null,
            git_email: Value::Null,
            transport: "none",
        }
    }
}

/// `_normalize_git_accounts` + `_match_git_account` + the token encryption and
/// `classify_git_auth_transport` precedence: empty -> `none`, `***` ->
/// `legacy_user_...`, already-encrypted -> `encrypted_request_token`,
/// otherwise the token is encrypted and classified as `encrypted_request_token`.
pub(crate) async fn resolve_identity(
    resolver: &dyn crate::repository_tokens::RepositoryTokenResolver,
    accounts: &Value,
    domain: Option<&str>,
) -> Result<GitIdentity> {
    let mut identity = GitIdentity::default();
    let domain = domain.filter(|value| !value.is_empty());
    let Some(account) = matched_account(accounts, domain) else {
        return Ok(identity);
    };
    let field = |name: &str| account.get(name).cloned().unwrap_or(Value::Null);
    identity.git_domain = field("git_domain");
    identity.git_id = field("git_id");
    identity.git_login = field("git_login");
    identity.git_email = field("git_email");

    let mut token = account["git_token"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_owned();
    if token.is_empty() {
        return Ok(identity);
    }
    if token == "***" {
        // `_resolve_placeholder_token`: the matched account's domain, else the
        // request's resolved git domain.
        let resolved_domain = identity
            .git_domain
            .as_str()
            .filter(|value| !value.is_empty())
            .or(domain)
            .unwrap_or("");
        let resolved = resolver
            .resolve_gitlab_token(
                identity.git_login.as_str().unwrap_or(""),
                resolved_domain,
                &token,
            )
            .await;
        if !resolved.trim().is_empty() && resolved.trim() != "***" {
            token = resolved.trim().into();
        }
    }
    let (token, transport) = encrypted_identity(&token)?;
    identity.git_token = token;
    identity.transport = transport;
    Ok(identity)
}

/// The `user` fields `build_execution_git_user_info` writes, in source order.
pub(crate) fn identity_fields(identity: &GitIdentity) -> [(&'static str, Value); 5] {
    [
        ("git_domain", identity.git_domain.clone()),
        ("git_token", identity.git_token.clone()),
        ("git_id", identity.git_id.clone()),
        ("git_login", identity.git_login.clone()),
        ("git_email", identity.git_email.clone()),
    ]
}

/// `build_execution_git_user_info`'s fields onto `request.user` and
/// `classify_git_auth_transport` onto `request.git_auth_transport`.
pub(crate) fn apply_identity(request: &mut ExecutionRequest, identity: &GitIdentity) {
    for (name, value) in identity_fields(identity) {
        request.user[name] = value;
    }
    request.git_auth_transport = identity.transport.to_string();
}

pub(crate) async fn enrich(app: &AppState, request: &mut ExecutionRequest) -> Result<()> {
    let row: Option<brz_mysql::MysqlRow> = app
        .mysql
        .fetch_optional("SELECT git_info FROM users WHERE id=?", (request.user_id,))
        .await?;
    let accounts = row
        .and_then(|row| row.get_at::<Option<Json<Value>>>(0).ok().flatten())
        .map(|value| value.0)
        .unwrap_or(Value::Null);
    let identity = resolve_identity(
        app.repository_tokens.as_ref(),
        &accounts,
        request.git_domain.as_deref(),
    )
    .await?;
    apply_identity(request, &identity);
    Ok(())
}

fn matched_account<'a>(accounts: &'a Value, domain: Option<&str>) -> Option<&'a Value> {
    let candidates = if let Some(values) = accounts.as_array() {
        values.iter().collect::<Vec<_>>()
    } else if accounts.is_object() {
        vec![accounts]
    } else {
        Vec::new()
    };
    candidates.into_iter().find(|account| {
        domain.is_none_or(|domain| {
            crate::git_repositories::domains_match(
                account["git_domain"].as_str().unwrap_or(""),
                domain,
            )
        })
    })
}
fn encrypted_identity(token: &str) -> Result<(Value, &'static str)> {
    use crate::git_repositories::crypto::{encrypt_git_token, is_token_encrypted};
    if token.is_empty() {
        return Ok((Value::Null, "none"));
    }
    if token == "***" {
        return Ok((Value::String(token.into()), "legacy_user_secret"));
    }
    let encrypted = if is_token_encrypted(token) {
        token.into()
    } else {
        encrypt_git_token(token)
            .map_err(|_| anyhow::anyhow!("Git credential encryption configuration is invalid"))?
    };
    Ok((Value::String(encrypted), "encrypted_request_token"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn account_selection_is_domain_scoped_and_never_leaks_an_unrelated_token() {
        let accounts = json!([{"git_domain":"github.com","git_token":"first"},{"git_domain":"https://gitlab.example/","git_token":"second"}]);
        assert_eq!(
            matched_account(&accounts, Some("gitlab.example")).unwrap()["git_token"],
            "second"
        );
        assert!(matched_account(&accounts, Some("other.example")).is_none());
        assert_eq!(
            matched_account(&accounts, None).unwrap()["git_token"],
            "first"
        );
    }
    #[test]
    fn encrypted_and_unresolved_credentials_keep_the_source_transport_contract() {
        let encrypted = "JgMaeWWl3AwfpHkESUJhXNxmcHg5Kgv7lcXROYaZ1Zc=";
        assert_eq!(
            encrypted_identity(encrypted).unwrap(),
            (json!(encrypted), "encrypted_request_token")
        );
        assert_eq!(
            encrypted_identity("***").unwrap(),
            (json!("***"), "legacy_user_secret")
        );
        assert_eq!(encrypted_identity("").unwrap(), (Value::Null, "none"));
    }

    #[tokio::test]
    async fn user_identity_classifies_the_matched_account_token() {
        let encrypted = "JgMaeWWl3AwfpHkESUJhXNxmcHg5Kgv7lcXROYaZ1Zc=";
        let resolver = crate::repository_tokens::StoredRepositoryTokens;
        let identity = resolve_identity(
            &resolver,
            &json!([{"git_domain":"git.example","git_token":encrypted,"git_login":"u"}]),
            Some("git.example"),
        )
        .await
        .unwrap();
        assert_eq!(identity.transport, "encrypted_request_token");
        assert_eq!(identity.git_token, json!(encrypted));

        let identity = resolve_identity(
            &resolver,
            &json!([{"git_domain":"git.example","git_token":"***"}]),
            Some("git.example"),
        )
        .await
        .unwrap();
        assert_eq!(identity.transport, "legacy_user_secret");
        assert_eq!(identity.git_token, json!("***"));

        let identity = resolve_identity(
            &resolver,
            &json!([{"git_domain":"git.example","git_token":""}]),
            Some("git.example"),
        )
        .await
        .unwrap();
        assert_eq!(identity.transport, "none");
        assert_eq!(identity.git_token, Value::Null);

        // No matching account: every git field stays null and the transport
        // stays `none`, like `build_execution_git_user_info`'s early return.
        let identity = resolve_identity(
            &resolver,
            &json!([{"git_domain":"other.example","git_token":encrypted}]),
            Some("git.example"),
        )
        .await
        .unwrap();
        assert_eq!(identity.transport, "none");
        assert_eq!(identity.git_token, Value::Null);
        assert_eq!(identity.git_domain, Value::Null);
    }
}

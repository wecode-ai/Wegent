//! Personal, device-consumed Git webhook inbox. No agent executes on ingress.
mod crypto;
mod routes;
mod store;

use crate::{http_compat::FastApiError, state::AppState};
use brz_http_server::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize, Deserialize)]
struct Subscription {
    id: String,
    user_id: i64,
    device_id: String,
    generation: String,
    source: Value,
    secret: String,
    active: bool,
    confirmed_sequence: i64,
    gap_before: i64,
    last_received_at: Option<String>,
    latest_sequence: i64,
    pending_count: i64,
    connection_key: String,
}

fn invalid(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_REQUEST, message)
}

fn storage_error<T>(_: T) -> FastApiError {
    FastApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "Git inbox storage unavailable",
    )
}

fn missing() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Git subscription not found")
}

fn field<'a>(body: &'a Value, name: &str) -> Result<&'a str, FastApiError> {
    body[name]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.contains('\0'))
        .ok_or_else(|| invalid("Missing or invalid subscription field"))
}

fn validate_source(source: &Value) -> Result<(), FastApiError> {
    let provider = field(source, "provider")?;
    if !matches!(provider, "github" | "gitlab") {
        return Err(invalid("Unsupported Git provider"));
    }
    let instance =
        url::Url::parse(field(source, "instance")?).map_err(|_| invalid("Invalid instance"))?;
    if instance.scheme() != "https"
        || instance.host_str().is_none()
        || !instance.username().is_empty()
        || instance.password().is_some()
        || instance.query().is_some()
        || instance.fragment().is_some()
        || instance.path() != "/"
        || (provider == "github" && instance.host_str() != Some("github.com"))
    {
        return Err(invalid("Unsupported Git instance"));
    }
    for key in ["accountId", "repositoryId", "repositoryPath"] {
        field(source, key)?;
    }
    Ok(())
}

fn summary(row: &Subscription) -> Value {
    json!({"id":row.id,"deviceId":row.device_id,"generation":row.generation,
        "source":row.source,"active":row.active,"confirmedSequence":row.confirmed_sequence,
        "gapBefore":row.gap_before,"lastReceivedAt":row.last_received_at,
        "latestSequence":row.latest_sequence,"pendingCount":row.pending_count,
        "callbackPath":format!("/api/v1/git-connections/hooks/{}",row.id)})
}

fn encryption_context(row: &Subscription) -> String {
    format!("{}:{}", row.user_id, row.id)
}

fn connection_key(device: &str, source: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            json!([
                device,
                source["provider"],
                source["instance"],
                source["accountId"],
                source["repositoryId"]
            ])
            .to_string()
            .as_bytes()
        )
    )
}

fn reveal(state: &AppState, row: &Subscription) -> Result<String, FastApiError> {
    state
        .jwt_secret_keys
        .iter()
        .find_map(|key| crypto::open(key, &encryption_context(row), &row.secret).ok())
        .ok_or_else(|| storage_error("secret key unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_rejects_credential_urls_and_enterprise_github() {
        let mut source = json!({"provider":"gitlab","instance":"https://gitlab.example","accountId":"1","repositoryId":"2","repositoryPath":"group/sub/repo"});
        assert!(validate_source(&source).is_ok());
        for address in [
            "http://gitlab.example",
            "https://user:secret@gitlab.example",
            "https://gitlab.example/api",
            "https://gitlab.example?token=secret",
        ] {
            source["instance"] = json!(address);
            assert!(validate_source(&source).is_err());
        }
        source["instance"] = json!("https://github.example");
        source["provider"] = json!("github");
        assert!(validate_source(&source).is_err());
    }
}

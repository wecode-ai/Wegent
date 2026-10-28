// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Credentials are published only by the authenticated application owner.
//! Routes retain opaque references and recheck revocation at every outbound request.

use axum::{body::Body, http::StatusCode, response::Response};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

const PREFIX: &str = "wework-vault.";

#[derive(Clone, Deserialize, PartialEq)]
struct Target {
    url: String,
    model_id: String,
    api_format: String,
    proxy_url: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Credential {
    reference: String,
    secret: String,
    targets: Vec<Target>,
    expires_at_ms: Option<u64>,
}

struct Stored {
    credential: Credential,
    revoked: watch::Sender<bool>,
}

fn registry() -> &'static Mutex<HashMap<String, Stored>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Stored>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn revoke_all() {
    if let Ok(mut entries) = registry().lock() {
        for (_, entry) in entries.drain() {
            let _ = entry.revoked.send(true);
        }
    }
}

pub(crate) fn replace(params: Value) -> Result<Value, String> {
    if params.get("credential_protocol").and_then(Value::as_u64) != Some(3) {
        return Err("incompatible credential protocol".to_owned());
    }
    let entries: Vec<Credential> =
        serde_json::from_value(params.get("entries").cloned().unwrap_or(Value::Null))
            .map_err(|_| "invalid credential publication".to_owned())?;
    let mut next = HashMap::new();
    if entries.len() > 4096 {
        return Err("invalid credential publication".to_owned());
    }
    for entry in entries {
        if !entry.reference.starts_with(PREFIX)
            || entry.reference.len() != PREFIX.len() + 36
            || uuid::Uuid::parse_str(&entry.reference[PREFIX.len()..]).is_err()
            || entry.targets.is_empty()
            || entry.expires_at_ms.is_some_and(|expiry| expiry <= now_ms())
            || entry.secret.len() > 65536
            || entry.targets.len() > 8
            || entry.targets.iter().any(|target| {
                reqwest::Url::parse(&target.url).map_or(true, |url| {
                    !matches!(url.scheme(), "http" | "https")
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.fragment().is_some()
                })
            })
            || next.contains_key(&entry.reference)
        {
            return Err("invalid credential publication".to_owned());
        }
        next.insert(entry.reference.clone(), entry);
    }
    let mut current = registry()
        .lock()
        .map_err(|_| "credential registry unavailable")?;
    let mut published = HashMap::new();
    for (reference, credential) in next {
        let revoked = match current.remove(&reference) {
            Some(old)
                if old.credential.secret == credential.secret
                    && old.credential.targets == credential.targets =>
            {
                old.revoked
            }
            Some(old) => {
                let _ = old.revoked.send(true);
                watch::channel(false).0
            }
            None => watch::channel(false).0,
        };
        published.insert(
            reference,
            Stored {
                credential,
                revoked,
            },
        );
    }
    for old in current.values() {
        let _ = old.revoked.send(true);
    }
    *current = published;
    Ok(json!({"credential_protocol": 3}))
}

pub(crate) fn resolve(
    reference: &str,
    url: &str,
    model: &str,
    format: &str,
    proxy: Option<&str>,
) -> Result<String, String> {
    // Caller-provided keys for cloud and unmanaged clients do not access the vault.
    if !reference.starts_with(PREFIX) {
        return Ok(reference.to_owned());
    }
    let entries = registry()
        .lock()
        .map_err(|_| "credential registry unavailable")?;
    let credential = &entries
        .get(reference)
        .ok_or("model credential was revoked or is unavailable")?
        .credential;
    let normalized = reqwest::Url::parse(url).map_err(|_| "invalid credential destination")?;
    if credential
        .expires_at_ms
        .is_some_and(|expiry| expiry <= now_ms())
        || !credential.targets.iter().any(|target| {
            target.url == normalized.as_str()
                && target.model_id == model
                && target.api_format == format
                && target.proxy_url.as_deref() == proxy
        })
    {
        return Err(
            "model credential destination or lifetime does not match its authorization".to_owned(),
        );
    }
    Ok(credential.secret.clone())
}

type Lease = (watch::Receiver<bool>, Option<u64>);

async fn revoked(leases: Vec<Lease>) {
    let waits: Vec<Pin<Box<dyn Future<Output = ()> + Send>>> = leases.into_iter().map(|(mut receiver, expiry)| {
        Box::pin(async move {
            let deadline = async move {
                if let Some(expiry) = expiry { tokio::time::sleep(Duration::from_millis(expiry.saturating_sub(now_ms()))).await }
                else { std::future::pending::<()>().await }
            };
            tokio::pin!(deadline);
            loop {
                if *receiver.borrow() { return }
                tokio::select! { _ = &mut deadline => return, change = receiver.changed() => { if change.is_err() { return } } }
            }
        }) as Pin<Box<dyn Future<Output = ()> + Send>>
    }).collect();
    if waits.is_empty() {
        std::future::pending::<()>().await
    } else {
        futures_util::future::select_all(waits).await;
    }
}

/** Revocation drops queued/network work and terminates an already streaming response. */
pub(super) async fn protect<F>(references: &[String], work: F) -> Result<Response, super::HttpError>
where
    F: Future<Output = Result<Response, super::HttpError>>,
{
    let denied = || super::HttpError {
        status: StatusCode::FORBIDDEN,
        detail: "Model credential was revoked or is unavailable".to_owned(),
    };
    let leases = {
        let entries = registry().lock().map_err(|_| denied())?;
        let mut leases = Vec::new();
        for reference in references.iter().filter(|value| value.starts_with(PREFIX)) {
            let entry = entries.get(reference).ok_or_else(denied)?;
            leases.push((entry.revoked.subscribe(), entry.credential.expires_at_ms));
        }
        leases
    };
    let response = tokio::select! { biased; _ = revoked(leases.clone()) => return Err(denied()), result = work => result? };
    if leases.is_empty() {
        return Ok(response);
    }
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold(
        (body.into_data_stream(), Box::pin(revoked(leases)), false),
        |(mut stream, mut cancel, done)| async move {
            if done {
                return None;
            }
            tokio::select! { biased;
                _ = &mut cancel => Some((Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "model credential revoked")), (stream, cancel, true))),
                item = stream.next() => item.map(|item| (item.map_err(std::io::Error::other), (stream, cancel, false))),
            }
        },
    );
    Ok(Response::from_parts(parts, Body::from_stream(stream)))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn publication_enforces_owner_protocol_targets_revocation_and_stream_cancellation() {
        let reference = format!("{PREFIX}{}", uuid::Uuid::new_v4());
        let entry = json!({ "reference": reference, "secret": "test-canary", "expires_at_ms": null,
            "targets": [{"url": "https://models.example/v1/responses", "model_id": "model-a", "api_format": "openai-responses", "proxy_url": null}] });
        let publication = |entry: Value| json!({"credential_protocol": 3, "entries": [entry]});
        assert!(replace(json!({"credential_protocol": 2, "entries": []})).is_err());
        replace(publication(entry.clone())).expect("owner publication");
        let resolve_target = |url: &str, model: &str, format: &str, proxy: Option<&str>| {
            resolve(&reference, url, model, format, proxy)
        };
        assert_eq!(
            resolve_target(
                "https://models.example/v1/responses",
                "model-a",
                "openai-responses",
                None
            )
            .unwrap(),
            "test-canary"
        );
        for (url, model, format, proxy) in [
            (
                "https://attacker.test/v1/responses",
                "model-a",
                "openai-responses",
                None,
            ),
            (
                "https://models.example/v1/responses?extra=1",
                "model-a",
                "openai-responses",
                None,
            ),
            (
                "https://models.example/v1/responses",
                "model-b",
                "openai-responses",
                None,
            ),
            (
                "https://models.example/v1/responses",
                "model-a",
                "anthropic-messages",
                None,
            ),
            (
                "https://models.example/v1/responses",
                "model-a",
                "openai-responses",
                Some("http://attacker.test"),
            ),
        ] {
            assert!(resolve_target(url, model, format, proxy).is_err());
        }
        let mut invalid = entry.clone();
        invalid["expires_at_ms"] = json!(1);
        assert!(replace(publication(invalid)).is_err());
        assert!(
            resolve_target(
                "https://models.example/v1/responses",
                "model-a",
                "openai-responses",
                None
            )
            .is_ok(),
            "invalid replacement cannot destroy the current generation"
        );

        let (ready, wait) = tokio::sync::oneshot::channel();
        let refs = vec![reference.clone()];
        let queued = tokio::spawn(async move {
            protect(&refs, async {
                let _ = ready.send(());
                std::future::pending().await
            })
            .await
        });
        wait.await.unwrap();
        replace(json!({"credential_protocol": 3, "entries": []})).unwrap();
        assert_eq!(
            queued.await.unwrap().unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        assert!(resolve_target(
            "https://models.example/v1/responses",
            "model-a",
            "openai-responses",
            None
        )
        .is_err());

        replace(publication(entry)).unwrap();
        let response = protect(std::slice::from_ref(&reference), async {
            Ok(Response::new(Body::from_stream(
                futures_util::stream::pending::<Result<axum::body::Bytes, std::io::Error>>(),
            )))
        })
        .await
        .unwrap();
        revoke_all();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), response.into_body().collect())
                .await
                .unwrap()
                .is_err(),
            "owner shutdown must terminate an already streaming body"
        );
    }
}

//! Native revoke-only worker. No credential or provider output leaves this module.

use super::{
    migration::{interpreter_for, package_uses_python},
    resolve_managed_package, AuthError, Credential, NativeAdapter, NativeAuthGateway,
    OAuthOperation, PreparedPackage,
};
use crate::local::backend::LocalBackendTransport;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingRevocation {
    connection_id: String,
    package: Option<PreparedPackage>,
}

#[derive(Deserialize)]
struct RevocationPage {
    revocations: Vec<PendingRevocation>,
    next_cursor: Option<u64>,
}

impl RevocationPage {
    fn next_after(&self, cursor: u64) -> Result<Option<u64>, AuthError> {
        if self.revocations.len() > 10
            || self
                .next_cursor
                .is_some_and(|next| next <= cursor || self.revocations.is_empty())
        {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        Ok(self.next_cursor)
    }
}

pub async fn revoke_pending<T: LocalBackendTransport>(
    transport: T,
    home: &Path,
) -> Result<(), AuthError> {
    let gateway = NativeAuthGateway::new(transport.clone());
    let mut pending = tokio::task::JoinSet::new();
    let mut preparation = tokio::task::JoinSet::new();
    let mut python = Vec::new();
    let mut cursor = 0;
    loop {
        let response = gateway
            .call("plugin.auth.oauth.revocations", json!({"after_id": cursor}))
            .await?;
        let page: RevocationPage = serde_json::from_value(response)
            .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
        let next = page.next_after(cursor)?;
        for target in page.revocations {
            identifier(&json!(target.connection_id))?;
            let requires_python = match target.package.as_ref() {
                Some(package) => match package_uses_python(home, package) {
                    Ok(required) => required,
                    Err(_) => continue,
                },
                None => false,
            };
            if requires_python {
                if python.is_empty() {
                    // One shared runtime wait never occupies a provider operation slot.
                    preparation.spawn(crate::python_runtime::ensure_managed_python());
                }
                python.push(target);
            } else {
                spawn_revocation(&mut pending, transport.clone(), home, target).await;
            }
        }
        match next {
            Some(next) => cursor = next,
            None => break,
        }
    }
    if matches!(preparation.join_next().await, Some(Ok(Ok(())))) {
        for target in python {
            spawn_revocation(&mut pending, transport.clone(), home, target).await;
        }
    }
    while pending.join_next().await.is_some() {
        // One unavailable provider must not prevent other queued revocations.
    }
    Ok(())
}

async fn spawn_revocation<T: LocalBackendTransport>(
    pending: &mut tokio::task::JoinSet<()>,
    transport: T,
    home: &Path,
    target: PendingRevocation,
) {
    if pending.len() >= 4 {
        let _ = pending.join_next().await;
    }
    let home = home.to_owned();
    pending.spawn(async move {
        let gateway = NativeAuthGateway::new(transport);
        let _ = revoke_one(
            &gateway,
            &home,
            &target.connection_id,
            target.package.as_ref(),
        )
        .await;
    });
}

fn identifier(value: &Value) -> Result<&str, AuthError> {
    value
        .as_str()
        .filter(|id| {
            id.len() == 64
                && id
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
        .ok_or(AuthError("plugin_auth_invalid_response"))
}

async fn revoke_one<T: LocalBackendTransport>(
    gateway: &NativeAuthGateway<T>,
    home: &Path,
    connection_id: &str,
    expected: Option<&PreparedPackage>,
) -> Result<(), AuthError> {
    let lease = gateway
        .call(
            "plugin.auth.oauth.revoke_begin",
            json!({"connection_id": connection_id}),
        )
        .await?;
    if lease["state"] == "unavailable" {
        return Ok(());
    }
    if lease["state"] != "claimed" || lease["connection_id"] != connection_id {
        return Err(AuthError("plugin_auth_invalid_response"));
    }
    let operation_id = identifier(&lease["operation_id"])?;
    let succeeded = revoke_adapter(home, &lease, expected).await.is_ok();
    let payload = json!({"connection_id": connection_id, "operation_id": operation_id, "succeeded": succeeded});
    let result = gateway
        .call("plugin.auth.oauth.revoke_finish", payload.clone())
        .await;
    match result {
        Err(AuthError("plugin_auth_backend_unavailable")) => {
            gateway
                .call("plugin.auth.oauth.revoke_finish", payload)
                .await?;
        }
        result => {
            result?;
        }
    }
    Ok(())
}

async fn revoke_adapter(
    home: &Path,
    lease: &Value,
    expected: Option<&PreparedPackage>,
) -> Result<(), AuthError> {
    let package: PreparedPackage = serde_json::from_value(lease["package"].clone())
        .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
    if expected != Some(&package) {
        return Err(AuthError("plugin_auth_definition_mismatch"));
    }
    let root = resolve_managed_package(home, &package)?;
    let adapter = NativeAdapter::load(&root, &package.connector_slug, &package.auth_definition)?;
    let interpreter = interpreter_for(&package.auth_definition)?;
    let credential = Credential::from_json(
        lease["credential"]
            .as_str()
            .ok_or(AuthError("plugin_auth_invalid_response"))?,
    )?;
    adapter
        .oauth_operation(
            &interpreter,
            OAuthOperation::Revoke,
            Some(credential),
            Duration::from_secs(30),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revocation_pages_require_monotonic_cursors_and_bounded_page_sizes() {
        for (cursor, next, count, accepted) in [
            (0, Some(10), 10, true),
            (10, None, 1, true),
            (10, None, 0, true),
            (10, Some(10), 1, false),
            (10, Some(9), 1, false),
            (10, Some(11), 0, false),
            (0, Some(11), 11, false),
        ] {
            let page = RevocationPage {
                revocations: (0..count)
                    .map(|_| PendingRevocation {
                        connection_id: "a".repeat(64),
                        package: None,
                    })
                    .collect(),
                next_cursor: next,
            };
            assert_eq!(page.next_after(cursor).is_ok(), accepted);
        }
    }

    #[tokio::test]
    async fn claimed_revocation_rejects_a_changed_package_before_credentials_or_adapter() {
        let home = tempfile::tempdir().unwrap();
        let original = json!({"installed_plugin_id":42,"connector_slug":"native",
            "checksum":format!("sha256:{}", "a".repeat(64)),
            "auth_definition":{"adapter":"auth.mjs"}});
        let expected = serde_json::from_value(original.clone()).unwrap();
        for field in ["checksum", "auth_definition"] {
            let mut changed = original.clone();
            changed[field] = if field == "checksum" {
                json!(format!("sha256:{}", "b".repeat(64)))
            } else {
                json!({"adapter":"new-python-auth.py"})
            };
            let lease = json!({"package":changed,"credential":"invalid-do-not-read"});
            assert_eq!(
                revoke_adapter(home.path(), &lease, Some(&expected)).await,
                Err(AuthError("plugin_auth_definition_mismatch")),
            );
        }
        assert_eq!(
            revoke_adapter(home.path(), &json!({"package":original}), None).await,
            Err(AuthError("plugin_auth_definition_mismatch")),
        );
    }
}

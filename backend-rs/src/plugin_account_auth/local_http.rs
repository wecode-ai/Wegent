//! Native desktop credential exchange. Device routing is deliberately absent.

mod credentials;
#[cfg(test)]
mod mysql_tests;
mod session;
mod state;

use crate::{http_compat::FastApiError, state::AppState};
use brz_http_server::{HttpResponse, StatusCode};
use brz_mysql::{MysqlError, MysqlIsolationLevel, MysqlResult, MysqlTransactionOptions};
use serde::Deserialize;
use serde_json::{Value, json};

pub(super) const PATH: &str = "/api/plugins/native-auth/exchange";

// No Debug: neither a request nor an error may render its credential fields.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExchangeRequest {
    operation: String,
    #[serde(default)]
    native_token: String,
    #[serde(default)]
    data: Value,
}

fn fail(code: &str) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: code.into(),
    }
}

fn safe_error(error: MysqlError) -> FastApiError {
    let (status, code) = match error {
        MysqlError::InvalidQuery { reason } if reason.starts_with("plugin_auth_") => {
            (StatusCode::CONFLICT, reason)
        }
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "plugin_auth_exchange_failed".into(),
        ),
    };
    FastApiError::detail(status, code).with_header("cache-control", "no-store")
}

#[brz_http_server::post("/api/plugins/native-auth/exchange", access = public)]
#[tracing::instrument(skip_all, name = "plugins.native_auth.exchange")]
async fn exchange(
    #[inject(state)] app: &AppState,
    body: ExchangeRequest,
) -> Result<HttpResponse<Value>, FastApiError> {
    if body.operation == "session" && !crate::plugins_installed::local_sync_enabled() {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "plugin_auth_http_disabled",
        ));
    }
    let value = if body.operation == "session" {
        session::open(app, body.data).await?
    } else {
        let action = body
            .operation
            .strip_prefix("plugin.auth.")
            .unwrap_or("")
            .replace('.', "_");
        if !super::request_valid(&action, &body.data) {
            return Err(safe_error(fail("plugin_auth_invalid_request")));
        }
        let principal = session::verify(app, &body.native_token)?;
        principal.require_active(app).await?;
        if read_only(&body.operation, &body.data) {
            let mut value = app
                .mysql
                .with_transaction(async |tx| {
                    state::exchange(tx, &principal, &body.operation, &body.data).await
                })
                .await
                .map_err(safe_error)?;
            value["success"] = json!(true);
            return Ok(HttpResponse::new(value)
                .header("cache-control", "no-store")
                .expect("static header"));
        }
        let targets = app
            .mysql
            .with_transaction(async |tx| state::write_targets(tx, &principal, &body.data).await)
            .await
            .map_err(safe_error)?;
        let lease =
            crate::plugins_installed::write_coordination::PluginWriteLease::acquire_installed(
                &app.mysql,
                app.redis.as_ref(),
                principal.user_id,
                Some(&targets),
            )
            .await
            .map_err(safe_error)?;
        let mut timed_out = false;
        let outcome = async {
            lease.ensure_policy(&app.mysql).await?;
            tokio::time::timeout_at(
                lease.deadline,
                app.mysql.with_transaction_options(
                    MysqlTransactionOptions::default()
                        .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
                    async |tx| {
                        crate::plugin_account_auth::connections::coordinate_owner(
                            tx,
                            &lease,
                            principal.user_id,
                        )
                        .await
                        .map_err(credentials::failure)?;
                        let policy = lease.read_revision(tx).await?;
                        let current_targets =
                            state::write_targets(tx, &principal, &body.data).await?;
                        if current_targets != targets {
                            return Err(fail("plugin_auth_revision_conflict"));
                        }
                        let revision = lease.read_plugin_revisions(tx).await?;
                        let mut result =
                            state::exchange(tx, &principal, &body.operation, &body.data).await?;
                        lease.commit_plugin_revisions(tx, revision).await?;
                        lease.validate_policy_revision(tx, policy).await?;
                        result["success"] = json!(true);
                        Ok(result)
                    },
                ),
            )
            .await
            .unwrap_or_else(|_| {
                timed_out = true;
                Err(fail("plugin_auth_exchange_failed"))
            })
        }
        .await;
        // Cancellation can queue a rollback. Keep the lease until its TTL when
        // the transaction outcome is uncertain, just like the Socket broker.
        if !timed_out && matches!(&outcome, Ok(_) | Err(MysqlError::InvalidQuery { .. })) {
            lease.release().await;
        }
        let value = outcome.map_err(safe_error)?;
        if super::notifications::changes_credentials(&action) {
            super::notifications::publish(app, principal.user_id, &targets).await;
        }
        value
    };
    Ok(HttpResponse::new(value)
        .header("cache-control", "no-store")
        .expect("static header"))
}

fn read_only(operation: &str, data: &Value) -> bool {
    matches!(
        operation,
        "plugin.auth.execute"
            | "plugin.auth.read"
            | "plugin.auth.prepare"
            | "plugin.auth.transfer.prepare"
            | "plugin.auth.oauth.revocations"
    ) || operation == "plugin.auth.automatic" && data["prepare_only"] == true
        || operation == "plugin.auth.local_lifecycle" && data["action"] == "status"
}

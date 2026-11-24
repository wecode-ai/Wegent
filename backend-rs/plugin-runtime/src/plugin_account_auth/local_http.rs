//! Native desktop credential exchange. Device routing is deliberately absent.

pub(crate) mod credentials;
mod session;
mod state;
mod timing;

use crate::plugins_installed::write_coordination::{
    self, NativeAdmissionError, NativeAdmissionTiming, NativeWriteAdmission, PluginWriteLease,
    complete_native_write, complete_plugin_write,
};
use crate::{PluginState, http_compat::FastApiError};
use brz_http_server::{HttpResponse, StatusCode};
use brz_mysql::{
    MysqlError, MysqlIsolationLevel, MysqlResult, MysqlTransactionOptions, MysqlTransactionService,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{future::Future, sync::Arc, time::Duration};
use timing::{ExchangeTiming, timed};
use tokio::time::Instant;

pub const PATH: &str = "/api/plugins/native-auth/exchange";
pub const CONTENTION_HEADER: &str = "x-wegent-plugin-auth-contention";
const BUSY_BEFORE_WRITE: &str = "busy-before-write";
const SHORT_ADMISSION_BUDGET: Duration = Duration::from_millis(200);

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

enum ExchangeFailure {
    BusyBeforeWrite,
    LeaseTimeoutBeforeWrite,
    Request(FastApiError),
}

#[derive(Clone, Copy)]
enum ResultCapability {
    Legacy,
    Busy,
    BusyAndLeaseTimeout,
}

impl ResultCapability {
    fn from_header(header: Option<&str>) -> Self {
        match header {
            Some("1") => Self::Busy,
            Some("2") => Self::BusyAndLeaseTimeout,
            _ => Self::Legacy,
        }
    }
}

impl From<FastApiError> for ExchangeFailure {
    fn from(error: FastApiError) -> Self {
        Self::Request(error)
    }
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
    #[inject(state)] app: &Arc<PluginState>,
    #[header("x-request-id")] request_id: Option<&str>,
    #[header("x-wegent-plugin-auth-contention")] contention: Option<&str>,
    #[header("x-wegent-plugin-auth-result")] result_capability: Option<&str>,
    body: ExchangeRequest,
) -> Result<HttpResponse<Value>, FastApiError> {
    let short_admission = contention == Some("1")
        && body.operation != "session"
        && !read_only(&body.operation, &body.data);
    let timing = ExchangeTiming::new(request_id, &body.operation, short_admission);
    if short_admission {
        let app = Arc::clone(app);
        let capability = ResultCapability::from_header(result_capability);
        complete_native_write(|liveness| async move {
            let is_cancelled = || liveness.is_closed();
            execute_exchange(&app, body, Some(&is_cancelled), capability, timing).await
        })
        .await
        .map_err(|_| safe_error(fail("plugin_write_unavailable")))?
    } else {
        execute_exchange(app, body, None, ResultCapability::Legacy, timing).await
    }
}

async fn execute_exchange(
    app: &Arc<PluginState>,
    body: ExchangeRequest,
    is_cancelled: Option<&(dyn Fn() -> bool + Sync)>,
    capability: ResultCapability,
    mut timing: ExchangeTiming,
) -> Result<HttpResponse<Value>, FastApiError> {
    if body.operation != "session" {
        return exchange_authorization(app, body, is_cancelled, capability, timing).await;
    }
    let result = if crate::plugins_installed::local_sync_enabled() {
        session::open(app, body.data, &mut timing)
            .await
            .map_err(ExchangeFailure::from)
    } else {
        timing.failure_stage = Some("session_disabled");
        Err(FastApiError::detail(StatusCode::NOT_FOUND, "plugin_auth_http_disabled").into())
    };
    finish_exchange(result, capability, &timing)
}

fn finish_exchange(
    result: Result<Value, ExchangeFailure>,
    capability: ResultCapability,
    timing: &ExchangeTiming,
) -> Result<HttpResponse<Value>, FastApiError> {
    let rejected = result.is_err();
    let response =
        match result {
            Ok(body) => Ok(uncached_response(body)),
            Err(ExchangeFailure::BusyBeforeWrite)
                if !matches!(capability, ResultCapability::Legacy) =>
            {
                Ok(retryable_before_write("plugin_write_busy"))
            }
            Err(ExchangeFailure::LeaseTimeoutBeforeWrite)
                if matches!(capability, ResultCapability::BusyAndLeaseTimeout) =>
            {
                Ok(retryable_before_write("plugin_write_lease_timeout"))
            }
            Err(ExchangeFailure::BusyBeforeWrite) => Err(safe_error(fail("plugin_write_busy"))
                .with_header(CONTENTION_HEADER, BUSY_BEFORE_WRITE)),
            Err(ExchangeFailure::LeaseTimeoutBeforeWrite) => {
                Err(safe_error(fail("plugin_write_unavailable")))
            }
            Err(ExchangeFailure::Request(error)) => Err(error),
        };
    let status = response
        .as_ref()
        .err()
        .map_or(StatusCode::OK, FastApiError::status);
    timing.finish(status, rejected);
    response
}

fn retryable_before_write(code: &str) -> HttpResponse<Value> {
    uncached_response(json!({"success":false,"error":code,"retryable":true}))
        .header(CONTENTION_HEADER, BUSY_BEFORE_WRITE)
        .expect("static header")
}

fn uncached_response(body: Value) -> HttpResponse<Value> {
    HttpResponse::new(body)
        .header("cache-control", "no-store")
        .expect("static header")
}

async fn exchange_authorization(
    app: &Arc<PluginState>,
    body: ExchangeRequest,
    is_cancelled: Option<&(dyn Fn() -> bool + Sync)>,
    capability: ResultCapability,
    mut timing: ExchangeTiming,
) -> Result<HttpResponse<Value>, FastApiError> {
    let action = body
        .operation
        .strip_prefix("plugin.auth.")
        .unwrap_or("")
        .replace('.', "_");
    let (principal, admission) =
        match prepare_authorization(app, &body, &action, is_cancelled, &mut timing).await {
            Ok(prepared) => prepared,
            Err(error) => return finish_exchange(Err(error), capability, &timing),
        };
    let result = if read_only(&body.operation, &body.data) {
        read_authorization(app, &principal, &body, &mut timing).await
    } else if admission.is_some() {
        exchange_write(app, &principal, &body, &action, admission, &mut timing).await
    } else {
        let app = Arc::clone(app);
        // Legacy writes keep their lease through cancellation once admitted here.
        return complete_plugin_write(async move {
            let result = exchange_write(&app, &principal, &body, &action, None, &mut timing).await;
            Ok(finish_exchange(result, capability, &timing))
        })
        .await
        .map_err(safe_error)?;
    };
    finish_exchange(result, capability, &timing)
}

async fn prepare_authorization<'a>(
    app: &PluginState,
    body: &ExchangeRequest,
    action: &str,
    is_cancelled: Option<&'a (dyn Fn() -> bool + Sync)>,
    timing: &mut ExchangeTiming,
) -> Result<(session::Principal, Option<NativeWriteAdmission<'a>>), ExchangeFailure> {
    timing.failure_stage = Some("validate_request");
    if !super::request_valid(action, &body.data) {
        return Err(safe_error(fail("plugin_auth_invalid_request")).into());
    }
    timing.failure_stage = Some("verify_native_session");
    let principal = session::verify(app, &body.native_token)?;
    let admission = is_cancelled.map(|is_cancelled| NativeWriteAdmission {
        deadline: Instant::now() + SHORT_ADMISSION_BUDGET,
        is_cancelled,
    });
    let deadline = admission.map(|admission| admission.deadline);
    timing.failure_stage = Some("verify_active_mysql");
    let active = timed(
        &mut timing.verify_active_mysql_ms,
        within_admission(deadline, principal.is_active(app)),
    )
    .await;
    let active = active.map_err(|error| admission_failure(error, timing))?;
    session::require_active(active, timing)?;
    Ok((principal, admission))
}

async fn read_authorization(
    app: &PluginState,
    principal: &session::Principal,
    body: &ExchangeRequest,
    timing: &mut ExchangeTiming,
) -> Result<Value, ExchangeFailure> {
    timing.failure_stage = Some("auth_read_mysql");
    let outcome = timed(
        &mut timing.auth_read_mysql_ms,
        app.mysql.with_transaction(async |tx| {
            state::exchange(tx, principal, &body.operation, &body.data).await
        }),
    )
    .await
    .map_err(|error| traced_mysql_error(error, timing))?;
    Ok(outcome.into_response())
}

async fn within_admission<T>(
    deadline: Option<Instant>,
    work: impl Future<Output = T>,
) -> Result<T, NativeAdmissionError> {
    if let Some(deadline) = deadline {
        if Instant::now() >= deadline {
            return Err(NativeAdmissionError::Deadline);
        }
        tokio::time::timeout_at(deadline, work)
            .await
            .map_err(|_| NativeAdmissionError::Deadline)
    } else {
        Ok(work.await)
    }
}

async fn exchange_write(
    app: &PluginState,
    principal: &session::Principal,
    body: &ExchangeRequest,
    action: &str,
    admission: Option<NativeWriteAdmission<'_>>,
    timing: &mut ExchangeTiming,
) -> Result<Value, ExchangeFailure> {
    timing.failure_stage = Some("target_lookup_mysql");
    if let Some(admission) = admission {
        admission
            .check_cancelled()
            .map_err(|error| admission_failure(error, timing))?;
    }
    let targets = timed(
        &mut timing.target_lookup_mysql_ms,
        within_admission(
            admission.map(|admission| admission.deadline),
            app.mysql
                .with_transaction(async |tx| state::write_targets(tx, principal, &body.data).await),
        ),
    )
    .await
    .map_err(|error| admission_failure(error, timing))?
    .map_err(|error| traced_mysql_error(error, timing))?;

    let mut admission_timing = NativeAdmissionTiming::default();
    let acquired = PluginWriteLease::acquire_native_installed(
        &app.mysql,
        app.redis.as_ref(),
        principal.user_id,
        &targets,
        admission,
        &mut admission_timing,
    )
    .await;
    timing.installation_scope_mysql_ms = admission_timing.installation_scope_mysql_ms;
    timing.plugin_acquire_redis_ms = admission_timing.plugin_acquire_redis_ms;
    timing.unlock_redis_ms = admission_timing.unlock_redis_ms;
    timing.failure_stage = Some(
        if matches!(acquired, Err(NativeAdmissionError::Mysql(_)))
            || matches!(acquired, Err(NativeAdmissionError::Deadline))
                && admission_timing.plugin_acquire_redis_ms.is_none()
        {
            "installation_scope_mysql"
        } else {
            "plugin_acquire_redis"
        },
    );
    let mut lease = acquired.map_err(|error| admission_failure(error, timing))?;

    let policy = ensure_policy(app, &lease, admission, timing).await;
    if let Err(error) =
        policy.and_then(|()| admission.map_or(Ok(()), NativeWriteAdmission::check_cancelled))
    {
        let retain = match &error {
            NativeAdmissionError::PolicyTimedOut => lease.is_account_policy_lease(),
            NativeAdmissionError::Policy(error) => {
                !matches!(error, MysqlError::InvalidQuery { .. })
            }
            _ => false,
        };
        if !retain {
            release_lease(lease, timing).await;
        }
        return Err(admission_failure(error, timing));
    }

    lease.track_verify_timing();
    let started = Instant::now();
    let outcome = write_transaction(app, principal, body, &targets, &lease, timing).await;
    timing.auth_transaction_mixed_ms = Some(started.elapsed().as_millis() as u64);
    if let Some((ms, calls)) = lease.verify_timing() {
        timing.auth_verify_redis_ms = Some(ms);
        timing.auth_verify_redis_calls = Some(calls);
    }
    // A canceled commit can still finish. Retain the lease when the outcome
    // is uncertain, as on the existing Socket and legacy Native paths.
    let outcome = outcome.map_err(|_| {
        timing.outcome = Some("auth_transaction_outcome_unknown");
        safe_error(fail("plugin_auth_exchange_failed"))
    })?;
    if matches!(&outcome, Ok(_) | Err(MysqlError::InvalidQuery { .. })) {
        release_lease(lease, timing).await;
    }
    let outcome = outcome.map_err(|error| transaction_failure(error, timing))?;
    if !outcome.is_replayed() && super::notifications::changes_credentials(action) {
        timed(
            &mut timing.notification_redis_ms,
            super::notifications::publish(app.redis.as_ref(), principal.user_id, &targets),
        )
        .await;
    }
    Ok(outcome.into_response())
}

async fn release_lease(
    lease: PluginWriteLease<'_, brz_redis::RedisService>,
    timing: &mut ExchangeTiming,
) {
    let started = Instant::now();
    lease.release().await;
    *timing.unlock_redis_ms.get_or_insert(0) += started.elapsed().as_millis() as u64;
}

async fn ensure_policy(
    app: &PluginState,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    admission: Option<NativeWriteAdmission<'_>>,
    timing: &mut ExchangeTiming,
) -> Result<(), NativeAdmissionError> {
    timing.failure_stage = Some("policy_initialize_mixed");
    let Some(admission) = admission else {
        return timed(
            &mut timing.policy_initialize_mixed_ms,
            lease.ensure_policy(&app.mysql),
        )
        .await
        .map_err(NativeAdmissionError::Policy);
    };
    let mut admission_timing = NativeAdmissionTiming::default();
    let result = lease
        .ensure_native_policy(&app.mysql, admission, &mut admission_timing)
        .await;
    timing.policy_lookup_mysql_ms = admission_timing.policy_lookup_mysql_ms;
    timing.policy_acquire_redis_ms = admission_timing.policy_acquire_redis_ms;
    timing.policy_verify_redis_ms = admission_timing.policy_verify_redis_ms;
    timing.policy_initialize_mixed_ms = admission_timing.policy_initialize_mixed_ms;
    if let Some(elapsed) = admission_timing.unlock_redis_ms {
        *timing.unlock_redis_ms.get_or_insert(0) += elapsed;
    }
    if timing.policy_initialize_mixed_ms.is_none() {
        timing.failure_stage = Some(if timing.policy_verify_redis_ms.is_some() {
            "policy_verify_redis"
        } else if timing.policy_acquire_redis_ms.is_some() {
            "policy_acquire_redis"
        } else {
            "policy_lookup_mysql"
        });
    }
    result
}

async fn write_transaction(
    app: &PluginState,
    principal: &session::Principal,
    body: &ExchangeRequest,
    targets: &[i64],
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    timing: &mut ExchangeTiming,
) -> Result<MysqlResult<state::ExchangeOutcome>, tokio::time::error::Elapsed> {
    let started = Instant::now();
    let mut transaction_end = None;
    timing.failure_stage = Some("auth_begin_mysql");
    let outcome = tokio::time::timeout_at(
        lease.deadline,
        app.mysql.with_transaction_options(
            MysqlTransactionOptions::default()
                .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
            async |tx| {
                timing.transaction.begin_mysql_ms = Some(started.elapsed().as_millis() as u64);
                let result =
                    apply_authorization_write(tx, principal, body, targets, lease, timing).await;
                transaction_end = Some((Instant::now(), result.is_ok()));
                result
            },
        ),
    )
    .await;
    // The MySQL wrapper starts the transaction before the callback and
    // finalizes it after the callback returns.
    match transaction_end {
        Some((started, true)) => {
            timing.transaction.commit_mysql_ms = Some(started.elapsed().as_millis() as u64);
            timing.failure_stage = Some("auth_commit_mysql");
        }
        Some((started, false)) => {
            timing.transaction.rollback_mysql_ms = Some(started.elapsed().as_millis() as u64);
            if outcome.is_err()
                || matches!(&outcome, Ok(Err(MysqlError::TransactionRollback { .. })))
            {
                timing.failure_stage = Some("auth_rollback_mysql");
            }
        }
        None if timing.transaction.begin_mysql_ms.is_none() => {
            timing.transaction.begin_mysql_ms = Some(started.elapsed().as_millis() as u64);
        }
        None => {}
    }
    outcome
}

async fn apply_authorization_write(
    tx: &mut MysqlTransactionService,
    principal: &session::Principal,
    body: &ExchangeRequest,
    targets: &[i64],
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    timing: &mut ExchangeTiming,
) -> MysqlResult<state::ExchangeOutcome> {
    timing.failure_stage = Some("auth_verify_redis");
    lease.verify_owned().await?;
    timing.failure_stage = Some("auth_owner_mysql");
    let active = timed(
        &mut timing.transaction.owner_mysql_ms,
        super::connections::owner_is_active(tx, principal.user_id),
    )
    .await
    .map_err(|error| {
        timing.outcome = Some("mysql_owner_lookup_failed");
        timing.record_mysql_error(&error);
        // Keep the existing response and release after confirmed rollback.
        fail(credentials::DEPENDENCY_UNAVAILABLE)
    })?;
    if !active {
        return Err(fail("plugin_auth_owner_unavailable"));
    }
    timing.failure_stage = Some("auth_read_revisions_mixed");
    let (policy, revisions) = timed(&mut timing.transaction.read_revisions_mixed_ms, async {
        let policy = lease.read_revision(tx).await?;
        let current_targets = state::write_targets(tx, principal, &body.data).await?;
        if current_targets != targets {
            return Err(fail("plugin_auth_revision_conflict"));
        }
        Ok((policy, lease.read_plugin_revisions(tx).await?))
    })
    .await?;
    timing.failure_stage = Some("auth_state_mysql");
    let result = timed(
        &mut timing.transaction.state_mysql_ms,
        state::exchange(tx, principal, &body.operation, &body.data),
    )
    .await?;
    timing.failure_stage = Some("auth_plugin_revision_mixed");
    timed(&mut timing.transaction.plugin_revision_mixed_ms, async {
        if result.is_replayed() {
            if lease.read_plugin_revisions(tx).await? != revisions {
                return Err(fail("plugin_auth_revision_conflict"));
            }
            Ok(())
        } else {
            lease.commit_plugin_revisions(tx, revisions).await
        }
    })
    .await?;
    timing.failure_stage = Some("auth_policy_revision_mixed");
    timed(
        &mut timing.transaction.policy_revision_mixed_ms,
        lease.validate_policy_revision(tx, policy),
    )
    .await?;
    Ok(result)
}

fn admission_failure(error: NativeAdmissionError, timing: &mut ExchangeTiming) -> ExchangeFailure {
    let redis_failure = matches!(
        &error,
        NativeAdmissionError::RedisUnavailable
            | NativeAdmissionError::RedisPromotionUnavailable(_)
            | NativeAdmissionError::Verify(_)
    );
    let (outcome, response) = match error {
        NativeAdmissionError::Occupied => {
            timing.outcome = Some("lock_busy_before_write");
            return ExchangeFailure::BusyBeforeWrite;
        }
        NativeAdmissionError::Deadline => {
            ("admission_deadline", safe_error(fail("plugin_write_busy")))
        }
        NativeAdmissionError::Cancelled => (
            "request_cancelled_before_auth_write",
            safe_error(fail("plugin_write_unavailable")),
        ),
        NativeAdmissionError::RedisUnavailable => (
            "redis_unavailable",
            safe_error(fail("plugin_write_unavailable")),
        ),
        NativeAdmissionError::RedisReplyUnknown => {
            timing.record_redis_failure("redis_set_reply_unknown");
            return ExchangeFailure::LeaseTimeoutBeforeWrite;
        }
        NativeAdmissionError::RedisReplyLate => {
            timing.record_redis_failure("redis_set_reply_late");
            return ExchangeFailure::LeaseTimeoutBeforeWrite;
        }
        NativeAdmissionError::RedisPromotionNotConfirmed => {
            timing.record_redis_failure("redis_lease_promotion_not_confirmed");
            return ExchangeFailure::LeaseTimeoutBeforeWrite;
        }
        NativeAdmissionError::RedisPromotionUnavailable(error) => {
            timing.record_redis_error(&error);
            (
                "redis_lease_promotion_failed",
                safe_error(fail("plugin_write_unavailable")),
            )
        }
        NativeAdmissionError::CleanupCapacityExhausted => {
            timing.outcome = Some("redis_cleanup_capacity_exhausted");
            return ExchangeFailure::LeaseTimeoutBeforeWrite;
        }
        NativeAdmissionError::Mysql(error) => {
            ("mysql_lookup_failed", traced_mysql_error(error, timing))
        }
        NativeAdmissionError::LegacyAcquire(error) => (
            match write_coordination::plugin_write_error_code(&error) {
                Some("plugin_write_busy") => "legacy_lock_busy_or_timed_out",
                _ => "legacy_lock_failed",
            },
            safe_error(error),
        ),
        NativeAdmissionError::Verify(error) => ("redis_verification_failed", safe_error(error)),
        NativeAdmissionError::Policy(error) => (
            "policy_initialize_failed_or_unknown",
            traced_mysql_error(error, timing),
        ),
        NativeAdmissionError::PolicyTimedOut => (
            "policy_transaction_outcome_unknown",
            safe_error(fail("plugin_write_busy")),
        ),
    };
    if redis_failure {
        timing.record_redis_failure(outcome);
    } else {
        timing.outcome = Some(outcome);
    }
    response.into()
}

fn transaction_failure(error: MysqlError, timing: &mut ExchangeTiming) -> FastApiError {
    if matches!(error, MysqlError::QueryTimedOut)
        && timing.failure_stage == Some("auth_verify_redis")
    {
        timing.record_redis_failure("redis_verification_timed_out");
        return safe_error(error);
    }
    match write_coordination::plugin_write_error_code(&error) {
        Some("plugin_write_unavailable" | "plugin_write_lease_lost") => {
            timing.failure_stage = Some("auth_verify_redis");
            timing.record_redis_failure("redis_verification_failed");
        }
        Some("plugin_write_conflict") => timing.outcome = Some("auth_transaction_conflict"),
        _ if matches!(error, MysqlError::TransactionRollback { .. }) => {
            timing.outcome = Some("mysql_transaction_rollback_failed");
        }
        _ if timing.outcome.is_none() => {
            timing.outcome = Some(if is_auth_refusal(&error) {
                "auth_transaction_rejected"
            } else {
                "auth_transaction_failed_or_unknown"
            });
        }
        _ => {}
    }
    traced_mysql_error(error, timing)
}

fn traced_mysql_error(error: MysqlError, timing: &mut ExchangeTiming) -> FastApiError {
    if !is_auth_refusal(&error)
        && write_coordination::plugin_write_error_code(&error).is_none()
        && !matches!(&error, MysqlError::InvalidQuery { reason } if reason == credentials::DEPENDENCY_UNAVAILABLE)
    {
        timing.record_mysql_error(&error);
    }
    safe_error(error)
}

fn is_auth_refusal(error: &MysqlError) -> bool {
    matches!(error, MysqlError::InvalidQuery { reason } if reason.starts_with("plugin_auth_"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::{Handler, NoAuthenticator, Request, Response, Server};

    const RESULT_HEADER: &str = "x-wegent-plugin-auth-result";

    struct AdmissionFailureProbe;

    impl Handler for AdmissionFailureProbe {
        async fn call<'a>(&'a self, request: Request<'a>, _: &'a NoAuthenticator) -> Response {
            let mut timing = ExchangeTiming::new(None, "plugin.auth.local_lifecycle", true);
            timing.failure_stage = Some("plugin_acquire_redis");
            let error = match request.path() {
                "/lease-timeout" => NativeAdmissionError::RedisReplyUnknown,
                "/late-lease-reply" => NativeAdmissionError::RedisReplyLate,
                "/promotion-unconfirmed" => NativeAdmissionError::RedisPromotionNotConfirmed,
                "/promotion-failed" => {
                    NativeAdmissionError::RedisPromotionUnavailable(brz_redis::RedisError::new(
                        brz_redis::ErrorKind::ResponseError,
                        "script failed",
                    ))
                }
                "/cleanup-capacity" => NativeAdmissionError::CleanupCapacityExhausted,
                "/admission-deadline" => NativeAdmissionError::Deadline,
                "/redis-unavailable" => NativeAdmissionError::RedisUnavailable,
                "/policy-transaction-timeout" => NativeAdmissionError::PolicyTimedOut,
                path => panic!("unexpected probe path: {path}"),
            };
            let capability = ResultCapability::from_header(
                request
                    .header(RESULT_HEADER)
                    .and_then(|header| std::str::from_utf8(header).ok()),
            );
            let failure = admission_failure(error, &mut timing);
            brz_http_server::__private::result_response(
                finish_exchange(Err(failure), capability, &timing),
                request.response_arena(),
            )
        }
    }

    #[tokio::test]
    async fn only_version_two_marks_a_lease_timeout_as_retryable() {
        let server = Server::bind("127.0.0.1:0".parse().unwrap(), AdmissionFailureProbe)
            .await
            .unwrap();
        let address = server.local_addr().unwrap();
        let worker = tokio::spawn(server.serve_until(std::future::pending::<()>()));
        let client = brz_http::Client::new();
        let unavailable = json!({"detail":"plugin_auth_exchange_failed"});
        let retryable =
            json!({"success":false,"error":"plugin_write_lease_timeout","retryable":true});
        for (path, capability, status, marker, body) in [
            (
                "/lease-timeout",
                "2",
                200,
                Some(BUSY_BEFORE_WRITE),
                retryable.clone(),
            ),
            ("/lease-timeout", "1", 503, None, unavailable.clone()),
            ("/lease-timeout", "", 503, None, unavailable.clone()),
            (
                "/late-lease-reply",
                "2",
                200,
                Some(BUSY_BEFORE_WRITE),
                retryable.clone(),
            ),
            ("/late-lease-reply", "1", 503, None, unavailable.clone()),
            ("/late-lease-reply", "", 503, None, unavailable.clone()),
            (
                "/promotion-unconfirmed",
                "2",
                200,
                Some(BUSY_BEFORE_WRITE),
                retryable.clone(),
            ),
            (
                "/promotion-unconfirmed",
                "1",
                503,
                None,
                unavailable.clone(),
            ),
            ("/promotion-failed", "2", 503, None, unavailable.clone()),
            (
                "/cleanup-capacity",
                "2",
                200,
                Some(BUSY_BEFORE_WRITE),
                retryable,
            ),
            ("/cleanup-capacity", "1", 503, None, unavailable.clone()),
            ("/cleanup-capacity", "", 503, None, unavailable.clone()),
            ("/admission-deadline", "2", 503, None, unavailable.clone()),
            ("/redis-unavailable", "2", 503, None, unavailable.clone()),
            ("/policy-transaction-timeout", "2", 503, None, unavailable),
        ] {
            let mut request = client.post(format!("http://{address}{path}")).unwrap();
            if !capability.is_empty() {
                request = request.header(RESULT_HEADER, capability);
            }
            let response = request.send().await.unwrap();
            assert_eq!(response.status().as_u16(), status, "{path}, {capability}");
            assert_eq!(
                response
                    .headers()
                    .get(CONTENTION_HEADER)
                    .map(|value| value.to_str().unwrap()),
                marker,
                "{path}, {capability}"
            );
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(response.json::<Value>().await.unwrap(), body);
        }
        worker.abort();
    }
}

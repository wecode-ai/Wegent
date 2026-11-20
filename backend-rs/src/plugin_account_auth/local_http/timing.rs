//! Credential-free timing for Native plugin authorization requests.

use brz_http_server::StatusCode;
use brz_mysql::MysqlError;
use std::future::Future;
use tokio::time::Instant;

const OPERATIONS: &[&str] = &[
    "session",
    "plugin.auth.automatic",
    "plugin.auth.enroll",
    "plugin.auth.execute",
    "plugin.auth.local_lifecycle",
    "plugin.auth.oauth.begin",
    "plugin.auth.oauth.finish",
    "plugin.auth.oauth.revoke_begin",
    "plugin.auth.oauth.revoke_finish",
    "plugin.auth.oauth.revocations",
    "plugin.auth.prepare",
    "plugin.auth.read",
    "plugin.auth.transfer.abort",
    "plugin.auth.transfer.finish",
    "plugin.auth.transfer.prepare",
    "plugin.auth.transfer.stage",
];

pub(super) struct ExchangeTiming {
    request_id: Option<String>,
    operation: &'static str,
    opted_in: bool,
    started: Instant,
    pub failure_stage: Option<&'static str>,
    pub outcome: Option<&'static str>,
    failure_dependency: Option<&'static str>,
    mysql_error_kind: Option<&'static str>,
    mysql_errno: Option<u16>,
    pub verify_active_mysql_ms: Option<u64>,
    pub session_proof_redis_ms: Option<u64>,
    pub target_lookup_mysql_ms: Option<u64>,
    pub installation_scope_mysql_ms: Option<u64>,
    pub plugin_acquire_redis_ms: Option<u64>,
    pub policy_lookup_mysql_ms: Option<u64>,
    pub policy_acquire_redis_ms: Option<u64>,
    pub policy_verify_redis_ms: Option<u64>,
    pub policy_initialize_mixed_ms: Option<u64>,
    pub auth_read_mysql_ms: Option<u64>,
    pub auth_transaction_mixed_ms: Option<u64>,
    pub transaction: WriteTransactionTiming,
    pub auth_verify_redis_ms: Option<u64>,
    pub auth_verify_redis_calls: Option<u64>,
    pub unlock_redis_ms: Option<u64>,
    pub notification_redis_ms: Option<u64>,
}

#[derive(Default)]
pub(super) struct WriteTransactionTiming {
    pub begin_mysql_ms: Option<u64>,
    pub owner_mysql_ms: Option<u64>,
    pub read_revisions_mixed_ms: Option<u64>,
    pub state_mysql_ms: Option<u64>,
    pub plugin_revision_mixed_ms: Option<u64>,
    pub policy_revision_mixed_ms: Option<u64>,
    pub commit_mysql_ms: Option<u64>,
    pub rollback_mysql_ms: Option<u64>,
}

impl ExchangeTiming {
    pub(super) fn new(request_id: Option<&str>, operation: &str, opted_in: bool) -> Self {
        Self {
            request_id: request_id
                .filter(|id| {
                    !id.is_empty()
                        && id.len() <= 128
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
                .map(str::to_owned),
            operation: OPERATIONS
                .iter()
                .copied()
                .find(|known| *known == operation)
                .unwrap_or("unknown"),
            opted_in,
            started: Instant::now(),
            failure_stage: None,
            outcome: None,
            failure_dependency: None,
            mysql_error_kind: None,
            mysql_errno: None,
            verify_active_mysql_ms: None,
            session_proof_redis_ms: None,
            target_lookup_mysql_ms: None,
            installation_scope_mysql_ms: None,
            plugin_acquire_redis_ms: None,
            policy_lookup_mysql_ms: None,
            policy_acquire_redis_ms: None,
            policy_verify_redis_ms: None,
            policy_initialize_mixed_ms: None,
            auth_read_mysql_ms: None,
            auth_transaction_mixed_ms: None,
            transaction: WriteTransactionTiming::default(),
            auth_verify_redis_ms: None,
            auth_verify_redis_calls: None,
            unlock_redis_ms: None,
            notification_redis_ms: None,
        }
    }

    pub(super) fn record_mysql_error(&mut self, error: &MysqlError) {
        self.failure_dependency = Some("mysql");
        self.mysql_errno = error.database_code();
        self.mysql_error_kind = Some(match error {
            MysqlError::PoolTimedOut => "pool_timeout",
            MysqlError::QueryTimedOut => "query_timeout",
            MysqlError::TransactionRollback { .. } => "rollback_failed",
            MysqlError::Database { .. } => "database_error",
            MysqlError::InvalidQuery { .. } => "query_rejected",
            _ => "other",
        });
    }

    pub(super) fn record_redis_failure(&mut self, outcome: &'static str) {
        self.failure_dependency = Some("redis");
        self.outcome = Some(outcome);
    }

    pub(super) fn finish(&self, status: StatusCode, rejected: bool) {
        let status = status.as_u16();
        let outcome = if rejected {
            self.outcome
                .unwrap_or(if status < 500 { "rejected" } else { "failed" })
        } else {
            "success"
        };
        tracing::info!(
            request_id = self.request_id.as_deref(),
            operation = self.operation,
            short_lease_admission = self.opted_in,
            http_status = status,
            outcome,
            failure_stage = self.failure_stage.filter(|_| rejected),
            failure_dependency = self.failure_dependency,
            mysql_error_kind = self.mysql_error_kind,
            mysql_errno = self.mysql_errno,
            total_ms = self.started.elapsed().as_millis() as u64,
            verify_active_mysql_ms = self.verify_active_mysql_ms,
            session_proof_redis_ms = self.session_proof_redis_ms,
            target_lookup_mysql_ms = self.target_lookup_mysql_ms,
            installation_scope_mysql_ms = self.installation_scope_mysql_ms,
            plugin_acquire_redis_ms = self.plugin_acquire_redis_ms,
            policy_lookup_mysql_ms = self.policy_lookup_mysql_ms,
            policy_acquire_redis_ms = self.policy_acquire_redis_ms,
            policy_verify_redis_ms = self.policy_verify_redis_ms,
            policy_initialize_mixed_ms = self.policy_initialize_mixed_ms,
            auth_read_mysql_ms = self.auth_read_mysql_ms,
            auth_transaction_mixed_ms = self.auth_transaction_mixed_ms,
            auth_begin_mysql_ms = self.transaction.begin_mysql_ms,
            auth_owner_mysql_ms = self.transaction.owner_mysql_ms,
            auth_read_revisions_mixed_ms = self.transaction.read_revisions_mixed_ms,
            auth_state_mysql_ms = self.transaction.state_mysql_ms,
            auth_plugin_revision_mixed_ms = self.transaction.plugin_revision_mixed_ms,
            auth_policy_revision_mixed_ms = self.transaction.policy_revision_mixed_ms,
            auth_commit_mysql_ms = self.transaction.commit_mysql_ms,
            auth_rollback_mysql_ms = self.transaction.rollback_mysql_ms,
            auth_verify_redis_ms = self.auth_verify_redis_ms,
            auth_verify_redis_calls = self.auth_verify_redis_calls,
            unlock_redis_ms = self.unlock_redis_ms,
            notification_redis_ms = self.notification_redis_ms,
            "Native plugin authorization finished"
        );
    }
}

pub(super) async fn timed<T>(elapsed: &mut Option<u64>, work: impl Future<Output = T>) -> T {
    let _timer = StageTimer {
        elapsed,
        started: Instant::now(),
    };
    work.await
}

struct StageTimer<'a> {
    elapsed: &'a mut Option<u64>,
    started: Instant,
}

impl Drop for StageTimer<'_> {
    fn drop(&mut self) {
        *self.elapsed = Some(self.started.elapsed().as_millis() as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn records_elapsed_time_when_a_phase_is_cancelled() {
        use std::{future::pending, time::Duration};

        let mut elapsed = None;
        let result = tokio::time::timeout(
            Duration::from_millis(200),
            timed(&mut elapsed, pending::<()>()),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(elapsed, Some(200));
    }

    #[test]
    fn only_records_recognized_operations_and_request_ids() {
        let recognized = ExchangeTiming::new(Some("b7fe90d4"), "plugin.auth.oauth.finish", true);
        assert_eq!(recognized.operation, "plugin.auth.oauth.finish");
        assert_eq!(recognized.request_id.as_deref(), Some("b7fe90d4"));

        let invalid = ExchangeTiming::new(Some("Bearer test.token"), "untrusted-value", false);
        assert_eq!(invalid.operation, "unknown");
        assert_eq!(invalid.request_id, None);
    }

    #[test]
    fn failure_timings_preserve_dependency_and_http_contract() {
        use super::super::{fail, session, transaction_failure};

        let mut redis = ExchangeTiming::new(Some("redis-case"), "plugin.auth.oauth.finish", true);
        let response = transaction_failure(fail("plugin_write_unavailable"), &mut redis);
        assert_eq!(response.status().as_u16(), 503);
        assert_eq!(redis.failure_stage, Some("auth_verify_redis"));
        assert_eq!(redis.failure_dependency, Some("redis"));
        assert_eq!(redis.outcome, Some("redis_verification_failed"));
        assert_eq!(redis.mysql_error_kind, None);

        let mut mysql = ExchangeTiming::new(Some("mysql-case"), "plugin.auth.oauth.finish", true);
        mysql.failure_stage = Some("verify_active_mysql");
        let response = session::require_active(Err(MysqlError::PoolTimedOut), &mut mysql)
            .expect_err("failed account lookups keep their unauthorized response");
        assert_eq!(response.status().as_u16(), 401);
        assert_eq!(mysql.failure_dependency, Some("mysql"));
        assert_eq!(mysql.mysql_error_kind, Some("pool_timeout"));
        assert_eq!(mysql.outcome, Some("mysql_account_lookup_failed"));

        let mut refused = ExchangeTiming::new(Some("refusal"), "plugin.auth.oauth.finish", true);
        let response = transaction_failure(fail("plugin_auth_operation_mismatch"), &mut refused);
        assert_eq!(response.status().as_u16(), 409);
        assert_eq!(refused.outcome, Some("auth_transaction_rejected"));
        assert_eq!(refused.failure_dependency, None);
        assert_eq!(refused.mysql_error_kind, None);
    }
}

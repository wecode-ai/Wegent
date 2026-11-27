// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Heartbeat runtime-auth follow-up (`_sync_runtime_auth_for_heartbeat_device`).
//!
//! Source: `app/api/ws/device_namespace.py::_schedule_runtime_auth_sync_after_heartbeat`
//! and `_sync_runtime_auth_for_heartbeat_device`. When a heartbeat reports the
//! Codex runtime auth file as missing, the source schedules one `asyncio` task
//! (deduped by `(user_id, device_id, "codex")` while one is in flight) that
//! opens a session and reads the user row followed by the user's
//! `UserRuntimeConfig` (`codex`) and `UserProxyConfig` (`default`) documents in
//! one transaction. The task runs independently of the registration capability
//! sync, so this module gives it its own startup-owned bounded queue rather
//! than sharing the registration worker.
//!

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use brz_mysql::FromMysqlRow;
use tokio::sync::mpsc;

use crate::state::AppState;
use crate::user_reader::USER_BY_ID_QUERY;
use crate::users_runtime_configs::{
    KindDocumentRow, PROXY_CONFIG_KIND, PROXY_CONFIG_NAME, RUNTIME_CONFIG_KIND, auth_file_for_sync,
    execution_config_from_documents, fetch_kind_in_transaction,
};

use super::device_heartbeat::CODEX_RUNTIME;

/// `_runtime_auth_sync_inflight` key: `(user_id, device_id, runtime)`.
pub(crate) type InflightKey = (i64, String, String);

/// One heartbeat's deferred runtime-auth sync.
pub(crate) struct RuntimeAuthSyncJob {
    pub user_id: i64,
    pub device_id: String,
}

/// The worker loop. Runs until the queue closes or the process shuts down.
pub(crate) async fn run_worker(
    mut jobs: mpsc::Receiver<RuntimeAuthSyncJob>,
    state: Arc<AppState>,
    inflight: Arc<Mutex<HashSet<InflightKey>>>,
) {
    loop {
        let job = tokio::select! {
            job = jobs.recv() => job,
            () = tokio::time::sleep(Duration::from_secs(1)) => {
                if state.shutdown.is_shutting_down() {
                    return;
                }
                continue;
            }
        };
        let Some(job) = job else {
            return;
        };
        if state.shutdown.is_shutting_down() {
            return;
        }
        sync_after_heartbeat(&state, job.user_id, &job.device_id).await;
        inflight
            .lock()
            .expect("runtime auth sync inflight")
            .remove(&(job.user_id, job.device_id, CODEX_RUNTIME.to_owned()));
    }
}

/// The `users` projection reduced to the one column the sync consumes.
#[derive(FromMysqlRow)]
struct UserPreferencesRow {
    #[mysql(rename = "users_preferences")]
    preferences: String,
}

/// `_sync_runtime_auth_for_heartbeat_device`'s session work: the user lookup
/// and both kind lookups share one transaction, which commits when the
/// callback returns.
async fn sync_after_heartbeat(state: &AppState, user_id: i64, device_id: &str) {
    let documents = state
        .mysql
        .with_transaction(async |transaction| {
            let Some(preferences) = read_runtime_auth_documents(transaction, user_id).await? else {
                return Ok(None);
            };
            Ok(Some(preferences))
        })
        .await;
    let documents = match documents {
        Ok(documents) => documents,
        Err(error) => {
            tracing::warn!(
                %error,
                user_id,
                device = %device_id,
                "runtime auth heartbeat sync read failed"
            );
            return;
        }
    };
    let Some((preferences, config, proxy)) = documents else {
        tracing::warn!(
            user_id,
            device = %device_id,
            "Runtime auth sync skipped: user not found"
        );
        return;
    };
    let status = match execution_config_from_documents(
        CODEX_RUNTIME,
        config.as_ref(),
        &preferences,
        proxy.as_ref(),
    ) {
        Ok(status) => status,
        Err(error) => {
            tracing::warn!(
                ?error,
                user_id,
                device = %device_id,
                "runtime auth heartbeat sync failed"
            );
            return;
        }
    };
    if !status.use_user_config || !status.configured {
        return;
    }
    if let Some(config) = config.as_ref()
        && let Ok(Some(content)) = auth_file_for_sync(config)
        && super::runtime_request::sync_runtime_auth_file(
            state,
            user_id,
            device_id,
            CODEX_RUNTIME,
            &content,
        )
        .await
    {
        return;
    }
    tracing::warn!(user_id, device = %device_id, "runtime auth heartbeat sync did not complete");
}

/// The source session's three reads, in order: the `users` row, then
/// `UserRuntimeConfig(codex)` and `UserProxyConfig(default)`.
async fn read_runtime_auth_documents<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
) -> brz_mysql::MysqlResult<Option<(String, Option<KindDocumentRow>, Option<KindDocumentRow>)>> {
    let user: Option<UserPreferencesRow> = transaction
        .fetch_optional(USER_BY_ID_QUERY, (user_id,))
        .await?;
    let Some(user) = user else {
        return Ok(None);
    };
    let config =
        fetch_kind_in_transaction(transaction, RUNTIME_CONFIG_KIND, CODEX_RUNTIME, user_id).await?;
    let proxy =
        fetch_kind_in_transaction(transaction, PROXY_CONFIG_KIND, PROXY_CONFIG_NAME, user_id)
            .await?;
    Ok(Some((user.preferences, config, proxy)))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};

    use brz_mysql::{
        FromMysqlRow, MysqlArgs, MysqlError, MysqlExecution, MysqlResult, MysqlTransaction,
    };
    use futures_util::Stream;

    use super::*;

    /// Records every transaction read so the source statement order is
    /// asserted without a database. Rows are never returned.
    #[derive(Clone, Default)]
    struct RecordingTransaction {
        statements: Arc<StdMutex<Vec<(String, usize)>>>,
    }

    impl RecordingTransaction {
        fn statements(&self) -> Vec<(String, usize)> {
            self.statements.lock().unwrap().clone()
        }
    }

    impl MysqlTransaction for RecordingTransaction {
        async fn execute<S, A>(&mut self, _: S, _: A) -> MysqlResult<MysqlExecution>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
        {
            panic!("unexpected write")
        }

        async fn fetch_optional<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Option<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            let sql = sql
                .as_ref()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            self.statements.lock().unwrap().push((sql, args.len()));
            Ok(None)
        }

        async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Err(MysqlError::RowNotFound)
        }

        fn fetch<'a, S, A, T>(
            &'a mut self,
            _: S,
            _: A,
        ) -> impl Stream<Item = MysqlResult<T>> + Send + 'a
        where
            S: AsRef<str> + Send + 'a,
            A: MysqlArgs + Send + 'a,
            T: FromMysqlRow + Send + 'a,
        {
            futures_util::stream::empty()
        }

        async fn fetch_all<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Vec<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Ok(Vec::new())
        }
    }

    /// The session starts with the source's exact `users` by-id read.
    #[tokio::test]
    async fn the_session_reads_the_user_first_with_the_id_bound() {
        let recorder = RecordingTransaction::default();
        let mut transaction = recorder.clone();
        assert!(
            read_runtime_auth_documents(&mut transaction, 237)
                .await
                .expect("the read runs")
                .is_none()
        );
        let statements = recorder.statements();
        assert_eq!(statements.len(), 1, "{statements:?}");
        let (sql, args) = &statements[0];
        assert_eq!(
            sql,
            &USER_BY_ID_QUERY
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        );
        assert_eq!(*args, 1);
    }

    /// The two kind lookups follow the source order and carry the exact
    /// kind/namespace/name filters.
    #[tokio::test]
    async fn the_config_lookups_keep_the_source_order_and_filters() {
        let recorder = RecordingTransaction::default();
        let mut transaction = recorder.clone();
        fetch_kind_in_transaction(&mut transaction, RUNTIME_CONFIG_KIND, CODEX_RUNTIME, 237)
            .await
            .expect("the runtime config read runs");
        fetch_kind_in_transaction(&mut transaction, PROXY_CONFIG_KIND, PROXY_CONFIG_NAME, 237)
            .await
            .expect("the proxy config read runs");
        let statements = recorder.statements();
        assert_eq!(statements.len(), 2, "{statements:?}");
        assert!(
            statements[0].0.contains("kinds.kind = 'UserRuntimeConfig'"),
            "{}",
            statements[0].0
        );
        assert!(
            statements[0].0.contains("kinds.name = 'codex'"),
            "{}",
            statements[0].0
        );
        assert!(
            statements[1].0.contains("kinds.kind = 'UserProxyConfig'"),
            "{}",
            statements[1].0
        );
        assert!(
            statements[1].0.contains("kinds.name = 'default'"),
            "{}",
            statements[1].0
        );
        assert!(statements[1].0.contains("kinds.namespace = 'default'"));
        assert!(statements[1].0.contains("kinds.is_active IS true"));
    }

    /// With neither document present the source's early return skips
    /// `sync_auth_to_devices`: both gates are false.
    #[test]
    fn absent_documents_do_not_enable_the_auth_sync() {
        let status =
            execution_config_from_documents(CODEX_RUNTIME, None, "{}", None).expect("status");
        assert!(!status.use_user_config);
        assert!(!status.configured);
        assert!(!status.use_proxy);
    }
}

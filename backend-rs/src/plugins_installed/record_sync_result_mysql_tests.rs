//! Exercise an unchanged ACK's commit fence using the existing real HTTP fixture.
use super::*;
use crate::plugins_installed::{plugin_sync_protocol, record_sync_result, write_coordination};
use crate::plugins_marketplace::query::PluginQuery;
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};
use tokio::sync::oneshot;

#[derive(Debug, PartialEq, Eq, FromMysqlRow)]
struct DeviceState {
    state: String,
    attempt_count: i64,
    error_code: String,
    error_message: String,
}

async fn device_state(context: &Context<'_>) -> anyhow::Result<DeviceState> {
    Ok(context.mysql.fetch_one(
        "SELECT state,attempt_count,error_code,error_message FROM plugin_device_installations WHERE user_id=81001 AND installed_kind_id=? AND device_id=?",
        (context.id, context.device.as_str()),
    ).await?)
}

pub(super) async fn verify(
    context: &Context<'_>,
    state: &crate::state::AppState,
) -> anyhow::Result<()> {
    for intervening_dispatch in [false, true] {
        context.set_intent(20, true).await?;
        context.seed_removal().await?;
        context.mysql.execute(
            "UPDATE plugin_device_installations SET state='pending',desired_release_id=42,attempt_count=2,error_code='',error_message='' WHERE user_id=81001 AND installed_kind_id=? AND device_id=?",
            (context.id, context.device.as_str()),
        ).await?;
        let plan = context.plan().await?;
        let payload = plan["payload"].clone();
        let generation = plan["generation"].as_i64().unwrap();
        plugin_sync_protocol::register_plugin_snapshot_intent(
            state,
            81001,
            &context.device,
            &payload,
        )
        .await?;
        let newer_plan = context.plan().await?;

        // The ACK starts with its own generation already registered. Advancing
        // that watermark again must not change the metadata document.
        let mut query = context.mysql;
        let before = plugin_sync_protocol::lock_plugin_sync_state(&mut query, 81001).await?;
        let mut unchanged = before.json.clone();
        plugin_sync_protocol::advance_plugin_snapshot_watermark(
            &mut unchanged,
            &context.device,
            generation,
            false,
            &[context.id],
        );
        assert_eq!(unchanged, before.json);
        let original_device = device_state(context).await?;
        let original_revision = context.write_revision().await?;
        let mut result = record_sync_result::SyncResult::from_ack(
            &context.device,
            &json!({
                "success":false, "error":"obsolete failure",
                "plugin_sync":payload["plugin_sync"],
                "plugins":[{"id":context.id,"status":"failed","error":"obsolete failure"}],
            }),
        );
        result.desired_plugin_snapshot = Some(payload.clone());
        let outcome =
            paused_ack(context, state, &result, &newer_plan, intervening_dispatch).await?;
        if intervening_dispatch {
            assert_eq!(
                outcome
                    .as_ref()
                    .err()
                    .and_then(write_coordination::plugin_write_error_code),
                Some("plugin_write_conflict"),
                "An unchanged old ACK committed after a newer dispatch: {outcome:?}",
            );
            assert_eq!(device_state(context).await?, original_device);
            assert_eq!(context.write_revision().await?, original_revision);
            // The production retry re-reads the new watermark and discards the old result.
            crate::plugins_installed::registration_sync::record_registration_sync_result(
                state, 81001, &result,
            )
            .await;
            assert_eq!(device_state(context).await?, original_device);
            assert_eq!(
                context.complete(&newer_plan, "synced", 81001).await?["recorded"],
                json!([context.id]),
            );
            let current = device_state(context).await?;
            assert_eq!(
                (current.state.as_str(), current.attempt_count),
                ("installed", 0)
            );
        } else {
            outcome?;
            let current = device_state(context).await?;
            assert_eq!(
                (current.state.as_str(), current.attempt_count),
                ("failed", 3)
            );
        }
    }
    Ok(())
}

async fn paused_ack(
    context: &Context<'_>,
    state: &crate::state::AppState,
    result: &record_sync_result::SyncResult,
    newer_plan: &Value,
    intervening_dispatch: bool,
) -> anyhow::Result<MysqlResult<()>> {
    // The migration fixture deliberately has a one-connection pool. Give the
    // paused transaction its own connection so the real dispatch can commit.
    let mysql = context.independent_mysql().await?;
    let lease = write_coordination::PluginWriteLease::acquire_installed(
        context.mysql,
        state.redis.as_ref(),
        81001,
        Some(&[context.id]),
    )
    .await?;
    let (read, observed) = oneshot::channel();
    let (resume, resumed) = oneshot::channel();
    let old = async {
        let outcome = mysql
            .with_transaction_options(
                brz_mysql::MysqlTransactionOptions::default()
                    .with_isolation_level(brz_mysql::MysqlIsolationLevel::ReadCommitted),
                async |tx| {
                    let revisions = lease.read_plugin_revisions(tx).await?;
                    let mut query = PausedStateRead {
                        tx,
                        pause: Some((read, resumed)),
                    };
                    record_sync_result::record_device_sync_result_for_installs(
                        &mut query,
                        81001,
                        result,
                        Some(&lease),
                        Some(&[context.id]),
                    )
                    .await?;
                    lease.commit_plugin_revisions(query.tx, revisions).await
                },
            )
            .await;
        lease.release().await;
        outcome
    };
    let dispatch = async {
        tokio::time::timeout(std::time::Duration::from_secs(10), observed).await??;
        let revision = context.write_revision().await?;
        if intervening_dispatch {
            plugin_sync_protocol::register_plugin_snapshot_intent(
                state,
                81001,
                &context.device,
                &newer_plan["payload"],
            )
            .await?;
        }
        assert_eq!(context.write_revision().await?, revision);
        resume.send(()).unwrap();
        Ok::<_, anyhow::Error>(())
    };
    let (outcome, dispatch) = tokio::join!(old, dispatch);
    mysql.close().await;
    dispatch?;
    Ok(outcome)
}

/// Pause only after the real transaction has read its synchronization state.
struct PausedStateRead<'a, T> {
    tx: &'a mut T,
    pause: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
}

impl<Tx: MysqlTransaction> PluginQuery for PausedStateRead<'_, Tx> {
    async fn fetch_all<S: AsRef<str> + Send, A: MysqlArgs + Send, T: FromMysqlRow + Send>(
        &mut self,
        sql: S,
        args: A,
    ) -> MysqlResult<Vec<T>> {
        let is_state = sql.as_ref().contains("'PluginSyncState'");
        let rows = MysqlTransaction::fetch_all(self.tx, sql, args).await?;
        if is_state && let Some((read, resume)) = self.pause.take() {
            read.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(10), resume)
                .await
                .expect("Dispatch did not release the ACK")
                .unwrap();
        }
        Ok(rows)
    }

    async fn fetch_optional<S: AsRef<str> + Send, A: MysqlArgs + Send, T: FromMysqlRow + Send>(
        &mut self,
        sql: S,
        args: A,
    ) -> MysqlResult<Option<T>> {
        MysqlTransaction::fetch_optional(self.tx, sql, args).await
    }

    async fn execute<S: AsRef<str> + Send, A: MysqlArgs + Send>(
        &mut self,
        sql: S,
        args: A,
    ) -> MysqlResult<MysqlExecution> {
        MysqlTransaction::execute(self.tx, sql, args).await
    }
}

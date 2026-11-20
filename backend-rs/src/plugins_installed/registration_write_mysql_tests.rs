//! Exercise real database waits while registration owns installation leases.
use super::*;
use crate::plugins_installed::{registration_sync, write_coordination};
use brz_redis::{Redis, RedisBytes};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};

#[path = "receipt_row_lock_mysql_tests.rs"]
mod receipt_row_lock_tests;

struct ReleaseBlocker<'a>(&'a Notify);

impl Drop for ReleaseBlocker<'_> {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

pub(super) async fn verify(
    context: &Context<'_>,
    state: &crate::state::AppState,
) -> anyhow::Result<()> {
    eprintln!("[plugin-local-sync] Validating registration under pool contention");
    verify_pool_wait_budget(context, state).await?;
    eprintln!("[plugin-local-sync] Validating batch receipt isolation");
    verify_batch_receipt_isolation(context, state).await?;
    eprintln!("[plugin-local-sync] Validating blocked-row receipt isolation");
    receipt_row_lock_tests::verify(context, state).await?;
    // A separate connection must hold the row, not exhaust the fixture's
    // one-connection writer pool before registration can acquire its lease.
    eprintln!("[plugin-local-sync] Validating registration under row contention");
    let blocker_mysql = context.independent_mysql().await?;
    let failure = tokio::time::timeout(
        Duration::from_secs(10),
        verify_row_wait_budget(context, state, &blocker_mysql, false,
            "UPDATE missing_registration_receipt_rows SET state=state WHERE installed_kind_id=? AND device_id=?"),
    ).await.expect("A failed row blocker left registration waiting indefinitely").unwrap_err();
    assert!(
        failure
            .to_string()
            .contains("missing_registration_receipt_rows"),
        "The fixture hid its blocker database error: {failure}"
    );
    let outcome = async {
        for prepare in [false, true] {
            verify_row_wait_budget(context, state, &blocker_mysql, prepare,
                "UPDATE plugin_device_installations SET state=state WHERE user_id=81001 AND installed_kind_id=? AND device_id=?").await?;
        }
        Ok(())
    }.await;
    blocker_mysql.close().await;
    outcome
}

async fn verify_row_wait_budget(
    context: &Context<'_>,
    state: &crate::state::AppState,
    blocker_mysql: &brz_mysql::MysqlService,
    prepare: bool,
    blocker_statement: &str,
) -> anyhow::Result<()> {
    context
        .set_intent(if prepare { 96 } else { 95 }, true)
        .await?;
    let plan = context.plan().await?;
    context.complete(&plan, "synced", 81001).await?;
    // A queued but already-converged row would correctly avoid any UPDATE.
    // A different desired release forces both preparation and ACK to write.
    context.mysql.execute("UPDATE plugin_device_installations SET state='pending',desired_release_id=0,actual_release_id=0 WHERE user_id=81001 AND installed_kind_id=? AND device_id=?", (context.id,context.device.as_str())).await?;
    let plan = context.plan().await?;
    crate::plugins_installed::plugin_sync_protocol::register_plugin_snapshot_intent(
        state,
        81001,
        &context.device,
        &plan["payload"],
    )
    .await?;
    let mut result = crate::plugins_installed::record_sync_result::SyncResult::from_ack(
        &context.device,
        &json!({"success":true,"plugin_sync":plan["payload"]["plugin_sync"],"plugins":[{"id":context.id,"status":"synced"}]}),
    );
    result.desired_plugin_snapshot = Some(plan["payload"].clone());
    let revision = context.write_revision().await?;
    let key = "wegent:plugin-write:81001:target";
    let (locked, ready) = tokio::sync::oneshot::channel();
    let release = Notify::new();
    let observed = AtomicBool::new(false);
    let redis = state.redis.as_ref().expect("The fixture requires Redis");
    let blocker = blocker_mysql.with_transaction(async |tx| {
        tx.execute(blocker_statement, (context.id, context.device.as_str()))
            .await?;
        let _ = locked.send(());
        release.notified().await;
        Ok(())
    });
    let writer = async {
        let _release = ReleaseBlocker(&release);
        ready.await?;
        let start = Instant::now();
        let deadline = start + Duration::from_secs(2);
        let outcome = if prepare {
            let outcome = registration_sync::prepare_plugins_for_registered_device_until(
                state,
                81001,
                &context.device,
                deadline,
            )
            .await;
            assert_eq!(
                outcome,
                crate::plugins_installed::PluginPreparation::Deferred
            );
            None
        } else {
            Some(
                registration_sync::record_registration_sync_result_until(
                    state, 81001, &result, deadline,
                )
                .await,
            )
        };
        release.notify_one();
        if let Some(outcome) = outcome {
            assert_eq!(
                outcome
                    .as_ref()
                    .err()
                    .and_then(write_coordination::plugin_write_error_code),
                Some("plugin_write_busy"),
                "Registration ACK outcome: {outcome:?}"
            );
        }
        assert!(start.elapsed() >= Duration::from_secs(2));
        assert!(
            observed.load(Ordering::SeqCst),
            "The writer did not reach lease ownership"
        );
        for key in [key, "wegent:plugin-write:81001:unrelated"] {
            let mut command = brz_redis::cmd("GET");
            command.arg(key);
            let owner: Option<RedisBytes> = redis.command(command).await?;
            assert!(
                owner.is_none(),
                "Registration leaked {key} after its transaction deadline"
            );
        }
        Ok::<_, anyhow::Error>(())
    };
    let observer = async {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let mut command = brz_redis::cmd("GET");
                command.arg(key);
                let owner: Option<RedisBytes> = redis.command(command).await?;
                if owner.is_some() {
                    observed.store(true, Ordering::SeqCst);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        Ok::<_, anyhow::Error>(())
    };
    let (blocked, written, seen) = tokio::join!(blocker, writer, observer);
    blocked?;
    written?;
    seen?;
    assert_eq!(context.state().await?.as_deref(), Some("pending"));
    assert_eq!(
        context.write_revision().await?,
        revision,
        "A timed-out writer committed its parent revision"
    );
    #[derive(FromMysqlRow)]
    struct Releases {
        desired_release_id: i64,
        actual_release_id: i64,
    }
    let persisted: Releases = context.mysql.fetch_one("SELECT desired_release_id,actual_release_id FROM plugin_device_installations WHERE user_id=81001 AND installed_kind_id=? AND device_id=?",(context.id,context.device.as_str())).await?;
    assert_eq!(
        (persisted.desired_release_id, persisted.actual_release_id),
        (0, 0),
        "A cancelled transaction changed device state"
    );
    write_coordination::PluginWriteLease::acquire_installed(
        context.mysql,
        state.redis.as_ref(),
        81001,
        Some(&[context.id]),
    )
    .await?
    .release()
    .await;
    Ok(())
}

async fn verify_pool_wait_budget(
    context: &Context<'_>,
    state: &crate::state::AppState,
) -> anyhow::Result<()> {
    let failure = tokio::time::timeout(
        Duration::from_secs(5),
        verify_pool_wait(
            context,
            state,
            false,
            "SELECT id,json FROM missing_plugin_pool_rows WHERE id=?",
        ),
    )
    .await
    .expect("A failed pool holder left registration waiting indefinitely")
    .unwrap_err();
    assert!(
        failure.to_string().contains("missing_plugin_pool_rows"),
        "The fixture hid its pool-holder database error: {failure}"
    );
    for prepare in [false, true] {
        verify_pool_wait(
            context,
            state,
            prepare,
            "SELECT id,json FROM kinds WHERE id=?",
        )
        .await?;
    }
    Ok(())
}

async fn verify_pool_wait(
    context: &Context<'_>,
    state: &crate::state::AppState,
    prepare: bool,
    holder_statement: &str,
) -> anyhow::Result<()> {
    let (locked, ready) = tokio::sync::oneshot::channel();
    let release = Notify::new();
    let holder = context.mysql.with_transaction(async |tx| {
        tx.fetch_one::<_, _, StoredKind>(holder_statement, (context.id,))
            .await?;
        let _ = locked.send(());
        release.notified().await;
        Ok(())
    });
    let queued = async {
        let _release = ReleaseBlocker(&release);
        ready.await?;
        let start = Instant::now();
        let deadline = start + Duration::from_millis(100);
        if prepare {
            let outcome = registration_sync::prepare_plugins_for_registered_device_until(
                state,
                81001,
                &context.device,
                deadline,
            )
            .await;
            release.notify_one();
            assert_eq!(
                outcome,
                crate::plugins_installed::PluginPreparation::Deferred
            );
        } else {
            let result = crate::plugins_installed::record_sync_result::SyncResult::from_ack(
                &context.device,
                &json!({"success":true}),
            );
            let outcome = registration_sync::record_registration_sync_result_until(
                state, 81001, &result, deadline,
            )
            .await;
            release.notify_one();
            assert_eq!(
                outcome
                    .as_ref()
                    .err()
                    .and_then(write_coordination::plugin_write_error_code),
                Some("plugin_write_busy")
            );
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "Initialization ignored the request budget while waiting for the pool"
        );
        Ok::<_, anyhow::Error>(())
    };
    let (held, queued) = tokio::join!(holder, queued);
    held?;
    queued?;
    Ok(())
}

/// Both receipt entry points must persist an unblocked peer from the same ACK,
/// even when the first installation remains leased beyond the entire budget.
async fn verify_batch_receipt_isolation(
    context: &Context<'_>,
    state: &crate::state::AppState,
) -> anyhow::Result<()> {
    eprintln!("[plugin-local-sync] Inserting the batch receipt peer");
    context.mysql.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) SELECT user_id,kind,namespace,'batch-receipt-peer',JSON_SET(json,'$.spec.installState','installed'),1,NOW(),NOW() FROM kinds WHERE id=?", (context.id,)).await?;
    eprintln!("[plugin-local-sync] Reading the batch receipt peer");
    let row: StoredKind = context.mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81001 AND kind='InstalledPlugin' AND namespace='default' AND name='batch-receipt-peer'", ()).await?;
    let peer = Context {
        mysql: context.mysql,
        address: context.address,
        id: row.id,
        device: context.device.clone(),
    };
    for registration in [false, true] {
        eprintln!("[plugin-local-sync] Seeding pending batch rows (registration={registration})");
        context
            .set_intent(if registration { 81 } else { 80 }, true)
            .await?;
        for id in [context.id, peer.id] {
            context.mysql.execute("INSERT INTO plugin_device_installations (user_id,installed_kind_id,device_id,desired_release_id,actual_release_id,state,last_sync_at,updated_at) VALUES (81001,?,?,42,0,'pending',NOW(),NOW()) ON DUPLICATE KEY UPDATE desired_release_id=42,actual_release_id=0,state='pending'", (id, context.device.as_str())).await?;
        }
        eprintln!("[plugin-local-sync] Fetching the batch snapshot (registration={registration})");
        let response = context
            .post(
                81001,
                "/api/plugins/local-sync",
                json!({"protocolVersion":1,"instanceId":"native"}),
            )
            .await?;
        assert_eq!(response.status().as_u16(), 200);
        let plan: Value = response.json().await?;
        let ack = json!({"success":true,"plugin_sync":plan["payload"]["plugin_sync"],"plugins":[{"id":context.id,"status":"synced"},{"id":peer.id,"status":"synced"}]});
        let mut result = crate::plugins_installed::record_sync_result::SyncResult::from_ack(
            &context.device,
            &ack,
        );
        result.desired_plugin_snapshot = Some(plan["payload"].clone());
        if registration {
            eprintln!("[plugin-local-sync] Registering the batch snapshot intent");
            crate::plugins_installed::plugin_sync_protocol::register_plugin_snapshot_intent(
                state,
                81001,
                &context.device,
                &plan["payload"],
            )
            .await?;
        }
        eprintln!(
            "[plugin-local-sync] Leasing the blocked batch row (registration={registration})"
        );
        let revision = context.write_revision().await?;
        let lease = write_coordination::PluginWriteLease::acquire_installed(
            context.mysql,
            state.redis.as_ref(),
            81001,
            Some(&[context.id]),
        )
        .await?;
        eprintln!("[plugin-local-sync] Recording the batch receipt (registration={registration})");
        let observed = async {
            let deadline = Instant::now() + Duration::from_secs(2);
            let outcome = if registration {
                registration_sync::record_registration_sync_result_until(
                    state, 81001, &result, deadline,
                )
                .await
            } else {
                let completion = serde_json::from_value(
                    json!({"deviceId":context.device,"generation":plan["generation"],"installedRevisions":plan["installedRevisions"],"result":ack}),
                )?;
                super::super::completion::record_until(
                    context.mysql,
                    state.redis.as_ref(),
                    81001,
                    completion,
                    deadline,
                )
                .await
                .map(|_| ())
            };
            // Observe both rows before releasing A: B must have committed while A
            // remained blocked, and the timed-out A must not report false success.
            eprintln!("[plugin-local-sync] Checking persisted batch rows (registration={registration})");
            let peer_state = peer.state().await?;
            let blocked_state = context.state().await?;
            let blocked_revision = context.write_revision().await?;
            lease.verify_owned().await?;
            Ok::<_, anyhow::Error>((outcome, peer_state, blocked_state, blocked_revision, deadline))
        }.await;
        lease.release().await;
        let (outcome, peer_state, blocked_state, blocked_revision, deadline) = observed?;
        assert_eq!(
            outcome
                .as_ref()
                .err()
                .and_then(write_coordination::plugin_write_error_code),
            Some("plugin_write_busy")
        );
        assert_eq!(
            peer_state.as_deref(),
            Some("installed"),
            "The same batch's unblocked peer was starved: registration={registration}"
        );
        assert_eq!(blocked_state.as_deref(), Some("pending"));
        assert_eq!(blocked_revision, revision);
        assert!(Instant::now() >= deadline);
    }
    eprintln!("[plugin-local-sync] Removing the batch receipt peer");
    context
        .mysql
        .execute(
            "DELETE FROM plugin_device_installations WHERE user_id=81001 AND installed_kind_id=?",
            (peer.id,),
        )
        .await?;
    context
        .mysql
        .execute("DELETE FROM kinds WHERE user_id=81001 AND id=?", (peer.id,))
        .await?;
    Ok(())
}

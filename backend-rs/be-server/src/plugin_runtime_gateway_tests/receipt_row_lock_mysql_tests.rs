//! A blocked device row must not monopolize the account protocol row.
use super::*;

const BLOCK_DEVICE_ROW: &str = "UPDATE plugin_device_installations SET state=state WHERE user_id=81001 AND installed_kind_id=? AND device_id=?";

pub(super) async fn verify(
    context: &Context<'_>,
    state: &wegent_plugin_runtime::PluginState,
) -> anyhow::Result<()> {
    let writer_pool = context.independent_mysql_with_capacity(4).await?;
    let blocker_pool = context.independent_mysql().await?;
    let mut writer_state = crate::build_app_state().await?.plugin_runtime_state();
    writer_state.mysql = writer_pool.clone();
    writer_state.redis = state.redis.clone();
    context.mysql.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) SELECT user_id,kind,namespace,'row-lock-receipt-peer',JSON_SET(json,'$.spec.installState','installed'),1,NOW(),NOW() FROM kinds WHERE id=?", (context.id,)).await?;
    let peer_row: StoredKind = context.mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81001 AND kind='InstalledPlugin' AND namespace='default' AND name='row-lock-receipt-peer'", ()).await?;
    let peer = Context {
        mysql: context.mysql,
        address: context.address,
        id: peer_row.id,
        device: context.device.clone(),
    };
    let failure = tokio::time::timeout(Duration::from_secs(10), verify_receipt(
        context, &peer, &writer_state, &blocker_pool, false,
        "UPDATE missing_plugin_receipt_rows SET state=state WHERE installed_kind_id=? AND device_id=?",
        None,
    )).await.expect("A failed blocker left the receipt waiting indefinitely").unwrap_err();
    assert!(
        failure.to_string().contains("missing_plugin_receipt_rows"),
        "The fixture hid its blocker database error: {failure}"
    );
    write_coordination::PluginWriteLease::acquire_installed(
        context.mysql,
        state.redis.as_ref(),
        81001,
        Some(&[peer.id]),
    )
    .await?
    .release()
    .await;
    let failure = tokio::time::timeout(
        Duration::from_secs(10),
        verify_receipt(
            context,
            &peer,
            &writer_state,
            &blocker_pool,
            false,
            BLOCK_DEVICE_ROW,
            Some("SELECT * FROM missing_receipt_inspection_rows"),
        ),
    )
    .await
    .expect("A failed inspection left the device row locked")
    .unwrap_err();
    assert!(
        failure
            .to_string()
            .contains("missing_receipt_inspection_rows"),
        "The fixture hid its inspection database error: {failure}"
    );
    // A new owner must be admitted after either fixture failure.
    write_coordination::PluginWriteLease::acquire_installed(
        context.mysql,
        state.redis.as_ref(),
        81001,
        Some(&[context.id, peer.id]),
    )
    .await?
    .release()
    .await;
    for registration in [false, true] {
        verify_receipt(
            context,
            &peer,
            &writer_state,
            &blocker_pool,
            registration,
            BLOCK_DEVICE_ROW,
            None,
        )
        .await?;
    }
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
    writer_pool.close().await;
    blocker_pool.close().await;
    Ok(())
}

async fn verify_receipt(
    context: &Context<'_>,
    peer: &Context<'_>,
    state: &wegent_plugin_runtime::PluginState,
    blocker: &brz_mysql::MysqlService,
    registration: bool,
    blocker_statement: &str,
    inspection_statement: Option<&str>,
) -> anyhow::Result<()> {
    context
        .set_intent(if registration { 84 } else { 83 }, true)
        .await?;
    let target = context.plan().await?;
    context.complete(&target, "synced", 81001).await?;
    context.mysql.execute("INSERT INTO plugin_device_installations (user_id,installed_kind_id,device_id,state,desired_release_id,actual_release_id,last_sync_at,updated_at) VALUES (81001,?,'completion-device','pending',42,0,NOW()-INTERVAL 1 DAY,NOW()-INTERVAL 1 DAY)", (context.id,)).await?;
    context.mysql.execute("INSERT INTO plugin_device_installations (user_id,installed_kind_id,device_id,state,desired_release_id,actual_release_id,last_sync_at,updated_at) VALUES (81001,?,?,'pending',42,0,NOW(),NOW()) ON DUPLICATE KEY UPDATE state='pending',actual_release_id=0", (peer.id, context.device.as_str())).await?;
    let response = context
        .post(
            81001,
            "/api/plugins/local-sync",
            json!({"protocolVersion":1,"instanceId":"native"}),
        )
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    let plan: Value = response.json().await?;
    wegent_plugin_runtime::test_support::plugin_sync_protocol::register_plugin_snapshot_intent(
        state,
        81001,
        &context.device,
        &plan["payload"],
    )
    .await?;
    let ack = json!({"success":true,"plugin_sync":plan["payload"]["plugin_sync"],"plugins":[{"id":context.id,"status":"synced"},{"id":peer.id,"status":"synced"}]});
    let mut result = wegent_plugin_runtime::test_support::record_sync_result::SyncResult::from_ack(
        &context.device,
        &ack,
    );
    result.desired_plugin_snapshot = Some(plan["payload"].clone());
    let revision = context.write_revision().await?;
    let peer_lease = write_coordination::PluginWriteLease::acquire_installed(
        context.mysql,
        state.redis.as_ref(),
        81001,
        Some(&[peer.id]),
    )
    .await?;
    let (locked, observed) = tokio::sync::oneshot::channel();
    let release = Notify::new();
    let hold = blocker.with_transaction(async |tx| {
        tx.execute(blocker_statement, (context.id, context.device.as_str()))
            .await?;
        let _ = locked.send(());
        release.notified().await;
        Ok(())
    });
    let write = async {
        let _release = ReleaseBlocker(&release);
        observed.await?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let outcome = if registration {
            registration_sync::record_registration_sync_result_until(
                state, 81001, &result, deadline,
            )
            .await
        } else {
            let completion = serde_json::from_value(
                json!({"deviceId":context.device,"generation":plan["generation"],"installedRevisions":plan["installedRevisions"],"result":ack}),
            )?;
            completion::record_until(
                &state.mysql,
                state.redis.as_ref(),
                81001,
                completion,
                deadline,
            )
            .await
            .map(|_| ())
        };
        // Inspect through an independent connection before releasing A's row.
        if let Some(statement) = inspection_statement {
            context.mysql.execute(statement, ()).await?;
        }
        let peer_state = peer.state().await?;
        let unchanged_revision = context.write_revision().await?;
        anyhow::ensure!(
            outcome
                .as_ref()
                .err()
                .and_then(write_coordination::plugin_write_error_code)
                == Some("plugin_write_busy"),
            "Unexpected blocked receipt outcome: {outcome:?}"
        );
        anyhow::ensure!(
            peer_state.as_deref() == Some("installed"),
            "A's row lock starved B: registration={registration}, state={peer_state:?}"
        );
        anyhow::ensure!(
            unchanged_revision == revision,
            "Blocked A committed its revision"
        );
        Ok::<_, anyhow::Error>(())
    };
    let admit_peer = async {
        // Hold B's Redis lease until MySQL confirms that A is waiting on its
        // canonical row. This prevents B winning the race from masking the bug.
        let seen = tokio::time::timeout(Duration::from_secs(3), async {
            #[derive(FromMysqlRow)]
            struct Count { n: i64 }
            loop {
                let count: Count = context.mysql.fetch_one("SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks b ON b.ENGINE_LOCK_ID=w.BLOCKING_ENGINE_LOCK_ID WHERE b.OBJECT_SCHEMA=DATABASE() AND b.OBJECT_NAME='plugin_device_installations'", ()).await?;
                if count.n > 0 { return Ok::<_, anyhow::Error>(()); }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await;
        // Start B's transaction after A, giving it its own attempt window.
        // The real MySQL wait above, rather than this delay, establishes order.
        if matches!(&seen, Ok(Ok(()))) {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        peer_lease.release().await;
        if !matches!(&seen, Ok(Ok(()))) {
            release.notify_one();
        }
        seen??;
        Ok::<_, anyhow::Error>(())
    };
    let (held, written, admitted) = tokio::join!(hold, write, admit_peer);
    held?;
    admitted?;
    written?;
    Ok(())
}

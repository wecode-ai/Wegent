//! Real completion, stale receipt and ownership checks in the existing HTTP fixture.
use super::*;

#[path = "record_sync_result_mysql_tests.rs"]
mod ack_fence_tests;
#[path = "registration_write_mysql_tests.rs"]
mod registration_write_tests;

pub(super) async fn verify(
    mysql: &brz_mysql::MysqlService,
    address: std::net::SocketAddr,
    id: i64,
    state: &crate::state::AppState,
) -> anyhow::Result<()> {
    // A nonzero release catches a source insert that accidentally keeps ORM defaults.
    mysql.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.releaseId',42) WHERE user_id=81001 AND id=?", (id,)).await?;
    mysql.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (81001,'Device','default','completion-device',?,1,NOW(),NOW())",
        (json!({"spec":{"deviceType":"app","deviceId":"completion-device"}}),)).await?;
    let device: StoredKind = mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81001 AND kind='Device' AND namespace='default' AND name='completion-device'", ()).await?;
    let context = Context {
        mysql,
        address,
        id,
        device: format!("app-record-{}", device.id),
    };
    context.set_intent(2, false).await?;
    context.seed_removal().await?;
    let removal = context.plan().await?;
    for invalid in [
        {
            let mut receipt = context.receipt(&removal, "removed");
            receipt["completion"]["result"]["success"] = json!(false);
            receipt
        },
        {
            let mut receipt = context.receipt(&removal, "removed");
            receipt["completion"]["result"]["plugins"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":id,"status":"failed"}));
            receipt
        },
    ] {
        assert_eq!(
            context
                .post(81001, "/api/plugins/local-sync/complete", invalid)
                .await?
                .status()
                .as_u16(),
            422
        );
        assert_eq!(context.state().await?.as_deref(), Some("uninstalling"));
    }
    let mut future = removal.clone();
    future["generation"] = json!(removal["generation"].as_i64().unwrap() + 1);
    assert_eq!(
        context.complete(&future, "removed", 81001).await?["superseded"],
        json!([id])
    );
    assert_eq!(context.state().await?.as_deref(), Some("uninstalling"));
    let dispatched = context.plan().await?;
    crate::plugins_installed::plugin_sync_protocol::register_plugin_snapshot_intent(
        state,
        81001,
        &context.device,
        &dispatched["payload"],
    )
    .await?;
    assert_eq!(
        context.complete(&removal, "removed", 81001).await?["recorded"],
        json!([id])
    );
    assert_eq!(context.state().await?, None);
    context.set_intent(3, true).await?;
    let install = context.plan().await?;
    let dispatched = context.plan().await?;
    crate::plugins_installed::plugin_sync_protocol::register_plugin_snapshot_intent(
        state,
        81001,
        &context.device,
        &dispatched["payload"],
    )
    .await?;
    assert_eq!(
        context.complete(&install, "synced", 81001).await?["recorded"],
        json!([id])
    );
    assert_eq!(context.state().await?.as_deref(), Some("installed"));
    #[derive(FromMysqlRow)]
    struct Releases {
        desired_release_id: i64,
        actual_release_id: i64,
    }
    let row: Releases = mysql.fetch_one("SELECT desired_release_id,actual_release_id FROM plugin_device_installations WHERE user_id=81001 AND installed_kind_id=? AND device_id=?", (id,context.device.as_str())).await?;
    assert_eq!((row.desired_release_id, row.actual_release_id), (42, 42));
    let revision = context.write_revision().await?;
    assert_eq!(
        context.complete(&install, "synced", 81001).await?["recorded"],
        json!([id])
    );
    assert_eq!(
        context.write_revision().await?,
        revision,
        "Duplicate receipt changed its write revision"
    );
    context.set_intent(4, false).await?;
    context.seed_removal().await?;
    let late_removal = context.plan().await?;
    context.set_intent(5, true).await?;
    let reinstall = context.plan().await?;
    assert_eq!(
        context.complete(&reinstall, "synced", 81001).await?["recorded"],
        json!([id])
    );
    assert_eq!(
        context.complete(&late_removal, "removed", 81001).await?["superseded"],
        json!([id])
    );
    assert_eq!(context.state().await?.as_deref(), Some("installed"));
    assert_eq!(
        context.complete(&install, "synced", 81001).await?["superseded"],
        json!([id])
    );
    let mut coalesced = reinstall.clone();
    coalesced["generation"] = json!(reinstall["generation"].as_i64().unwrap() - 1);
    assert_eq!(
        context.complete(&coalesced, "synced", 81001).await?["recorded"],
        json!([id])
    );
    let response = context
        .post(
            81002,
            "/api/plugins/local-sync/complete",
            context.receipt(&reinstall, "synced"),
        )
        .await?;
    assert_eq!(
        response.status().as_u16(),
        403,
        "Foreign account acknowledged an owned Device"
    );
    context.set_intent(6, false).await?;
    let latest = context.plan().await?;
    context.complete(&latest, "removed", 81001).await?;
    assert_eq!(
        context.complete(&reinstall, "synced", 81001).await?["superseded"],
        json!([id])
    );
    assert_eq!(
        context.state().await?,
        None,
        "Old install restored an uninstalled plugin"
    );
    ack_fence_tests::verify(&context, state).await?;
    verify_alias_cleanup(&context, state).await?;
    eprintln!("[plugin-local-sync] Validating registration concurrency and row locks");
    registration_write_tests::verify(&context, state).await?;
    eprintln!("[plugin-local-sync] Validating independent completion under contention");
    verify_contention(&context, state).await?;
    verify_independent_receipt_watermarks(&context).await?;
    Ok(())
}

async fn verify_independent_receipt_watermarks(context: &Context<'_>) -> anyhow::Result<()> {
    use crate::plugins_installed::plugin_sync_protocol::{
        lock_plugin_sync_state, merge_local_receipt_watermark, plugin_snapshot_watermark,
    };
    let plan = context.plan().await?;
    let generation = plan["generation"].as_i64().unwrap();
    let device = "receipt-merge-fixture";
    let mut query = context.mysql;
    let snapshot = lock_plugin_sync_state(&mut query, 81001).await?;
    context
        .mysql
        .with_transaction(async |tx| {
            let mut query = &mut *tx;
            merge_local_receipt_watermark(&mut query, 81001, &snapshot, device, 1, generation).await
        })
        .await?;
    context
        .mysql
        .with_transaction(async |tx| {
            let mut query = &mut *tx;
            merge_local_receipt_watermark(&mut query, 81001, &snapshot, device, 2, generation).await
        })
        .await?;
    let error = context
        .mysql
        .with_transaction(async |tx| {
            let mut query = &mut *tx;
            merge_local_receipt_watermark(&mut query, 81001, &snapshot, device, 1, generation).await
        })
        .await
        .expect_err("A changed watermark for the same plugin must be revalidated");
    assert_eq!(
        crate::plugins_installed::write_coordination::plugin_write_error_code(&error),
        Some("plugin_write_conflict")
    );
    let stored = lock_plugin_sync_state(&mut query, 81001).await?;
    assert_eq!(
        plugin_snapshot_watermark(&stored.json, device, 1),
        generation
    );
    assert_eq!(
        plugin_snapshot_watermark(&stored.json, device, 2),
        generation
    );
    Ok(())
}

async fn verify_alias_cleanup(
    context: &Context<'_>,
    state: &crate::state::AppState,
) -> anyhow::Result<()> {
    #[derive(FromMysqlRow)]
    struct DeviceRowCount {
        n: i64,
    }
    context.set_intent(90, true).await?;
    context.mysql.execute("INSERT INTO plugin_device_installations (user_id,installed_kind_id,device_id,state,desired_release_id,actual_release_id,last_sync_at,updated_at) VALUES (81001,?,'completion-device','pending',42,0,NOW()-INTERVAL 1 DAY,NOW()-INTERVAL 1 DAY)", (context.id,)).await?;
    let plan = context.plan().await?;
    assert_eq!(
        context.complete(&plan, "synced", 81001).await?["recorded"],
        json!([context.id])
    );
    let count = context.mysql.fetch_one::<_,_,DeviceRowCount>("SELECT COUNT(*) AS n FROM plugin_device_installations WHERE user_id=81001 AND installed_kind_id=?", (context.id,)).await?;
    assert_eq!(
        count.n, 1,
        "Local-only confirmation retained a duplicate legacy alias"
    );
    assert_eq!(context.state().await?.as_deref(), Some("installed"));
    // A converged canonical row must not hide a duplicate legacy alias.
    context.mysql.execute("INSERT INTO plugin_device_installations (user_id,installed_kind_id,device_id,state,desired_release_id,actual_release_id,last_sync_at,updated_at) VALUES (81001,?,'completion-device','pending',42,0,NOW()-INTERVAL 1 DAY,NOW()-INTERVAL 1 DAY)", (context.id,)).await?;
    let revision = context.write_revision().await?;
    assert_eq!(
        context.complete(&plan, "synced", 81001).await?["recorded"],
        json!([context.id])
    );
    let count = context.mysql.fetch_one::<_,_,DeviceRowCount>("SELECT COUNT(*) AS n FROM plugin_device_installations WHERE user_id=81001 AND installed_kind_id=?", (context.id,)).await?;
    assert_eq!(
        count.n, 1,
        "Converged install retained a duplicate legacy alias"
    );
    assert_eq!(
        context.write_revision().await?,
        json!(revision.as_i64().unwrap() + 1),
        "Alias cleanup bypassed the revision commit fence"
    );
    let revision = context.write_revision().await?;
    context.complete(&plan, "synced", 81001).await?;
    assert_eq!(
        context.write_revision().await?,
        revision,
        "Converged install receipt performed a write"
    );
    context.set_intent(91, false).await?;
    let removal = context.plan().await?;
    crate::plugins_installed::plugin_sync_protocol::register_plugin_snapshot_intent(
        state,
        81001,
        &context.device,
        &removal["payload"],
    )
    .await?;
    // Dispatch already advanced the watermark, but only the alias row remains.
    context.mysql.execute("UPDATE plugin_device_installations SET device_id='completion-device' WHERE user_id=81001 AND installed_kind_id=? AND device_id=?", (context.id, context.device.as_str())).await?;
    let revision = context.write_revision().await?;
    assert_eq!(
        context.complete(&removal, "removed", 81001).await?["recorded"],
        json!([context.id])
    );
    let count = context.mysql.fetch_one::<_,_,DeviceRowCount>("SELECT COUNT(*) AS n FROM plugin_device_installations WHERE user_id=81001 AND installed_kind_id=?", (context.id,)).await?;
    assert_eq!(count.n, 0, "Local uninstall retained a legacy device row");
    assert_eq!(
        context.write_revision().await?,
        json!(revision.as_i64().unwrap() + 1),
        "Alias removal bypassed the revision commit fence"
    );
    let revision = context.write_revision().await?;
    context.complete(&removal, "removed", 81001).await?;
    assert_eq!(
        context.write_revision().await?,
        revision,
        "Converged removal receipt performed a write"
    );
    verify_implicit_alias_removal(context, &removal).await?;
    Ok(())
}

async fn verify_implicit_alias_removal(
    context: &Context<'_>,
    removal: &Value,
) -> anyhow::Result<()> {
    context.mysql.execute("INSERT INTO plugin_device_installations (user_id,installed_kind_id,device_id,state,last_sync_at,updated_at) VALUES (81001,?,'completion-device','uninstalling',NOW(),NOW())", (context.id,)).await?;
    let mut receipt = context.receipt(removal, "removed");
    receipt["completion"]["result"]["plugin_sync"]["complete"] = json!(true);
    receipt["completion"]["result"]["plugins"] = json!([]);
    let revision = context.write_revision().await?;
    let response = context
        .post(81001, "/api/plugins/local-sync/complete", receipt.clone())
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.json::<Value>().await?["recorded"],
        json!([context.id])
    );
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    let count: Count = context.mysql.fetch_one("SELECT COUNT(*) AS n FROM plugin_device_installations WHERE user_id=81001 AND installed_kind_id=?", (context.id,)).await?;
    assert_eq!(
        count.n, 0,
        "Full completion missed an alias-only implicit removal"
    );
    assert_eq!(
        context.write_revision().await?,
        json!(revision.as_i64().unwrap() + 1)
    );
    let revision = context.write_revision().await?;
    let response = context
        .post(81001, "/api/plugins/local-sync/complete", receipt)
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.json::<Value>().await?["recorded"], json!([]));
    assert_eq!(context.write_revision().await?, revision);
    Ok(())
}

async fn verify_contention(
    context: &Context<'_>,
    state: &crate::state::AppState,
) -> anyhow::Result<()> {
    use crate::plugins_installed::write_coordination::PluginWriteLease;
    use std::time::Duration;
    context.set_intent(100, true).await?;
    let plan = context.plan().await?;
    context.mysql.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) SELECT user_id,kind,namespace,'independent-completion',json,1,NOW(),NOW() FROM kinds WHERE id=?", (context.id,)).await?;
    let row: StoredKind = context.mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81001 AND kind='InstalledPlugin' AND namespace='default' AND name='independent-completion'", ()).await?;
    let other = Context {
        mysql: context.mysql,
        address: context.address,
        id: row.id,
        device: context.device.clone(),
    };
    let other_plan = other.plan().await?;
    crate::plugins_installed::plugin_sync_protocol::register_plugin_snapshot_intent(
        state,
        81001,
        &context.device,
        &plan["payload"],
    )
    .await?;
    let lease = PluginWriteLease::acquire_installed(
        context.mysql,
        state.redis.as_ref(),
        81001,
        Some(&[context.id]),
    )
    .await?;
    let start = tokio::time::Instant::now();
    let mut registration = crate::plugins_installed::record_sync_result::SyncResult::from_ack(
        &context.device,
        &json!({"success":true,"plugin_sync":plan["payload"]["plugin_sync"],"plugins":[{"id":context.id,"status":"synced"}]}),
    );
    registration.desired_plugin_snapshot = Some(plan["payload"].clone());
    let (receipt, registered, independent) = tokio::join!(
        context.complete(&plan, "synced", 81001),
        crate::plugins_installed::registration_sync::record_registration_sync_result_until(
            state,
            81001,
            &registration,
            start + Duration::from_secs(20),
        ),
        async {
            let receipt = other.complete(&other_plan, "synced", 81001).await?;
            assert_eq!(receipt["recorded"], json!([other.id]));
            assert_eq!(other.state().await?.as_deref(), Some("installed"));
            // Deterministically exceed the original 3-second acquisition limit.
            tokio::time::sleep_until(start + Duration::from_secs(6)).await;
            lease.release().await;
            Ok::<_, anyhow::Error>(())
        }
    );
    independent?;
    registered?;
    assert_eq!(receipt?["recorded"], json!([context.id]));
    assert!(start.elapsed() >= Duration::from_secs(6));
    assert_eq!(context.state().await?.as_deref(), Some("installed"));

    context.set_intent(101, true).await?;
    let obsolete = context.plan().await?;
    let lease = PluginWriteLease::acquire_installed(
        context.mysql,
        state.redis.as_ref(),
        81001,
        Some(&[context.id]),
    )
    .await?;
    let (receipt, changed) = tokio::join!(context.complete(&obsolete, "synced", 81001), async {
        tokio::time::sleep(Duration::from_millis(150)).await;
        context.set_intent(102, false).await?;
        context.seed_removal().await?;
        lease.release().await;
        Ok::<_, anyhow::Error>(())
    });
    changed?;
    assert_eq!(receipt?["superseded"], json!([context.id]));
    assert_eq!(context.state().await?.as_deref(), Some("uninstalling"));
    // The completed request relinquished its lease rather than leaking it.
    PluginWriteLease::acquire_installed(
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

struct Context<'a> {
    mysql: &'a brz_mysql::MysqlService,
    address: std::net::SocketAddr,
    id: i64,
    device: String,
}

impl Context<'_> {
    async fn independent_mysql(&self) -> anyhow::Result<brz_mysql::MysqlService> {
        self.independent_mysql_with_capacity(1).await
    }

    async fn independent_mysql_with_capacity(
        &self,
        capacity: u32,
    ) -> anyhow::Result<brz_mysql::MysqlService> {
        #[derive(FromMysqlRow)]
        struct Database {
            name: String,
        }
        let database: Database = self
            .mysql
            .fetch_one("SELECT DATABASE() AS name", ())
            .await?;
        let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")?;
        Ok(brz_mysql::MysqlService::connect_lazy_with_options(
            &format!("mysql://root@{address}/{}?ssl-mode=disabled", database.name),
            crate::startup::mysql::pool_options().with_max_connections(capacity),
        )?)
    }

    async fn post(&self, user: i64, path: &str, body: Value) -> anyhow::Result<brz_http::Response> {
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &json!({"sub":format!("local-sync-{user}"),"exp":chrono::Utc::now().timestamp()+300}),
            &jsonwebtoken::EncodingKey::from_secret(b"local-sync-contract-test"),
        )?;
        Ok(http_client()
            .post(format!("http://{}{path}", self.address))?
            .bearer_auth(token)
            .json(&body)
            .send()
            .await?)
    }

    async fn plan(&self) -> anyhow::Result<Value> {
        let response = self.post(81001,"/api/plugins/local-sync",json!({"protocolVersion":1,"instanceId":"native","targeted":true,"installedPluginId":self.id})).await?;
        assert_eq!(response.status().as_u16(), 200);
        Ok(response.json().await?)
    }

    fn receipt(&self, plan: &Value, status: &str) -> Value {
        json!({"protocolVersion":1,"instanceId":"native","completion":{
            "deviceId":self.device,"generation":plan["generation"],"installedRevisions":plan["installedRevisions"],
            "result":{"success":true,"plugin_sync":plan["payload"]["plugin_sync"],"plugins":[{"id":self.id,"status":status}]}
        }})
    }

    async fn complete(&self, plan: &Value, status: &str, user: i64) -> anyhow::Result<Value> {
        let response = self
            .post(
                user,
                "/api/plugins/local-sync/complete",
                self.receipt(plan, status),
            )
            .await?;
        assert_eq!(response.status().as_u16(), 200);
        Ok(response.json().await?)
    }

    async fn set_intent(&self, revision: i64, active: bool) -> anyhow::Result<()> {
        self.mysql.execute("UPDATE kinds SET is_active=?,json=JSON_SET(json,'$.spec.revision',?,'$.spec.installState',?) WHERE id=?",
            (active,revision,if active {"installed"} else {"uninstalled"},self.id)).await?;
        Ok(())
    }

    async fn seed_removal(&self) -> anyhow::Result<()> {
        self.mysql.execute("INSERT INTO plugin_device_installations (user_id,installed_kind_id,device_id,state,last_sync_at,updated_at) VALUES (81001,?,?,'uninstalling',NOW(),NOW()) ON DUPLICATE KEY UPDATE state='uninstalling'",(self.id,self.device.as_str())).await?;
        Ok(())
    }

    async fn state(&self) -> anyhow::Result<Option<String>> {
        #[derive(FromMysqlRow)]
        struct Row {
            state: String,
        }
        let row: Option<Row> = self.mysql.fetch_optional("SELECT state FROM plugin_device_installations WHERE user_id=81001 AND installed_kind_id=? AND device_id=?",(self.id,self.device.as_str())).await?;
        Ok(row.map(|row| row.state))
    }

    async fn write_revision(&self) -> anyhow::Result<Value> {
        let row: StoredKind = self.mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81001 AND kind='InstalledPlugin' AND namespace='default' AND id=?",(self.id,)).await?;
        Ok(row.json["spec"]["writeRevision"].clone())
    }
}

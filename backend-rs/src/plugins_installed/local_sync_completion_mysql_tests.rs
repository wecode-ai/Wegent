//! Real completion, stale receipt and ownership checks in the existing HTTP fixture.
use super::*;

#[path = "record_sync_result_mysql_tests.rs"]
mod ack_fence_tests;

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
    Ok(())
}

struct Context<'a> {
    mysql: &'a brz_mysql::MysqlService,
    address: std::net::SocketAddr,
    id: i64,
    device: String,
}

impl Context<'_> {
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

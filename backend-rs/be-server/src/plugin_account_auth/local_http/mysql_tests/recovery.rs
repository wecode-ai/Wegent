//! Recovery and legacy-writer interoperability use the real HTTP/MySQL boundary.
use super::*;

async fn login(api: &Api, token: &str, id: i64, slug: &str) {
    api.call(
        token,
        "plugin.auth.local_lifecycle",
        json!({
            "installed_plugin_id":id,"connector_slug":slug,"action":"login"
        }),
        200,
    )
    .await;
}

pub(super) async fn verify_refresh_relogin(
    api: &Api,
    token: &str,
    mysql: &brz_mysql::MysqlService,
) -> anyhow::Result<()> {
    for (uncertain, same_source) in [(false, false), (true, false), (true, true)] {
        let slug = if same_source {
            "same-source-relogin"
        } else if uncertain {
            "uncertain-relogin"
        } else {
            "abandoned-relogin"
        };
        let id = seed(mysql, slug, json!({"protocolVersion":1,"credentialType":"oauth2","adapter":"auth.py","oauth2":["refresh"]})).await?;
        let fresh = json!({"access_token":"fresh-login","refresh_token":"new-login-refresh","expires_at":chrono::Utc::now().timestamp()+600});
        let connection = enroll(
            api,
            token,
            id,
            slug,
            if same_source {
                fresh.clone()
            } else {
                json!({"access_token":"expired","refresh_token":"possibly-consumed","expires_at":1})
            },
        )
        .await;
        if same_source {
            // Keep the source observation, while the central token has expired.
            // Explicit login with that source must still clear an uncertain lease.
            #[derive(brz_mysql::FromMysqlRow)]
            struct Document {
                json: Value,
            }
            let row: Document = mysql.fetch_one("SELECT json FROM kinds WHERE user_id=? AND kind='ConnectorConnection' AND namespace='plugin-auth' AND name=?", (OWNER,connection["id"].as_str().unwrap())).await?;
            let mut document = row.json;
            document["spec"]["credential"] = credentials::encrypt(&json!({"access_token":"expired-central","refresh_token":"possibly-consumed","expires_at":1}).to_string(), &credentials::context(OWNER, &document["spec"]))?;
            mysql.execute("UPDATE kinds SET json=? WHERE user_id=? AND kind='ConnectorConnection' AND namespace='plugin-auth' AND name=?", (document,OWNER,connection["id"].as_str().unwrap())).await?;
        }
        let execution =
            json!({"installed_plugin_id":id,"connector_slug":slug,"account_id":"account"});
        let lease = api
            .call(token, "plugin.auth.oauth.begin", execution.clone(), 200)
            .await;
        let automatic = intent(api, token, id, slug).await;
        let enrollment = |migration: &str| json!({"migration_id":migration,"account_id":"account","credential":fresh.to_string()});
        let denied = api
            .call(token, "plugin.auth.enroll", enrollment(&automatic), 409)
            .await;
        assert_eq!(denied["detail"], "plugin_auth_refresh_in_progress");
        if uncertain {
            api.call(token, "plugin.auth.oauth.finish", json!({"connection_id":lease["connection_id"],"operation_id":lease["operation_id"],"succeeded":false,"attempted":true}), 200).await;
            let denied = api
                .call(token, "plugin.auth.enroll", enrollment(&automatic), 409)
                .await;
            assert_eq!(denied["detail"], "plugin_auth_reconnect_required");
        } else {
            // Even explicit login cannot replace a live refresh lease.
            login(api, token, id, slug).await;
            let pending = intent(api, token, id, slug).await;
            let denied = api
                .call(token, "plugin.auth.enroll", enrollment(&pending), 409)
                .await;
            assert_eq!(denied["detail"], "plugin_auth_refresh_in_progress");
            // Advance only this fixture's lease, without waiting or retrying it.
            mysql.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.oauthRefresh.expiresAt',1) WHERE user_id=? AND kind='ConnectorConnection' AND namespace='plugin-auth' AND name=?",(OWNER,connection["id"].as_str().unwrap())).await?;
        }
        let denied = api
            .call(token, "plugin.auth.oauth.begin", execution.clone(), 409)
            .await;
        assert_eq!(denied["detail"], "plugin_auth_reconnect_required");
        login(api, token, id, slug).await;
        let pending = intent(api, token, id, slug).await;
        api.call(token, "plugin.auth.enroll", enrollment(&pending), 200)
            .await;
        // A delayed success from the abandoned owner cannot overwrite login.
        let late = api.call(token, "plugin.auth.oauth.finish", json!({"connection_id":lease["connection_id"],"operation_id":lease["operation_id"],"succeeded":true,"account_id":"account","credential":json!({"access_token":"late-refresh","refresh_token":"late-refresh-token","expires_at":chrono::Utc::now().timestamp()+600}).to_string()}), 409).await;
        assert_eq!(late["detail"], "plugin_auth_operation_mismatch");
        let current = api
            .call(token, "plugin.auth.execute", execution.clone(), 200)
            .await;
        assert_eq!(
            serde_json::from_str::<Value>(current["credential"].as_str().unwrap())?["access_token"],
            "fresh-login"
        );
        assert_eq!(
            api.call(token, "plugin.auth.oauth.begin", execution, 200)
                .await["state"],
            "ready"
        );
    }
    Ok(())
}

async fn legacy_policy_write(
    app: &crate::state::AppState,
    source: &str,
    slug: &str,
    login: bool,
) -> anyhow::Result<()> {
    let lease = crate::plugins_installed::write_coordination::PluginWriteLease::acquire(
        app.redis.as_ref(),
        OWNER,
    )
    .await?;
    let binding = crate::plugin_account_auth::route::DeviceBinding {
        logical_device_id: "legacy-device".into(),
        document: json!({"deviceRowId":7,"runtimeDeviceId":"legacy-device","runtimeInstanceId":"legacy-instance"}),
    };
    let result = app
        .mysql
        .with_transaction(async |tx| {
            crate::plugin_account_auth::local_lifecycle::set_policy(
                tx,
                &lease,
                OWNER,
                source,
                slug,
                login.then_some(&binding),
            )
            .await
            .map_err(super::super::credentials::failure)
        })
        .await;
    lease.release().await;
    result?;
    Ok(())
}

pub(super) async fn verify_interleaved_logins(
    api: &Api,
    token: &str,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    let slug = "interleaved-login";
    let id = seed(
        &app.mysql,
        slug,
        json!({"protocolVersion":1,"credentialType":"bearer","adapter":"auth.py"}),
    )
    .await?;
    #[derive(brz_mysql::FromMysqlRow)]
    struct Document {
        json: Value,
    }
    let row: Document = app.mysql.fetch_one("SELECT json FROM kinds WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default' AND id=?",(OWNER,id)).await?;
    let source = credentials::source(&row.json["spec"]);
    login(api, token, id, slug).await;
    let native = intent(api, token, id, slug).await;
    legacy_policy_write(app, &source, slug, true).await?;
    let response = api.call(token, "plugin.auth.enroll", json!({"migration_id":native,"account_id":"account","credential":"{\"token\":\"interleaved\"}"}), 200).await;
    assert!(response["connection"]["id"].is_string());
    login(api, token, id, slug).await;
    let obsolete = intent(api, token, id, slug).await;
    legacy_policy_write(app, &source, slug, false).await?;
    legacy_policy_write(app, &source, slug, true).await?;
    let denied = api.call(token, "plugin.auth.enroll", json!({"migration_id":obsolete,"account_id":"account","credential":"{\"token\":\"obsolete\"}"}), 409).await;
    assert_eq!(denied["detail"], "plugin_auth_migration_expired");
    login(api, token, id, slug).await;
    enroll(api, token, id, slug, json!({"token":"new-login"})).await;
    Ok(())
}

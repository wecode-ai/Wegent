//! Cloud automatic grants must not lease already-granted plugins.

use super::*;
use brz_redis::Redis;
use wegent_plugin_runtime::plugin_account_auth::{self, SocketIdentity};
use wegent_plugin_runtime::test_support::write_coordination::PluginWriteLease;

pub(super) async fn verify(
    api: &Api,
    token: &str,
    state: &wegent_plugin_runtime::PluginState,
) -> anyhow::Result<()> {
    let mysql = &state.mysql;
    mysql.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.enabled',true,'$.spec.revision',CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.revision')),'0') AS SIGNED)+1) WHERE user_id=? AND kind='ConnectorAuthPolicy' AND namespace='plugin-auth' AND name='account'",(OWNER,)).await?;
    let mut ids = Vec::new();
    for name in ["grant-scope-a", "grant-scope-b"] {
        let id = seed(
            mysql,
            name,
            json!({"protocolVersion":1,"credentialType":"bearer","adapter":"auth.py"}),
        )
        .await?;
        enroll(api, token, id, name, json!({"token":"grant-fixture"})).await;
        ids.push(id);
    }
    mysql.execute("INSERT INTO kinds(user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (?,'Device','default','grant-cloud',?,1,NOW(),NOW())",(OWNER,json!({"spec":{"deviceType":"cloud","deviceId":"grant-runtime","runtimeInstanceId":"grant-instance"}}))).await?;
    #[derive(brz_mysql::FromMysqlRow)]
    struct Id {
        id: i64,
    }
    let device=mysql.fetch_one::<_,_,Id>("SELECT id FROM kinds WHERE user_id=? AND kind='Device' AND namespace='default' AND name='grant-cloud'",(OWNER,)).await?.id;
    let binding = json!({"deviceRowId":device,"runtimeDeviceId":"grant-runtime","runtimeInstanceId":"grant-instance"});
    mysql.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.deviceGrants.\"grant-cloud\"',CAST(? AS JSON)) WHERE user_id=? AND kind='ConnectorConnection' AND namespace='plugin-auth'",(binding.clone(),OWNER)).await?;
    let redis = state.redis.as_ref().expect("real Redis fixture");
    let online_key = crate::devices::online_key(OWNER, "grant-runtime");
    redis
        .set(
            online_key.as_str(),
            json!({"socket_id":"grant-socket","runtime_instance_id":"grant-instance"}).to_string(),
        )
        .await?;
    let session = SocketIdentity {
        user_id: OWNER,
        device_id: Some("grant-runtime"),
        runtime_instance_id: Some("grant-instance"),
    };
    let held =
        PluginWriteLease::acquire_names(state.redis.as_ref(), OWNER, vec!["grant-scope-b".into()])
            .await?;
    for (pending, inventory) in [(false, Vec::new()), (true, Vec::new()), (true, ids.clone())] {
        if pending {
            mysql.execute("UPDATE kinds SET json=JSON_REMOVE(json,'$.spec.deviceGrants.\"grant-cloud\"') WHERE user_id=? AND kind='ConnectorConnection' AND namespace='plugin-auth' AND JSON_EXTRACT(json,'$.spec.installedPluginId')=?",(OWNER,ids[0])).await?;
        }
        let result = plugin_account_auth::exchange(
            &state.mysql,
            state.redis.as_ref(),
            session,
            "grant-socket",
            plugin_account_auth::AUTOMATIC,
            &json!({"installed_plugin_ids":inventory}),
        )
        .await;
        assert_eq!(
            result["success"], true,
            "unrelated held plugin blocked cloud grants: {result}"
        );
        assert_eq!(result["migrations"], json!([]));
        #[derive(brz_mysql::FromMysqlRow)]
        struct Document {
            json: Value,
        }
        let row=mysql.fetch_one::<_,_,Document>("SELECT json FROM kinds WHERE user_id=? AND kind='ConnectorConnection' AND namespace='plugin-auth' AND JSON_EXTRACT(json,'$.spec.installedPluginId')=?",(OWNER,ids[0])).await?;
        assert_eq!(row.json["spec"]["deviceGrants"]["grant-cloud"], binding);
    }
    held.release().await;
    redis.del(online_key.as_str()).await?;
    mysql
        .execute(
            "DELETE FROM kinds WHERE id=? AND user_id=? AND kind='Device' AND namespace='default'",
            (device, OWNER),
        )
        .await?;
    Ok(())
}

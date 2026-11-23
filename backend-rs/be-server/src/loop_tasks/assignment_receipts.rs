use crate::state::AppState;
use serde_json::{Value, json};

#[cfg(test)]
pub(super) use wegent_project_participation::assignment_receipts::persist_dispatch_receipt;
pub(super) use wegent_project_participation::assignment_receipts::project_delivery;

pub(super) async fn project_device_wait(state: &AppState, receipt: &mut Value) {
    if receipt["state"] != "queued" || !receipt["runtimeTaskId"].is_null() {
        return;
    }
    let Some(owner) = receipt["ownerUserId"].as_i64() else {
        return;
    };
    let devices:Result<Vec<crate::device_identity::DeviceKindRow>,_> = state.mysql.fetch_all(
        "SELECT id AS kinds_id,name AS kinds_name,json AS kinds_json FROM kinds WHERE kind='Device' AND namespace='default' AND user_id=? AND is_active=1",(owner,),
    ).await;
    let Ok(devices) = devices else {
        receipt["reasonCode"] = json!("presence_unavailable");
        return;
    };
    for device in devices {
        let route = crate::device_identity::device_connection_route_id(&device);
        match crate::device_online_state::read_online_state::<Value>(
            state.redis.as_ref(),
            owner,
            &route,
        )
        .await
        {
            Ok(Some(_)) => return,
            Ok(None) => {}
            Err(_) => {
                receipt["reasonCode"] = json!("presence_unavailable");
                return;
            }
        }
    }
    receipt["state"] = json!("waiting_device");
    receipt["reasonCode"] = json!("device_offline");
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    #[ignore = "requires disposable loopback MySQL; invoked by Backend Rust CI"]
    async fn public_results_require_confirmation_and_exact_assignment_source() -> anyhow::Result<()>
    {
        crate::migrations::mysql_tests::isolated(async |mysql| {
            crate::migrations::mysql_tests::seed_collaboration(mysql).await?;
            wegent_project_participation::test_support::public_results_require_confirmation_and_exact_assignment_source(mysql).await
        })
        .await
    }

    #[tokio::test]
    #[ignore = "requires disposable loopback MySQL; invoked by Backend Rust CI"]
    async fn only_delivered_results_of_the_current_assignment_settle_receipts() -> anyhow::Result<()>
    {
        crate::migrations::mysql_tests::isolated(async |mysql| {
            crate::migrations::mysql_tests::seed_collaboration(mysql).await?;
            wegent_project_participation::test_support::only_delivered_results_of_the_current_assignment_settle_receipts(mysql).await
        })
        .await
    }
}

//! Deliver durable source changes through the existing owned Runtime route.
use super::{BackgroundJobRegistry, JobContext, project::runtime_rpc, with_lock_watchdog};
use crate::{
    AppState,
    runtime_observations::{active_accounts, command},
};
use anyhow::{Context, Result};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const JOB: &str = "runtime_observation_deliveries";
mod collectors;

pub(super) fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    collectors::register(registry, state.clone())?;
    registry.register(JOB, move |context, _| {
        let state = state.clone();
        async move {
            Ok(with_lock_watchdog(
                &state.background_jobs,
                &context,
                "wegent:lock:runtime_observation_deliveries",
                Duration::from_secs(30),
                check(&state, &context),
            )
            .await?
            .unwrap_or_else(|| json!({"skipped":"lock_busy"})))
        }
    })?;
    registry.max_failures(JOB, 1)?;
    registry.timeout(JOB, None)?;
    registry.startup(JOB, Duration::ZERO)?;
    registry.interval(JOB, Duration::from_secs(15), false)
}

async fn check(state: &AppState, context: &JobContext) -> Result<Value> {
    let owners = active_accounts(&state.mysql).await?;
    let mut work = stream::iter(owners)
        .map(|owner| async move {
            if context.cancellation.is_cancelled() {
                return false;
            }
            match check_account(state, owner).await {
                Ok(accepted) => accepted,
                Err(_) => {
                    // Connector facts, credentials and Runtime errors are not safe diagnostics.
                    tracing::warn!(owner, "Runtime observation delivery deferred");
                    false
                }
            }
        })
        .buffer_unordered(8);
    let mut accepted = 0;
    while let Some(result) = work.next().await {
        if context.cancellation.is_cancelled() {
            anyhow::bail!("observation delivery cancelled");
        }
        accepted += usize::from(result);
    }
    Ok(json!({"accepted":accepted}))
}

async fn check_account(state: &AppState, owner: i64) -> Result<bool> {
    let claimed = command(&state.mysql, owner, &json!({"action":"claim_delivery"})).await?;
    let snapshot = command(&state.mysql, owner, &json!({"action":"list"})).await?;
    let delivery = async {
        if claimed["delivery"].is_object() {
            deliver(state, owner, &claimed["delivery"]).await
        } else {
            Ok(false)
        }
    };
    // An offline pending delivery must not starve cancellation projections.
    let (accepted, projected) = tokio::join!(delivery, sync_projections(state, owner, &snapshot),);
    projected?;
    accepted
}

async fn sync_projections(state: &AppState, owner: i64, snapshot: &Value) -> Result<()> {
    // Health projections do not read a provider or admit model work.
    let subscriptions = snapshot["subscriptions"]
        .as_object()
        .context("Invalid observation ledger")?;
    let targets: Vec<_> = subscriptions
        .values()
        .filter(|row| {
            row["status"] == "armed"
                || (row["status"] == "cancelled" && row["terminalSynced"] != true)
        })
        .filter_map(|row| {
            Some((
                row["intent"]["target"]["deviceId"].as_str()?.to_owned(),
                row["id"].as_str()?.to_owned(),
            ))
        })
        .collect();
    let mut updates = stream::iter(targets)
        .map(|(device, id)| async move {
            let _ = runtime_rpc::call(
                state,
                owner,
                &device,
                "runtime.connections.observations.sync",
                json!({"subscriptionId":id}),
                Duration::from_secs(10),
            )
            .await;
        })
        .buffer_unordered(2);
    while updates.next().await.is_some() {}
    Ok(())
}

fn accepted_receipt(result: &Value) -> Option<Value> {
    let operation = result["operationId"].as_str().filter(|id| !id.is_empty())?;
    (result["accepted"] == true
        && matches!(
            result["status"].as_str(),
            Some("delivered" | "resuming_goal")
        ))
    .then(|| json!({"accepted":true,"operationId":operation}))
}

async fn deliver(state: &AppState, owner: i64, delivery: &Value) -> Result<bool> {
    let device = delivery["intent"]["target"]["deviceId"]
        .as_str()
        .context("Missing delivery target")?;
    let lease = json!({"deliveryId":delivery["id"],"leaseId":delivery["lease"]["id"]});
    let signal = json!({"subscriptionId":delivery["subscriptionId"],"deliveryId":delivery["id"],"leaseId":delivery["lease"]["id"]});
    let call = runtime_rpc::call(
        state,
        owner,
        device,
        "runtime.connections.observations.sync",
        signal,
        Duration::from_secs(120),
    );
    tokio::pin!(call);
    let mut renewal = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(20),
        Duration::from_secs(20),
    );
    let result = loop {
        tokio::select! {
            result = &mut call => break result?,
            _ = renewal.tick() => {
                let mut input = lease.clone();
                input["action"] = json!("renew_delivery");
                command(&state.mysql, owner, &input).await?;
            }
        }
    };
    let Some(receipt) = accepted_receipt(&result) else {
        return Ok(false);
    };
    let mut ack = lease;
    ack["action"] = json!("ack_delivery");
    ack["receipt"] = receipt;
    command(&state.mysql, owner, &ack).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivery_ack_requires_a_durable_runtime_operation_and_acceptance() {
        for value in [
            json!(null),
            json!({"accepted":true}),
            json!({"accepted":false,"operationId":"op","status":"delivered"}),
            json!({"accepted":true,"operationId":"op","status":"pending"}),
            json!({"accepted":true,"operationId":"","status":"delivered"}),
        ] {
            assert!(accepted_receipt(&value).is_none());
        }
        for status in ["delivered", "resuming_goal"] {
            assert_eq!(
                accepted_receipt(
                    &json!({"accepted":true,"operationId":"op","status":status,"private":"not stored"})
                ),
                Some(json!({"accepted":true,"operationId":"op"}))
            );
        }
    }
}

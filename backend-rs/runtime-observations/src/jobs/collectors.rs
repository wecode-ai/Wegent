//! Collectors have their own pump so slow providers never hold up event delivery.
use super::*;
use crate::ledger::{collector::Collector, collector_token};
use wegent_socket_events::socketio_rpc::RpcError;

const COLLECTORS: &str = "runtime_observation_collectors";

pub(super) fn register(
    registry: &mut BackgroundJobRegistry,
    state: Arc<ObservationJobState>,
) -> Result<()> {
    registry.register(COLLECTORS, move |context, _| {
        let state = state.clone();
        async move {
            Ok(with_lock_watchdog(
                &state.background_jobs,
                &context,
                "wegent:lock:runtime_observation_collectors",
                Duration::from_secs(30),
                collect_accounts(&state, &context),
            )
            .await?
            .unwrap_or_else(|| json!({"skipped":"lock_busy"})))
        }
    })?;
    registry.max_failures(COLLECTORS, 1)?;
    registry.timeout(COLLECTORS, None)?;
    registry.startup(COLLECTORS, Duration::ZERO)?;
    registry.interval(COLLECTORS, Duration::from_secs(15), false)
}

async fn collect_accounts(state: &ObservationJobState, context: &JobContext) -> Result<Value> {
    let owners = active_accounts(&state.observations.mysql).await?;
    let mut work = stream::iter(owners)
        .map(|owner| async move {
            if context.cancellation.is_cancelled() {
                return false;
            }
            match collect_account(state, owner).await {
                Ok(collected) => collected,
                Err(_) => {
                    tracing::warn!(
                        owner,
                        code = "observation_collection_deferred",
                        "Runtime observation collection deferred"
                    );
                    false
                }
            }
        })
        .buffer_unordered(8);
    let mut collected = 0;
    while let Some(result) = work.next().await {
        if context.cancellation.is_cancelled() {
            anyhow::bail!("observation collection cancelled");
        }
        collected += usize::from(result);
    }
    Ok(json!({"collected":collected}))
}

pub async fn collect_account(state: &ObservationJobState, owner: i64) -> Result<bool> {
    let mysql = &state.observations.mysql;
    let claim = command(mysql, owner, &json!({"action":"claim"})).await?;
    if claim["lease"].is_null() {
        return Ok(false);
    }
    match collect_source(state, owner, &claim).await {
        Ok(result) if result["accepted"] == true => Ok(result["collected"] != false),
        _ => {
            // The RPC may have committed before its acknowledgement was lost.
            // A failed lease fence must not overwrite that successful commit.
            let _ = command(mysql, owner, &json!({"action":"fail","observationId":claim["observation"]["id"],"leaseId":claim["lease"]["id"],"errorCode":"connection_host_unavailable","retryAfterMs":30_000})).await;
            Ok(false)
        }
    }
}

async fn collect_source(state: &ObservationJobState, owner: i64, claim: &Value) -> Result<Value> {
    let collector = Collector::parse(&claim["observation"]["collector"])
        .map_err(|_| anyhow::anyhow!("Invalid source collector route"))?;
    let token = collector_token(&state.observations, owner, claim)
        .map_err(|_| anyhow::anyhow!("Observation lease credential unavailable"))?;
    match collector {
        Collector::Device { device_id: device } => {
            let started = std::time::Instant::now();
            tracing::info!("Runtime observation collector RPC started");
            let result = state
                .runtime_rpc
                .call(
                    owner,
                    &device,
                    "runtime.connections.observations.collect",
                    json!({"collectorToken":token,"expectedOwnerId":owner}),
                    Duration::from_secs(420),
                )
                .await;
            let outcome = match &result {
                Ok(_) => "acknowledged",
                Err(error) => match error.downcast_ref::<RpcError>() {
                    Some(RpcError::Closed) => "closed",
                    Some(RpcError::Timeout) => "timeout",
                    _ => "unavailable",
                },
            };
            tracing::info!(
                outcome,
                elapsed_ms = started.elapsed().as_millis(),
                "Runtime observation collector RPC finished"
            );
            result
        }
    }
}

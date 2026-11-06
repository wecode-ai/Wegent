//! Queue hints contain no work; Executor clients retain claims and capacity.

use anyhow::{Context, Result};
use brz_mysql::{FromMysqlRow, Json};
use brz_redis::Redis;
use serde_json::{Value, json};
use std::{collections::BTreeSet, time::Duration};

use super::super::project::{
    routing, runtime_rpc,
    store::{self, Node},
};
use super::{
    authority,
    model::{COLUMNS, Execution},
};
use crate::{
    AppState,
    device_identity::{DeviceKindRow, identity_from_device},
};

#[derive(FromMysqlRow)]
struct Device {
    id: i64,
    user_id: i64,
    name: String,
    json: Json<Value>,
}

pub(super) async fn notify(app: &AppState) -> Result<usize> {
    let rows: Vec<Execution> = app
        .mysql
        .fetch_all(
            format!("SELECT {COLUMNS} FROM loop_item_executions WHERE status='queued'"),
            (),
        )
        .await?;
    let devices:Vec<Device>=app.mysql.fetch_all("SELECT id,user_id,name,json FROM kinds WHERE kind='Device' AND namespace='default' AND is_active=true",()).await?;
    let mut targets = BTreeSet::new();
    for row in rows {
        if !matches!(row.execution_environment.as_str(), "local" | "cloud") {
            continue;
        }
        if !row.execution_device_id.is_empty() {
            if row.executor_owner_user_id != 0 {
                targets.insert((row.executor_owner_user_id, row.execution_device_id.clone()));
            }
            continue;
        }
        if row.assignment_pending() && !row.routed() {
            continue;
        }
        let allowed = if row.routed() {
            if !authority::authorized(app, &row).await? {
                continue;
            }
            match routed_candidates(app, &row).await {
                Ok(ids) => ids,
                Err(error) if authority::infrastructure(&error) => {
                    return Err(error);
                }
                Err(_) => continue,
            }
        } else {
            routing::allowed_devices(app, &row.cloud_project_id, &row.agent_id).await?
        };
        for device in &devices {
            if !allowed.contains(&device.id)
                || (!row.routed() && device.user_id != row.executor_owner_user_id)
            {
                continue;
            }
            let kind = DeviceKindRow {
                id: device.id,
                name: device.name.clone(),
                json: device.json.0.clone(),
            };
            if let Some(identity) = identity_from_device(&kind) {
                targets.insert((device.user_id, identity.runtime_device_id));
            }
        }
    }
    // Cancelled cleanup intents also wake their Executor to clear local intent.
    let cleanup:Vec<Node>=app.mysql.fetch_all(format!("SELECT {} FROM loop_items WHERE resource_type='workspace_cleanup' AND (status='cancelled' OR (status IN ('pending','executing') AND due_at IS NOT NULL AND due_at<=UTC_TIMESTAMP(6)))",store::COLUMNS),()).await?;
    for intent in cleanup {
        let target = intent.metadata.0["execution_target_id"]
            .as_str()
            .filter(|value| !value.is_empty())
            .unwrap_or(&intent.device_id);
        if intent.task_user_id != 0 && !target.is_empty() {
            targets.insert((intent.task_user_id, target.to_owned()));
        }
    }
    let count = targets.len();
    let redis = app
        .redis
        .as_ref()
        .context("Robot queue notification requires Redis")?;
    for (owner, device) in targets {
        let message = crate::socketio_emit::emit_message(
            "runtime.tasks.available",
            "[{}]",
            "/local-executor",
            &format!("execution-target:{owner}:{device}"),
        );
        redis
            .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
            .await?;
    }
    Ok(count)
}

async fn routed_candidates(app: &AppState, row: &Execution) -> Result<BTreeSet<i64>> {
    let selection = row.selection();
    let mut routes = vec![(row.agent_id.as_str(), &selection["runner_routing"])];
    if let Some(group) = selection["group_runner_requirements"].as_object() {
        routes.extend(group.iter().map(|(agent, route)| (agent.as_str(), route)));
    }
    let mut result: Option<BTreeSet<i64>> = None;
    for (agent, route) in routes {
        if route["model"]["source"] == "cloud" {
            routing::require_cloud_model(app, row.assigner_user_id, &route["model"]).await?;
        }
        let ids =
            routing::candidates_for_snapshot(app, &row.cloud_project_id, agent, route).await?;
        result = Some(match result {
            None => ids,
            Some(current) => current.intersection(&ids).copied().collect(),
        });
    }
    let mut result = result.unwrap_or_default();
    let issue = store::get(&app.mysql, "task", &row.loop_item_id)
        .await?
        .context("Issue unavailable")?;
    if let Some(binding) = routing::issue_binding(app, &issue).await? {
        result.retain(|id| id.to_string() == binding);
    }
    Ok(result)
}

pub(super) async fn cancels(app: &AppState, rows: &[Execution]) {
    for row in rows {
        let target = if row.execution_device_id.is_empty() {
            &row.runtime_device_id
        } else {
            &row.execution_device_id
        };
        if row.runtime_task_id.is_empty() || target.is_empty() || row.executor_owner_user_id == 0 {
            continue;
        }
        let result = runtime_rpc::call(
            app,
            row.executor_owner_user_id,
            target,
            "runtime.tasks.cancel",
            json!({"taskId":row.runtime_task_id,"deviceId":row.runtime_device_id}),
            Duration::from_secs(15),
        )
        .await;
        match result {
            Ok(value) if value["accepted"] == true || value["success"] == true => {
                // An ACK accepts the request; it is not proof the process ended.
                tracing::info!(
                    execution_id = row.id,
                    "Robot cancellation request accepted by Runtime"
                );
            }
            Ok(_) => tracing::warn!(
                execution_id = row.id,
                "Robot cancellation request was not accepted"
            ),
            Err(_) => tracing::warn!(
                execution_id = row.id,
                "Robot cancellation transport failed; durable intent retained"
            ),
        }
    }
}

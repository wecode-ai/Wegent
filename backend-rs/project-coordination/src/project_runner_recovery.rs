//! Explicit recovery of rejected assignments, without moving live work.

use crate::{
    project_authority as authority,
    project_execution::{COLUMNS, Execution},
    project_store::{self as store, Node},
};
use anyhow::{Context, Result, bail};
use brz_mysql::FromMysqlRow;
use std::collections::BTreeSet;
use wegent_backend_persistence::mysql_query::MysqlQuery;

pub fn original_session(execution: &Execution) -> bool {
    !execution.runtime_device_id.is_empty()
        && execution.intent()["runtime_request"]["newSession"] == false
}

pub async fn session_matches_on(
    query: &mut impl MysqlQuery,
    execution: &Execution,
    device_id: i64,
) -> Result<bool> {
    if !original_session(execution) {
        return Ok(true);
    }
    let source = wegent_device_identity::resolve_owned_device_alias_on(
        query,
        execution.executor_owner_user_id,
        &execution.runtime_device_id,
    )
    .await?;
    Ok(source.is_some_and(|device| device.id == device_id))
}

pub async fn available_on(query: &mut impl MysqlQuery, issue: &str, exclude: i64) -> Result<bool> {
    let rows: Vec<Execution> = query.fetch_all(
        format!("SELECT {COLUMNS} FROM loop_item_executions WHERE loop_item_id=? AND id<>? AND status IN ('queued','pending_approval','claimed','running','cancel_requested') FOR UPDATE"),
        (issue, exclude),
    ).await?;
    Ok(rows.iter().all(Execution::assignment_pending))
}

pub async fn revalidate_on(
    query: &mut impl MysqlQuery,
    issue: &Node,
    selection: &serde_json::Value,
    exclude: i64,
) -> Result<bool> {
    let route = &selection["runner_routing"];
    let Some(expected) = route["recovery_from_environment_id"].as_str() else {
        return Ok(true);
    };
    let locked: Option<Node> = query.fetch_optional(
        format!("SELECT {} FROM loop_items WHERE id=? AND cloud_project_id=? AND resource_type='task' AND {} FOR UPDATE", store::COLUMNS, store::LIVE),
        (issue.id.as_str(), issue.cloud_project_id.as_str()),
    ).await?;
    let Some(locked) = locked else {
        return Ok(false);
    };
    let binding = issue_binding_on(query, &locked).await?;
    if route["execution_policy"]["mode"] == "fixed"
        && binding
            .as_deref()
            .is_some_and(|bound| route["execution_policy"]["environment_id"] == bound)
    {
        return Ok(true);
    }
    if binding.as_deref() != Some(expected) {
        return Ok(false);
    }
    available_on(query, &issue.id, exclude).await
}

pub async fn permits_on(
    query: &mut impl MysqlQuery,
    execution: &Execution,
    bound: &str,
) -> Result<bool> {
    let context = execution.context();
    // Manual group dispatches also have internal run IDs.
    let manual_group = context["dispatch_kind"] == "collaboration_group"
        && context["assignment_key"].as_str().is_some_and(|key| {
            !key.is_empty()
                && execution.automation_run_id == format!("collaboration-group:{key}")
                && context["run_id"] == format!("collaboration-group:{key}")
        });
    if execution.automatic() && !manual_group
        || execution.selection()["runner_routing"]["recovery_from_environment_id"] != bound
    {
        return Ok(false);
    }
    available_on(query, &execution.loop_item_id, execution.id).await
}

pub async fn issue_binding_on(query: &mut impl MysqlQuery, issue: &Node) -> Result<Option<String>> {
    let metadata = &issue.metadata.0;
    if authority::truthy(&metadata["runner_binding_conflict"]) {
        bail!(
            "ISSUE_RUNNER_CONFIGURATION_REQUIRED: Historical executions used conflicting or unavailable runners; review the Issue binding"
        )
    }
    if !metadata["runner_binding"].is_null() {
        let id = authority::integer(&metadata["runner_binding"]["environment_id"])
            .filter(|v| *v > 0)
            .context("ISSUE_RUNNER_CONFIGURATION_REQUIRED: Invalid Issue runner binding")?;
        return Ok(Some(id.to_string()));
    }
    #[derive(FromMysqlRow)]
    struct History {
        owner_id: i64,
        alias: String,
    }
    let history:Vec<History>=query.fetch_all("SELECT DISTINCT executor_owner_user_id AS owner_id,runtime_device_id AS alias FROM loop_item_executions WHERE loop_item_id=? AND runtime_device_id<>'' UNION SELECT DISTINCT task_user_id AS owner_id,device_id AS alias FROM loop_items WHERE resource_type='execution' AND loop_item_id=? AND device_id IS NOT NULL AND device_id<>''",(issue.id.as_str(),issue.id.as_str())).await?;
    let mut ids = BTreeSet::new();
    for value in history {
        let id = wegent_device_identity::resolve_owned_device_alias_on(
            query,
            value.owner_id,
            &value.alias,
        )
        .await?
        .map(|device| device.id.to_string())
        .unwrap_or_else(|| format!("unresolved:{}:{}", value.owner_id, value.alias));
        ids.insert(id);
    }
    if ids.is_empty() {
        return Ok(None);
    }
    if ids.len() == 1 && !ids.first().unwrap().starts_with("unresolved:") {
        return Ok(ids.pop_first());
    }
    bail!(
        "ISSUE_RUNNER_CONFIGURATION_REQUIRED: Historical executions used conflicting or unavailable runners; review the Issue binding"
    )
}

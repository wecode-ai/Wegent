//! Bind project-local native agents while preserving existing Wegent Team IDs.
use super::rows::{insert, object, select, update};
use brz_mysql::{MysqlError, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Default)]
struct Report {
    created: usize,
    reused: usize,
    invalid_references: usize,
    detached: usize,
    unavailable: usize,
}

fn conflict(agent: &Value) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: format!(
            "Project Agent {} has conflicting execution resource ownership or binding",
            agent["id"]
        ),
    }
}

fn specs(metadata: &Value, reference: &Value, shell: &str) -> [(&'static str, Value); 4] {
    let skills: Vec<_> = metadata["additional_skills"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|skill| skill["name"].as_str())
        .filter(|name| !name.is_empty())
        .collect();
    let ghost = json!({"systemPrompt": metadata.get("system_prompt").cloned().unwrap_or(json!("")),
        "plugins": metadata.get("plugins").cloned().unwrap_or(json!([])),
        "mcpServers": metadata.get("mcp_servers").cloned().unwrap_or(json!({})), "skills": skills});
    let mut bot = json!({"ghostRef": reference, "shellRef": reference});
    for key in ["execution_policy", "model_policy", "capability_mode"] {
        if !metadata[key].is_null() {
            bot[key] = metadata[key].clone();
        }
    }
    [
        ("Ghost", ghost),
        ("Shell", json!({"shellType": shell})),
        ("Bot", bot),
        (
            "Team",
            json!({"members":[{"botRef": reference}], "collaborationModel":"solo"}),
        ),
    ]
}

async fn report_catalog_team(
    tx: &mut impl MysqlTransaction,
    team_id: &Value,
    report: &mut Report,
) -> MysqlResult<()> {
    let valid = if let Some(id) = team_id.as_i64().filter(|v| *v > 0) {
        let (count,): (i64,) = tx
            .fetch_one(
                "SELECT COUNT(*) FROM kinds WHERE id=? AND kind='Team' AND is_active=1",
                (id,),
            )
            .await?;
        count == 1
    } else {
        false
    };
    if valid {
        report.reused += 1;
    } else {
        report.invalid_references += 1;
    }
    Ok(())
}

async fn owned_definitions(
    tx: &mut impl MysqlTransaction,
    agent: &Value,
    owner: i64,
    namespace: &str,
    name: &str,
) -> MysqlResult<BTreeMap<String, Value>> {
    let rows = select(
        tx, "kinds", &["kind", "id", "json"],
        "user_id=? AND namespace=? AND name=? AND kind IN ('Team','Ghost','Shell','Bot') FOR UPDATE",
        (owner, namespace, name),
    ).await?;
    let mut existing = BTreeMap::new();
    for row in rows {
        let kind = row["kind"].as_str().unwrap().to_owned();
        if row["json"]["metadata"]["migrationSource"] != agent["id"]
            || existing.insert(kind, row["id"].clone()).is_some()
        {
            return Err(conflict(agent));
        }
    }
    if let Some(previous) = agent["metadata"].get("teamRef")
        && existing.get("Team") != Some(previous)
    {
        return Err(conflict(agent));
    }
    Ok(existing)
}

async fn migrate_agent(
    tx: &mut impl MysqlTransaction,
    agent: &Value,
    down: bool,
    report: &mut Report,
) -> MysqlResult<()> {
    let mut metadata = object(&agent["metadata"])?;
    if !metadata["wegent_team_id"].is_null() {
        report_catalog_team(tx, &metadata["wegent_team_id"], report).await?;
        return Ok(());
    }
    let shell = match metadata["runtime"].as_str() {
        Some("codex") => "Codex",
        Some("claude_code") => "ClaudeCode",
        _ => {
            report.unavailable += 1;
            return Ok(());
        }
    };
    let Some(owner) = agent["created_by_user_id"].as_i64().filter(|v| *v > 0) else {
        report.unavailable += 1;
        return Ok(());
    };
    let Some(project) = agent["cloud_project_id"].as_str().filter(|v| !v.is_empty()) else {
        report.unavailable += 1;
        return Ok(());
    };
    if down && metadata.get("teamRef").is_none() {
        return Ok(());
    }
    let namespace = format!("projects/{project}");
    let name = format!("agent-{}", agent["id"].as_str().unwrap());
    let reference = json!({"name":name,"namespace":namespace});
    let existing = owned_definitions(tx, agent, owner, &namespace, &name).await?;
    let before = metadata.clone();
    if down {
        report.detached += 1;
        metadata.as_object_mut().unwrap().remove("teamRef");
    } else {
        if existing.contains_key("Team") {
            report.reused += 1;
        } else {
            report.created += 1;
        }
        for (kind, spec) in specs(&metadata, &reference, shell) {
            let id = if let Some(id) = existing.get(kind) {
                id.clone()
            } else {
                let display = agent["title"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .map_or(&agent["name"], |_| &agent["title"]);
                let definition = json!({
                    "apiVersion": "agent.wecode.io/v1", "kind": kind, "spec": spec,
                    "metadata": {
                        "name": name, "namespace": namespace,
                        "migrationSource": agent["id"], "displayName": display,
                    },
                });
                let values = json!({
                    "user_id": owner, "name": name, "namespace": namespace,
                    "kind": kind, "json": definition, "is_active": agent["status"] != "archived",
                });
                json!(insert(tx, "kinds", &values).await?)
            };
            if kind == "Team" {
                metadata["teamRef"] = id;
            }
        }
    }
    if before != metadata {
        update(
            tx,
            "loop_items",
            &agent["id"],
            &json!({"metadata": metadata}),
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn execute(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    if down {
        let pending: Option<(i64,)> = tx.fetch_optional(
            "SELECT msg.id FROM project_chat_messages msg JOIN loop_items issue ON issue.id=JSON_UNQUOTE(JSON_EXTRACT(msg.metadata,'$.issue_id'))
             WHERE msg.message_type='coordination' AND msg.status='active' AND JSON_EXTRACT(msg.metadata,'$.protocol')=2
             AND issue.resource_type='task' AND issue.cloud_project_id=JSON_UNQUOTE(JSON_EXTRACT(msg.metadata,'$.project_id'))
             AND JSON_EXTRACT(issue.metadata,'$.collaboration_group_assignment_key')=JSON_EXTRACT(msg.metadata,'$.assignment_key') LIMIT 1", ()
        ).await?;
        let running: Option<(i64,)> = tx.fetch_optional(
            "SELECT id FROM loop_item_executions WHERE status IN ('waiting_runtime','pending_approval','queued','claimed','running','cancel_requested')
             AND JSON_EXTRACT(IF(JSON_VALID(execution_payload),execution_payload,'{}'),'$.origin_context.dispatch_protocol_version')=2 LIMIT 1", ()
        ).await?;
        if pending.is_some() || running.is_some() {
            return Err(MysqlError::InvalidQuery {
                reason: "Finish active v2 Issue coordination before downgrading".into(),
            });
        }
    }
    let mut report = Report::default();
    let mut cursor = String::new();
    loop {
        let agents = select(
            tx,
            "loop_items",
            &[
                "id",
                "created_by_user_id",
                "cloud_project_id",
                "title",
                "name",
                "status",
                "metadata",
            ],
            "resource_type='chat_agent' AND id>? ORDER BY id LIMIT 100 FOR UPDATE",
            (cursor.as_str(),),
        )
        .await?;
        let Some(last) = agents.last() else {
            let (unfinished_executions,): (i64,) = tx.fetch_one(
                "SELECT COUNT(*) FROM loop_item_executions WHERE status IN ('waiting_runtime','pending_approval','queued','claimed','running','cancel_requested')", ()
            ).await?;
            tracing::info!(
                ?report,
                unfinished_executions,
                down,
                "project Agent Team migration"
            );
            return Ok(());
        };
        cursor = last["id"].as_str().unwrap().to_owned();
        for agent in &agents {
            migrate_agent(tx, agent, down, &mut report).await?;
        }
    }
}

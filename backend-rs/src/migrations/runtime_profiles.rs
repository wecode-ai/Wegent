//! e58ee381a7c2: migrate embedded robot/automation runtimes into LoopItems.

use super::rows::{insert, select, string, take, update, uuid};
use crate::json_compat::python_truthy as truthy;
use brz_mysql::{MysqlResult, MysqlTransaction};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn metadata(row: &Value) -> MysqlResult<Value> {
    super::rows::object(&row["metadata"])
}

fn profile(row: &Value, metadata: &Value, device: &Value) -> Value {
    let fallback = if row["resource_type"] == "chat_agent" {
        "Robot"
    } else {
        "Automation"
    };
    let title = [&row["title"], &row["name"]]
        .into_iter()
        .find(|v| truthy(v))
        .map(string)
        .unwrap_or(fallback.into());
    let name = format!("{title} Runtime");
    json!({"id":uuid(),"resource_type":"runtime_profile","name":name,"title":name,"description":"","created_by_user_id":row["created_by_user_id"],"updated_by_user_id":row["created_by_user_id"],"user_id":row["created_by_user_id"],"device_id":device,"status":"active","is_default":false,"source_task_snapshot":{},"metadata":{"execution_environment":metadata.get("execution_environment").filter(|v| truthy(v)).cloned().unwrap_or(json!("local")),"model":metadata["model"],"model_type":null,"model_options":{},"workspace_policy":"project","catalog_visibility":"internal","migrated_from":{"resource_type":row["resource_type"],"resource_id":row["id"]}},"version":1})
}

pub(super) async fn upgrade(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    let rows = select(
        tx,
        "loop_items",
        &[
            "id",
            "resource_type",
            "created_by_user_id",
            "cloud_project_id",
            "device_id",
            "local_project_id",
            "assignee_agent_id",
            "name",
            "title",
            "metadata",
        ],
        "resource_type IN ('chat_agent','automation_rule')",
        (),
    )
    .await?;
    let mut agents = BTreeMap::new();
    let mut automations = BTreeMap::new();
    for row in rows {
        let mut meta = metadata(&row)?;
        if row["resource_type"] == "chat_agent" {
            if truthy(&row["device_id"]) && truthy(&meta["model"]) {
                let p = profile(&row, &meta, &row["device_id"]);
                insert(tx, "loop_items", &p).await?;
                meta["default_runtime_profile_id"] = p["id"].clone();
                agents.insert(string(&row["id"]), p);
                if truthy(&row["cloud_project_id"]) && truthy(&row["local_project_id"]) {
                    let bindings = select(tx,"loop_items", &["id"], "resource_type='local_binding' AND cloud_project_id=? AND user_id=? AND device_id=? AND local_project_id=?", (row["cloud_project_id"].as_str().unwrap_or(""),row["created_by_user_id"].as_i64().unwrap_or(0),row["device_id"].as_str().unwrap_or(""),row["local_project_id"].as_i64().unwrap_or(0))).await?;
                    if bindings.is_empty() {
                        insert(tx, "loop_items", &json!({"id":uuid(),"resource_type":"local_binding","cloud_project_id":row["cloud_project_id"],"name":"Migrated robot workspace","title":"Migrated robot workspace","description":"","created_by_user_id":row["created_by_user_id"],"updated_by_user_id":row["created_by_user_id"],"user_id":row["created_by_user_id"],"device_id":row["device_id"],"local_project_id":row["local_project_id"],"status":"active","is_default":false,"source_task_snapshot":{},"metadata":{"migrated_from":{"resource_type":"chat_agent","resource_id":row["id"]}},"version":1})).await?;
                    }
                }
            }
            take(&mut meta, "model", Value::Null);
            take(&mut meta, "execution_environment", Value::Null);
            update(
                tx,
                "loop_items",
                &row["id"],
                // The workspace was transferred to its binding. Zero is not a
                // valid projects.id foreign key; detach the optional relation.
                &json!({"device_id":"","local_project_id":null,"metadata":meta}),
            )
            .await?;
            continue;
        }
        let assignment = take(&mut meta, "assignment_mode", json!("manual"));
        let manager = take(&mut meta, "manager_type", Value::Null);
        let role = take(&mut meta, "role_source", json!("agent"));
        let mut runtime = take(&mut meta, "runtime_source", Value::Null);
        let mut profile_id = take(&mut meta, "runtime_profile_id", Value::Null);
        let user = take(&mut meta, "runtime_user_id", Value::Null);
        if manager == "custom" && truthy(&meta["execution_device_id"]) && truthy(&meta["model"]) {
            let p = profile(&row, &meta, &meta["execution_device_id"]);
            insert(tx, "loop_items", &p).await?;
            runtime = json!("fixed_profile");
            profile_id = p["id"].clone();
            automations.insert(string(&row["id"]), p);
        }
        meta["action"] = json!(if assignment == "manual" {
            "execute"
        } else {
            "ai_assign"
        });
        meta["role"] = json!({"source":role,"agent_id":if truthy(&row["assignee_agent_id"]) { row["assignee_agent_id"].clone() } else { Value::Null }});
        meta["runtime"] = json!({"source":if truthy(&runtime) { runtime } else { json!("agent_default") },"runtime_profile_id":profile_id,"user_id":user});
        if truthy(&manager) {
            let team = take(&mut meta, "wegent_team_id", Value::Null);
            meta["manager"] = json!({"type":manager,"wegent_team_id":team});
        }
        for key in ["model", "execution_environment", "execution_device_id"] {
            take(&mut meta, key, Value::Null);
        }
        update(
            tx,
            "loop_items",
            &row["id"],
            &json!({"device_id":"","metadata":meta}),
        )
        .await?;
    }
    let runs = select(
        tx,
        "loop_items",
        &["id", "parent_id"],
        "resource_type='automation_run'",
        (),
    )
    .await?;
    let rules: BTreeMap<_, _> = runs
        .iter()
        .filter(|r| truthy(&r["parent_id"]))
        .map(|r| (string(&r["id"]), string(&r["parent_id"])))
        .collect();
    let executions = select(
        tx,
        "loop_item_executions",
        &[
            "id",
            "agent_id",
            "team_id",
            "automation_run_id",
            "status",
            "version",
        ],
        "status IN ('pending_approval','waiting_runtime','queued')",
        (),
    )
    .await?;
    for execution in executions {
        if truthy(&execution["team_id"]) {
            continue;
        }
        let mut source = "agent_default";
        let selected = agents.get(&string(&execution["agent_id"])).or_else(|| {
            let p = rules
                .get(&string(&execution["automation_run_id"]))
                .and_then(|id| automations.get(id));
            source = if p.is_some() {
                "fixed_profile"
            } else {
                "selected"
            };
            p
        });
        let selection = json!({"runtime_profile_id":selected.map(|p| &p["id"]),"runtime_profile_version":selected.map(|p| &p["version"]),"runtime_source":source,"workspace_policy":selected.map(|p|p["metadata"]["workspace_policy"].clone()).unwrap_or(json!("project"))});
        let mut values = json!({"execution_payload":selection.to_string(),"version":execution["version"].as_i64().filter(|v|*v!=0).unwrap_or(1)+1});
        if let Some(p) = selected {
            values["execution_environment"] = p["metadata"]["execution_environment"].clone();
            values["execution_device_id"] = if truthy(&p["device_id"]) {
                p["device_id"].clone()
            } else {
                json!("")
            };
        } else if execution["status"] != "pending_approval" {
            values["status"] = json!("waiting_runtime");
            values["execution_environment"] = json!("");
            values["execution_device_id"] = json!("");
            values["execution_note"] =
                json!("Select a device and model before this execution can start");
        }
        update(tx, "loop_item_executions", &execution["id"], &values).await?;
    }
    Ok(())
}

pub(super) async fn downgrade(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    let bindings = select(
        tx,
        "loop_items",
        &["id", "local_project_id", "metadata"],
        "resource_type='local_binding'",
        (),
    )
    .await?;
    let bindings: BTreeMap<_, _> = bindings
        .into_iter()
        .filter(|r| r["metadata"]["migrated_from"]["resource_type"] == "chat_agent")
        .map(|r| (string(&r["metadata"]["migrated_from"]["resource_id"]), r))
        .collect();
    let profiles = select(
        tx,
        "loop_items",
        &["id", "device_id", "metadata"],
        "resource_type='runtime_profile'",
        (),
    )
    .await?;
    let profiles: BTreeMap<_, _> = profiles
        .into_iter()
        .filter(|r| r["metadata"]["migrated_from"].is_object())
        .map(|r| (string(&r["id"]), r))
        .collect();
    for p in profiles.values() {
        let source = &p["metadata"]["migrated_from"];
        if !truthy(&source["resource_id"])
            || !matches!(
                source["resource_type"].as_str(),
                Some("chat_agent" | "automation_rule")
            )
        {
            continue;
        }
        let rows = select(
            tx,
            "loop_items",
            &["metadata"],
            "id=?",
            (source["resource_id"].as_str().unwrap_or(""),),
        )
        .await?;
        let Some(row) = rows.first() else {
            continue;
        };
        let mut meta = metadata(row)?;
        meta["model"] = p["metadata"]["model"].clone();
        meta["execution_environment"] = p["metadata"]["execution_environment"].clone();
        let mut values = json!({"device_id":p["device_id"]});
        if source["resource_type"] == "chat_agent" {
            take(&mut meta, "default_runtime_profile_id", Value::Null);
            values["local_project_id"] = bindings
                .get(&string(&source["resource_id"]))
                .map(|b| b["local_project_id"].clone())
                .unwrap_or(Value::Null);
        } else {
            meta["execution_device_id"] = p["device_id"].clone();
        }
        values["metadata"] = meta;
        update(tx, "loop_items", &source["resource_id"], &values).await?;
    }
    let rules = select(
        tx,
        "loop_items",
        &["id", "metadata"],
        "resource_type='automation_rule'",
        (),
    )
    .await?;
    for rule in rules {
        let mut meta = metadata(&rule)?;
        let action = take(&mut meta, "action", Value::Null);
        let role = take(&mut meta, "role", json!({}));
        let runtime = take(&mut meta, "runtime", json!({}));
        let manager = take(&mut meta, "manager", json!({}));
        meta["assignment_mode"] = json!(if action == "ai_assign" {
            "ai_managed"
        } else {
            "manual"
        });
        meta["role_source"] = role.get("source").cloned().unwrap_or(json!("agent"));
        meta["runtime_source"] = runtime
            .get("source")
            .cloned()
            .unwrap_or(json!("agent_default"));
        meta["runtime_profile_id"] = runtime["runtime_profile_id"].clone();
        meta["runtime_user_id"] = runtime["user_id"].clone();
        if truthy(&manager) {
            meta["manager_type"] = manager["type"].clone();
            meta["wegent_team_id"] = manager["wegent_team_id"].clone();
        }
        if let Some(p) = profiles.get(&string(&runtime["runtime_profile_id"])) {
            meta["model"] = p["metadata"]["model"].clone();
            meta["execution_environment"] = p["metadata"]["execution_environment"].clone();
            meta["execution_device_id"] = p["device_id"].clone();
        }
        update(tx, "loop_items", &rule["id"], &json!({"metadata":meta})).await?;
    }
    if !profiles.is_empty() {
        let executions = select(
            tx,
            "loop_item_executions",
            &["id", "execution_payload", "version"],
            "1=1",
            (),
        )
        .await?;
        for execution in executions {
            let Ok(payload) = serde_json::from_str::<Value>(
                execution["execution_payload"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("{}"),
            ) else {
                continue;
            };
            if profiles.contains_key(&string(&payload["runtime_profile_id"])) {
                update(tx,"loop_item_executions",&execution["id"],&json!({"execution_payload":"","version":execution["version"].as_i64().filter(|v|*v!=0).unwrap_or(1)+1})).await?;
            }
        }
        for row in bindings.values().chain(profiles.values()) {
            tx.execute(
                "DELETE FROM loop_items WHERE id=?",
                (row["id"].as_str().unwrap_or(""),),
            )
            .await?;
        }
    }
    Ok(())
}

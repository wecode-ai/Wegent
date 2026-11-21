//! Historical JSON and permission-data transformations.

use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

#[derive(FromMysqlRow)]
struct Kind {
    id: i64,
    payload: Option<Json<Value>>,
}

pub(super) async fn plugin_policy(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    let rows: Vec<Kind> = tx.fetch_all("SELECT id,json AS payload FROM kinds WHERE kind='InstalledPlugin' AND namespace='default' AND is_active=1", ()).await?;
    for row in rows {
        let mut payload = row.payload.map(|v| v.0).unwrap_or(json!({}));
        let Some(spec) = payload.get_mut("spec").and_then(Value::as_object_mut) else {
            continue;
        };
        if spec
            .get("source")
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str)
            != Some("marketplace")
        {
            continue;
        }
        if !spec
            .get("pluginId")
            .is_some_and(|v| v.is_i64() || v.is_u64() || v.is_boolean())
        {
            continue;
        }
        spec.insert(
            "updatePolicy".into(),
            json!(if down { "manual" } else { "auto" }),
        );
        tx.execute(
            "UPDATE kinds SET json=? WHERE id=?",
            (Json(payload), row.id),
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn retrieval_key(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    let (old, new) = if down {
        (
            "knowledge_base_retrieval_profile",
            "code_wiki_retrieval_profile",
        )
    } else {
        (
            "code_wiki_retrieval_profile",
            "knowledge_base_retrieval_profile",
        )
    };
    // The original migration preserves a separately configured target key.
    #[derive(FromMysqlRow)]
    struct Id {
        id: i64,
    }
    let target: Option<Id> = tx
        .fetch_optional(
            "SELECT id FROM system_configs WHERE config_key=? LIMIT 1",
            (new,),
        )
        .await?;
    if let Some(row) = &target {
        tracing::debug!(id = row.id, "target retrieval configuration already exists");
    }
    if target.is_none() {
        tx.execute(
            "UPDATE system_configs SET config_key=? WHERE config_key=?",
            (new, old),
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn codex(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    const MARKER: &str = "codex-public-shell-c9d4e7f1a2b3";
    if down {
        let rows: Vec<Kind> = tx.fetch_all("SELECT id,json AS payload FROM kinds WHERE user_id=0 AND kind='Shell' AND name='Codex' AND namespace='default'", ()).await?;
        for row in rows {
            if row
                .payload
                .as_ref()
                .and_then(|v| v.0.pointer("/metadata/migrationSource"))
                .and_then(Value::as_str)
                == Some(MARKER)
            {
                tx.execute("DELETE FROM kinds WHERE id=?", (row.id,))
                    .await?;
            }
        }
    } else {
        #[derive(FromMysqlRow)]
        struct Existing {
            id: i64,
            is_active: bool,
        }
        let existing: Option<Existing> = tx.fetch_optional("SELECT id,is_active FROM kinds WHERE user_id=0 AND kind='Shell' AND name='Codex' AND namespace='default' ORDER BY is_active DESC,id LIMIT 1", ()).await?;
        if let Some(row) = existing {
            if !row.is_active {
                tx.execute("UPDATE kinds SET is_active=1 WHERE id=?", (row.id,))
                    .await?;
            }
        } else {
            let payload = json!({"apiVersion":"agent.wecode.io/v1","kind":"Shell","metadata":{"name":"Codex","namespace":"default","labels":{"type":"local_engine"},"migrationSource":MARKER},"spec":{"shellType":"Codex","supportModel":[],"baseImage":"ghcr.io/wecode-ai/wegent-executor:latest"},"status":{"state":"Available"}});
            tx.execute("INSERT INTO kinds (user_id,kind,name,namespace,json,is_active) VALUES (0,'Shell','Codex','default',?,1)", (Json(payload),)).await?;
        }
    }
    Ok(())
}

#[derive(FromMysqlRow)]
struct Node {
    id: String,
    resource_type: String,
    payload: Option<Json<Value>>,
}

fn requirement_id(resource_id: &str, key: &str, node_id: &str, index: usize, name: &str) -> String {
    // uuid.uuid5(uuid.NAMESPACE_URL, identity), returned without hyphens.
    let mut digest = Sha1::new();
    digest.update([
        0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30,
        0xc8,
    ]);
    digest.update(format!(
        "wegent:{resource_id}:{key}:{node_id}:{index}:{name}"
    ));
    let mut bytes = digest.finalize()[..16].to_vec();
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn rewrite_workflow(id: &str, key: &str, payload: &mut Value, down: bool) -> bool {
    let Some(nodes) = payload
        .get_mut(key)
        .and_then(|v| v.get_mut("nodes"))
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let mut changed = false;
    for (node_index, node) in nodes.iter_mut().enumerate() {
        let node_id = node
            .get("id")
            .filter(|v| crate::json_compat::python_truthy(v))
            .map(crate::json_compat::python_str)
            .unwrap_or_else(|| node_index.to_string());
        let Some(values) = node
            .get_mut("required_deliverables")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        let mut rewritten = Vec::new();
        for (index, value) in values.iter().enumerate() {
            if !down
                && value
                    .as_str()
                    .is_some_and(|s| !crate::json_compat::python_strip(s).is_empty())
            {
                let name = crate::json_compat::python_strip(value.as_str().unwrap());
                rewritten.push(json!({"id":requirement_id(id,key,&node_id,index,&name),"name":name,"description":"","value_type":"file","file_constraints":{"accepted_types":[],"min_files":1,"max_files":1}}));
                changed = true;
            } else if down && value.is_object() {
                let name = crate::json_compat::python_strip(
                    &value
                        .get("name")
                        .filter(|v| crate::json_compat::python_truthy(v))
                        .map(crate::json_compat::python_str)
                        .unwrap_or_default(),
                );
                if !name.is_empty() {
                    rewritten.push(json!(name));
                }
                changed = true;
            } else {
                rewritten.push(value.clone());
            }
        }
        *values = rewritten;
    }
    changed
}

pub(super) async fn workflows(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    let rows: Vec<Node> = tx.fetch_all("SELECT id,resource_type,metadata AS payload FROM loop_items WHERE resource_type IN ('project','task')", ()).await?;
    for row in rows {
        let mut payload = row.payload.map(|v| v.0).unwrap_or(Value::Null);
        let key = if row.resource_type == "project" {
            "workflow_definition"
        } else {
            "workflow"
        };
        if rewrite_workflow(&row.id, key, &mut payload, down) {
            tx.execute(
                "UPDATE loop_items SET metadata=? WHERE id=?",
                (Json(payload), row.id.as_str()),
            )
            .await?;
        }
    }
    Ok(())
}

#[derive(FromMysqlRow)]
struct Project {
    id: String,
    payload: Option<Json<Value>>,
}

#[derive(FromMysqlRow)]
struct Member {
    id: i64,
    role: String,
}

pub(super) async fn project_permissions(
    tx: &mut impl MysqlTransaction,
    down: bool,
) -> MysqlResult<()> {
    let rows: Vec<Project> = tx
        .fetch_all(
            "SELECT id,metadata AS payload FROM loop_items WHERE resource_type='project'",
            (),
        )
        .await?;
    for row in rows {
        let mut metadata = super::rows::object(&row.payload.map(|v| v.0).unwrap_or(Value::Null))?;
        if down {
            restore_permissions(tx, &row.id, &mut metadata).await?;
        } else {
            migrate_permissions(tx, &row.id, &mut metadata).await?;
        }
    }
    Ok(())
}

async fn migrate_permissions(
    tx: &mut impl MysqlTransaction,
    id: &str,
    metadata: &mut Value,
) -> MysqlResult<()> {
    let visibility = metadata
        .as_object_mut()
        .unwrap()
        .remove("visibility")
        .unwrap_or(json!("private"));
    let mut migration = json!({"visibility":visibility});
    if matches!(visibility.as_str(), Some("public" | "public_restricted")) {
        migration["default_issue_security"] = metadata
            .get("default_issue_security")
            .cloned()
            .unwrap_or(Value::Null);
        metadata["default_issue_security"] = json!("related");
        tx.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,role,status,user_id,requested_at,created_at,updated_at) VALUES ('CloudProject',?,'authenticated_users','*','Viewer','approved',0,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())", (id,)).await?;
        let tasks: Vec<Project> = tx.fetch_all("SELECT id,metadata AS payload FROM loop_items WHERE resource_type='task' AND cloud_project_id=?", (id,)).await?;
        let mut issue_ids = Vec::new();
        for task in tasks {
            let mut payload =
                super::rows::object(&task.payload.map(|v| v.0).unwrap_or(Value::Null))?;
            if payload.get("security_level").is_none() {
                issue_ids.push(task.id.clone());
                payload["security_level"] = json!("related");
                tx.execute(
                    "UPDATE loop_items SET metadata=? WHERE id=?",
                    (Json(payload), task.id),
                )
                .await?;
            }
        }
        migration["issue_ids"] = json!(issue_ids);
    }
    let members: Vec<Member> = tx.fetch_all("SELECT id,role FROM resource_members WHERE resource_type='CloudProject' AND resource_id=? AND role IN ('Reporter','RestrictedAnalyst')", (id,)).await?;
    if !members.is_empty() {
        let mut roles = serde_json::Map::new();
        for member in members {
            roles.insert(member.id.to_string(), json!(member.role));
            tx.execute(
                "UPDATE resource_members SET role='Viewer' WHERE id=?",
                (member.id,),
            )
            .await?;
        }
        migration["member_roles"] = Value::Object(roles);
    }
    metadata["permission_migration"] = migration;
    tx.execute(
        "UPDATE loop_items SET metadata=? WHERE id=?",
        (Json(metadata.clone()), id),
    )
    .await?;
    Ok(())
}

async fn restore_permissions(
    tx: &mut impl MysqlTransaction,
    id: &str,
    metadata: &mut Value,
) -> MysqlResult<()> {
    let Some(migration) = metadata
        .as_object_mut()
        .and_then(|m| m.remove("permission_migration"))
        .filter(Value::is_object)
    else {
        return Ok(());
    };
    let visibility = migration
        .get("visibility")
        .cloned()
        .unwrap_or(json!("private"));
    metadata["visibility"] = visibility.clone();
    if matches!(visibility.as_str(), Some("public" | "public_restricted")) {
        match migration
            .get("default_issue_security")
            .filter(|v| !v.is_null())
        {
            Some(value) => metadata["default_issue_security"] = value.clone(),
            None => {
                metadata
                    .as_object_mut()
                    .unwrap()
                    .remove("default_issue_security");
            }
        }
        for task_id in migration
            .get("issue_ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let task: Option<Project> = tx.fetch_optional("SELECT id,metadata AS payload FROM loop_items WHERE resource_type='task' AND cloud_project_id=? AND id=?", (id, task_id)).await?;
            if let Some(task) = task {
                let mut payload =
                    super::rows::object(&task.payload.map(|v| v.0).unwrap_or(Value::Null))?;
                if payload.get("security_level").and_then(Value::as_str) == Some("related") {
                    payload.as_object_mut().unwrap().remove("security_level");
                    tx.execute(
                        "UPDATE loop_items SET metadata=? WHERE id=?",
                        (Json(payload), task.id),
                    )
                    .await?;
                }
            }
        }
    }
    tx.execute("DELETE FROM resource_members WHERE resource_type='CloudProject' AND resource_id=? AND entity_type='authenticated_users' AND entity_id='*'", (id,)).await?;
    for (member_id, role) in migration
        .get("member_roles")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        tx.execute(
            "UPDATE resource_members SET role=? WHERE id=?",
            (role.as_str().unwrap_or(""), member_id.as_str()),
        )
        .await?;
    }
    tx.execute(
        "UPDATE loop_items SET metadata=? WHERE id=?",
        (Json(metadata.clone()), id),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deliverable_identity_matches_python_uuid5_including_unicode() {
        assert_eq!(
            requirement_id("101", "workflow_definition", "n1", 0, "报告"),
            "363b4c4f63cc58d4ab9f0ff9fd412758"
        );
        let mut payload = json!({"workflow_definition":{"nodes":[{"id":"n1","required_deliverables":[" 报告 ","",{"name":"existing"}]}]}});
        assert!(rewrite_workflow(
            "101",
            "workflow_definition",
            &mut payload,
            false
        ));
        assert_eq!(
            payload["workflow_definition"]["nodes"][0]["required_deliverables"][0]["id"],
            json!("363b4c4f63cc58d4ab9f0ff9fd412758")
        );
        assert!(rewrite_workflow(
            "101",
            "workflow_definition",
            &mut payload,
            true
        ));
        assert_eq!(
            payload["workflow_definition"]["nodes"][0]["required_deliverables"],
            json!(["报告", "", "existing"])
        );
    }
}

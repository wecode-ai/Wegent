// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Shared Kind-backed collaboration configuration; marketplace references keep
//! using the existing resource-library publication and installation protocol.

mod schema;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

const COLUMNS: &str = "id,user_id,name,namespace,json";

#[derive(Debug, FromMysqlRow)]
struct Row {
    id: i64,
    user_id: i64,
    name: String,
    namespace: String,
    json: Json<Value>,
}

#[derive(FromMysqlRow)]
struct IdRow {
    id: i64,
}

#[derive(FromMysqlRow)]
struct EntityRow {
    entity_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveRequest {
    document: Value,
    expected_revision: Option<String>,
}

fn internal(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error, "collaboration template operation failed");
    FastApiError::unhandled()
}

fn not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Collaboration template not found")
}

fn collaboration(row: &Row) -> bool {
    row.json.0["spec"]["category"] == "collaboration"
}

fn revision(row: &Row) -> String {
    row.json.0["spec"]["configurationRevision"]
        .as_u64()
        .unwrap_or(0)
        .to_string()
}

fn portable(row: &Row) -> Value {
    let spec = &row.json.0["spec"];
    json!({"apiVersion":"agent.wecode.io/v1","kind":"Template",
        "metadata":{"name":row.name,"namespace":row.namespace},
        "spec":{"category":"collaboration","displayName":spec["displayName"],
            "description":spec["description"],"version":spec["version"],"resources":spec["resources"]}})
}

fn record(row: &Row, user_id: i64) -> Value {
    let source = if row.user_id == user_id && row.namespace == "default" {
        "personal"
    } else {
        "downloaded"
    };
    json!({"id":row.id,"ownerId":row.user_id,"document":portable(row),
        "revision":revision(row),"source":source})
}

fn summary(row: &Row) -> Value {
    let spec = &row.json.0["spec"];
    json!({"id":row.id,"ownerId":row.user_id,"namespace":row.namespace,"name":row.name,
        "displayName":spec["displayName"],"description":spec["description"],
        "version":spec["version"],"revision":revision(row)})
}

async fn group_ids(state: &AppState, user_id: i64) -> Result<Vec<String>, FastApiError> {
    let groups = crate::permissions::user_groups(
        &state.mysql,
        &state.entity_resolvers,
        state.redis.as_ref(),
        user_id,
    )
    .await
    .map_err(internal)?;
    crate::permissions::accessible_namespace_ids(&state.mysql, &groups)
        .await
        .map_err(internal)
}

async fn can_read(state: &AppState, row: &Row, user_id: i64) -> Result<bool, FastApiError> {
    if !collaboration(row) {
        return Ok(false);
    }
    if row.user_id == user_id && row.namespace == "default" {
        return Ok(true);
    }
    let capability = &row.json.0["spec"]["capability"];
    let public = if row.user_id == 0 && row.namespace == "system" {
        capability["visibility"].as_str().unwrap_or("public") == "public"
            && capability["publishStatus"].as_str().unwrap_or("published") == "published"
    } else {
        capability["visibility"] == "public" && capability["publishStatus"] == "published"
    };
    if public {
        return Ok(true);
    }
    let reference: Option<IdRow> = state.mysql.fetch_optional("SELECT id FROM resource_members WHERE resource_type='Template' AND resource_id=? AND entity_type='user' AND entity_id=? AND status='approved' LIMIT 1", (row.id, user_id.to_string())).await.map_err(internal)?;
    if reference.is_some_and(|reference| reference.id > 0) {
        return Ok(true);
    }
    let references: Vec<EntityRow> = state.mysql.fetch_all("SELECT entity_id FROM resource_members WHERE resource_type='Template' AND resource_id=? AND entity_type='namespace' AND status='approved'", (row.id,)).await.map_err(internal)?;
    if references.is_empty() {
        return Ok(false);
    }
    let groups = group_ids(state, user_id).await?;
    Ok(references
        .iter()
        .any(|reference| groups.contains(&reference.entity_id)))
}

#[brz_http_server::get("/api/v1/collaboration-templates")]
async fn list_templates(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<Value, FastApiError> {
    let user_id = i64::from(user.id);
    let namespaces = Json(json!(group_ids(state, user_id).await?));
    let rows: Vec<Row> = state.mysql.fetch_all(format!("SELECT {COLUMNS} FROM kinds WHERE kind='Template' AND is_active=true AND JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.category'))='collaboration' AND ((user_id=? AND namespace='default') OR (user_id=0 AND namespace='system') OR id IN (SELECT resource_id FROM resource_members WHERE resource_type='Template' AND status='approved' AND ((entity_type='user' AND entity_id=?) OR (entity_type='namespace' AND JSON_CONTAINS(?, JSON_QUOTE(entity_id)))))) ORDER BY id DESC"), (user_id, user_id.to_string(), namespaces)).await.map_err(internal)?;
    let mut items = Vec::new();
    for row in &rows {
        if can_read(state, row, user_id).await? {
            items.push(summary(row));
        }
    }
    Ok(json!({"items":items}))
}

#[brz_http_server::get("/api/v1/collaboration-templates/:template_id")]
async fn get_template(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    template_id: i64,
) -> Result<Value, FastApiError> {
    // Resolve the immutable numeric locator, then read the complete Kind identity.
    let locator: Option<Row> = state
        .mysql
        .fetch_optional(
            format!(
                "SELECT {COLUMNS} FROM kinds WHERE id=? AND kind='Template' AND is_active=true"
            ),
            (template_id,),
        )
        .await
        .map_err(internal)?;
    let locator = locator.ok_or_else(not_found)?;
    if !can_read(state, &locator, i64::from(user.id)).await? {
        return Err(not_found());
    }
    let row: Option<Row> = state.mysql.fetch_optional(format!("SELECT {COLUMNS} FROM kinds WHERE kind='Template' AND user_id=? AND namespace=? AND name=? AND id=? AND is_active=true"), (locator.user_id, locator.namespace.as_str(), locator.name.as_str(), locator.id)).await.map_err(internal)?;
    let row = row.ok_or_else(not_found)?;
    // Permission is checked on the returned version, including concurrent revocation.
    if !can_read(state, &row, i64::from(user.id)).await? {
        return Err(not_found());
    }
    schema::validate(&portable(&row))?;
    Ok(record(&row, i64::from(user.id)))
}

enum SaveResult {
    Saved(i64),
    Conflict,
}

#[brz_http_server::put("/api/v1/collaboration-templates/:name")]
async fn save_template(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    name: String,
    body: Value,
) -> Result<Value, FastApiError> {
    let request: SaveRequest = serde_json::from_value(body).map_err(|_| {
        FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, "Invalid template request")
    })?;
    schema::validate(&request.document)?;
    if request.document["metadata"]["name"] != name
        || request.document["metadata"]["namespace"] != "default"
    {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Personal templates must use their own default namespace",
        ));
    }
    let user_id = i64::from(user.id);
    let outcome = state.mysql.with_transaction(async |tx| {
        // Serialize identity creation without relying on a nonexistent Kind uniqueness constraint.
        let _: Option<IdRow> = tx.fetch_optional("SELECT id FROM users WHERE id=? FOR UPDATE", (user_id,)).await?;
        let existing: Option<Row> = tx.fetch_optional(format!("SELECT {COLUMNS} FROM kinds WHERE kind='Template' AND user_id=? AND namespace='default' AND name=? AND is_active=true FOR UPDATE"), (user_id, name.as_str())).await?;
        if let Some(existing) = &existing {
            if !collaboration(existing) { return Ok(SaveResult::Conflict); }
            if portable(existing) == request.document { return Ok(SaveResult::Saved(existing.id)); }
            if request.expected_revision.as_deref() != Some(revision(existing).as_str()) || existing.json.0["spec"]["version"] == request.document["spec"]["version"] {
                return Ok(SaveResult::Conflict);
            }
        } else if request.expected_revision.is_some() { return Ok(SaveResult::Conflict); }
        let mut document = request.document.clone();
        let next_revision = existing.as_ref().and_then(|row| row.json.0["spec"]["configurationRevision"].as_u64()).unwrap_or(0) + 1;
        document["spec"]["configurationRevision"] = next_revision.into();
        if let Some(existing) = &existing {
            if let Some(capability) = existing.json.0["spec"].get("capability") { document["spec"]["capability"] = capability.clone(); }
            tx.execute("UPDATE kinds SET json=?,updated_at=NOW() WHERE id=? AND user_id=? AND namespace='default' AND name=? AND kind='Template'", (Json(document),existing.id,user_id,name.as_str())).await?;
            Ok(SaveResult::Saved(existing.id))
        } else {
            let result = tx.execute("INSERT INTO kinds(user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (?,'Template',?,'default',?,true,NOW(),NOW())", (user_id,name.as_str(),Json(document))).await?;
            Ok(SaveResult::Saved(result.last_insert_id as i64))
        }
    }).await.map_err(internal)?;
    let SaveResult::Saved(id) = outcome else {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Template name or version already exists; save under a new name or version",
        ));
    };
    let row: Option<Row> = state.mysql.fetch_optional(format!("SELECT {COLUMNS} FROM kinds WHERE id=? AND user_id=? AND namespace='default' AND name=? AND kind='Template' AND is_active=true"), (id,user_id,name.as_str())).await.map_err(internal)?;
    Ok(record(&row.ok_or_else(not_found)?, user_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_classify_only_owned_default_templates_as_personal() {
        let mut row = Row {
            id: 42,
            user_id: 7,
            name: "workflow".into(),
            namespace: "default".into(),
            json: Json(json!({"spec":{"category":"collaboration"}})),
        };
        assert_eq!(record(&row, 7)["source"], "personal");
        assert_eq!(record(&row, 8)["source"], "downloaded");
        row.namespace = "system".into();
        assert_eq!(record(&row, 7)["source"], "downloaded");
    }
}

//! Actor-private durable template import identities and resource-owned receipts.

use std::collections::{BTreeMap, HashSet};

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlRow, MysqlTransaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

mod cipher;
use cipher::IntentCipher;

const TEMPLATE_IMPORT_RESOURCE_TYPE: &str = "template_import";
const TEMPLATE_IMPORT_KIND: &str = "template_import_operation";

const OPERATION_COLUMNS: &str = concat!(
    "CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS id,",
    "CONVERT(cloud_project_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS project_id,",
    "created_by_user_id AS actor_user_id,",
    "CONVERT(kind USING utf8mb4) COLLATE utf8mb4_unicode_ci AS kind,",
    "metadata"
);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Step {
    key: String,
    kind: StepKind,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum StepKind {
    Agent,
    Group,
    Automation,
    Board,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    kind: StepKind,
    request_sha256: String,
    resource_id: String,
    #[serde(default)]
    completed_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationData {
    protocol_version: i32,
    intent_sha256: String,
    intent_encrypted: String,
    manifest: Vec<Step>,
    #[serde(default)]
    receipts: BTreeMap<String, Receipt>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Begin {
    protocol_version: i32,
    intent: Value,
    steps: Vec<Step>,
}

#[derive(FromMysqlRow)]
struct Operation {
    id: String,
    project_id: String,
    actor_user_id: i32,
    kind: String,
    #[mysql(rename = "metadata")]
    data: Json<OperationData>,
}

fn unavailable() -> FastApiError {
    FastApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "Template import recovery encryption is unavailable; check the server encryption configuration",
    )
}

fn storage(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "template import storage failed");
    FastApiError::internal()
}

fn missing() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Template import not found")
}

fn project_number(project: &str) -> Result<i64, FastApiError> {
    project
        .parse::<i64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(missing)
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(values) => {
            let mut sorted: Map<String, Value> = values
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect();
            sorted.sort_keys();
            Value::Object(sorted)
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

fn digest_value(value: &Value) -> Result<String, FastApiError> {
    let bytes = serde_json::to_vec(value).map_err(|_| FastApiError::internal())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn digest(intent: &Value, steps: &[Step]) -> Result<String, FastApiError> {
    digest_value(&canonical(
        &json!({"protocolVersion":1,"intent":intent,"steps":steps}),
    ))
}

fn operation_identity(
    actor: i32,
    project: &str,
    intent_sha256: &str,
) -> Result<String, FastApiError> {
    digest_value(&canonical(&json!({
        "actorUserId":actor,
        "projectId":project,
        "protocolVersion":1,
        "intentSha256":intent_sha256,
    })))
}

impl Begin {
    fn validate(&self) -> Result<(), FastApiError> {
        let mut keys = HashSet::new();
        if self.protocol_version != 1
            || !self.intent.is_object()
            || self.intent.get("previousImportId").is_some_and(|previous| {
                previous
                    .as_str()
                    .is_none_or(|id| id.is_empty() || id.chars().count() > 64)
            })
            || self.steps.is_empty()
            || self.steps.len() > 200
            || self.steps.iter().any(|step| {
                step.key.is_empty() || step.key.chars().count() > 200 || !keys.insert(&step.key)
            })
        {
            return Err(FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Import requires protocolVersion 1, an intent object, 1 to 200 uniquely keyed steps and a valid previousImportId when supplied",
            ));
        }
        Ok(())
    }
}

async fn can_maintain(
    tx: &mut impl MysqlTransaction,
    project: i64,
    actor: i32,
) -> brz_mysql::MysqlResult<bool> {
    let access: Option<MysqlRow> = tx
        .fetch_optional(
            crate::cloud_projects::project_access_statement(actor, Some(project), None),
            (),
        )
        .await?;
    let priority: Option<i64> = access
        .as_ref()
        .map(|row| row.get_required("anon_1_priority"))
        .transpose()?;
    Ok(priority.is_some_and(|priority| priority <= 1))
}

fn manifest_complete(manifest: &[Step], receipts: &BTreeMap<String, Receipt>) -> bool {
    manifest.iter().all(|step| {
        receipts
            .get(&step.key)
            .is_some_and(|receipt| receipt.kind == step.kind)
    })
}

fn steps_complete(operation: &Operation) -> bool {
    manifest_complete(&operation.data.0.manifest, &operation.data.0.receipts)
}

fn step_views(manifest: &[Step], receipts: &BTreeMap<String, Receipt>) -> Vec<Value> {
    manifest
        .iter()
        .map(|step| {
            let mut value = json!({"key":step.key,"kind":step.kind});
            if let Some(receipt) = receipts.get(&step.key) {
                if receipt.kind == step.kind {
                    value["resourceId"] = Value::String(receipt.resource_id.clone());
                }
            }
            value
        })
        .collect()
}

fn summary(operation: &Operation) -> Value {
    let steps = step_views(&operation.data.0.manifest, &operation.data.0.receipts);
    let complete = steps.iter().all(|step| step.get("resourceId").is_some());
    json!({
        "id":operation.id,"projectId":operation.project_id,
        "protocolVersion":operation.data.0.protocol_version,
        "status":if complete { "completed" } else { "pending" },
        "steps":steps
    })
}

fn view(operation: Operation, cipher: &IntentCipher) -> Result<Value, FastApiError> {
    let intent = cipher.open(&operation.data.0.intent_encrypted)?;
    if digest(&intent, &operation.data.0.manifest)? != operation.data.0.intent_sha256 {
        return Err(unavailable());
    }
    let mut result = summary(&operation);
    result["intent"] = intent;
    Ok(result)
}

async fn operation_by_id(
    tx: &mut impl MysqlTransaction,
    operation_id: &str,
    actor: i32,
    project: &str,
) -> brz_mysql::MysqlResult<Option<Operation>> {
    tx.fetch_optional(
        format!(
            "SELECT {OPERATION_COLUMNS} FROM loop_items \
             WHERE id=? AND resource_type=? AND kind=? AND created_by_user_id=? \
             AND cloud_project_id=? FOR UPDATE"
        ),
        (
            operation_id,
            TEMPLATE_IMPORT_RESOURCE_TYPE,
            TEMPLATE_IMPORT_KIND,
            actor,
            project,
        ),
    )
    .await
}

async fn predecessor_complete(
    tx: &mut impl MysqlTransaction,
    project: &str,
    actor: i32,
    previous: &str,
) -> brz_mysql::MysqlResult<Option<bool>> {
    let operation = operation_by_id(tx, previous, actor, project).await?;
    Ok(operation.map(|operation| steps_complete(&operation)))
}

#[brz_http_server::post("/api/v1/cloud-projects/:project_id/template-imports")]
#[tracing::instrument(skip_all, name = "collaboration.template_import.begin")]
async fn begin_import(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    project_id: &str,
    body: Begin,
) -> Result<Value, FastApiError> {
    begin_with_cipher(state, user, project_id, body, IntentCipher::from_env()).await
}

async fn begin_with_cipher(
    state: &AppState,
    user: SessionUser,
    project_id: &str,
    body: Begin,
    cipher: Result<IntentCipher, FastApiError>,
) -> Result<Value, FastApiError> {
    body.validate()?;
    let project = project_number(project_id)?;
    let project_id = project.to_string();
    let cipher = cipher?;
    let checksum = digest(&body.intent, &body.steps)?;
    let encrypted = cipher.seal(&canonical(&body.intent))?;
    let id = operation_identity(user.0.id, &project_id, &checksum)?;
    // Keep preflight outside the write transaction so it cannot establish an old snapshot.
    if !state
        .mysql
        .with_transaction(async |tx| can_maintain(tx, project, user.0.id).await)
        .await
        .map_err(storage)?
    {
        return Err(missing());
    }
    let result = state
        .mysql
        .with_transaction(async |tx| {
            if let Some(previous)=body.intent.get("previousImportId").and_then(Value::as_str) {
                match predecessor_complete(tx,&project_id,user.0.id,previous).await? {
                    None=>return Ok(Err(missing())),
                    Some(false)=>{
                        if !can_maintain(tx, project, user.0.id).await? {
                            return Err(brz_mysql::MysqlError::RowNotFound);
                        }
                        return Ok(Err(FastApiError::detail(StatusCode::CONFLICT,"The previous template import is incomplete; resume it before importing again")));
                    },
                    Some(true)=>{},
                }
            }
            let data = OperationData {
                protocol_version: 1,
                intent_sha256: checksum.clone(),
                intent_encrypted: encrypted.clone(),
                manifest: body.steps.clone(),
                receipts: BTreeMap::new(),
            };
            let required = crate::loop_node_storage::required_columns(tx).await?;
            let insert = crate::loop_node_storage::insert_sql(
                &[
                    "id",
                    "resource_type",
                    "project_space",
                    "cloud_project_id",
                    "created_by_user_id",
                    "kind",
                    "status",
                    "description",
                    "metadata",
                    "version",
                    "next_item_number",
                    "sort_order",
                    "created_at",
                    "updated_at",
                ],
                &[
                    "?",
                    "'template_import'",
                    "'default'",
                    "?",
                    "?",
                    "'template_import_operation'",
                    "'pending'",
                    "''",
                    "?",
                    "1",
                    "1",
                    "0",
                    "UTC_TIMESTAMP(6)",
                    "UTC_TIMESTAMP(6)",
                ],
                &required,
            );
            tx.execute(
                format!("{insert} ON DUPLICATE KEY UPDATE id=id"),
                (
                    id.as_str(),
                    project_id.as_str(),
                    user.0.id,
                    Json(&data),
                ),
            )
            .await?;
            let operation = operation_by_id(tx, &id, user.0.id, &project_id)
                .await?
                .ok_or(brz_mysql::MysqlError::RowNotFound)?;
            // Locking reads above do not establish an RR snapshot. This first consistent
            // read observes revocations committed while waiting, and denial rolls back INSERT.
            if !can_maintain(tx, project, user.0.id).await? {
                return Err(brz_mysql::MysqlError::RowNotFound);
            }
            Ok(Ok(operation))
        })
        .await
        .map_err(|error| match error {
            brz_mysql::MysqlError::RowNotFound => missing(),
            other => storage(other),
        })??;
    view(result, &cipher)
}

#[brz_http_server::get("/api/v1/cloud-projects/:project_id/template-imports")]
#[tracing::instrument(skip_all, name = "collaboration.template_import.list")]
async fn list_imports(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    project_id: &str,
) -> Result<Value, FastApiError> {
    let project = project_number(project_id)?;
    let project_id = project.to_string();
    let result = state.mysql.with_transaction(async |tx| {
        if !can_maintain(tx, project, user.0.id).await? { return Ok(None); }
        let operations:Vec<Operation>=tx.fetch_all(format!("SELECT {OPERATION_COLUMNS} FROM loop_items WHERE resource_type=? AND kind=? AND created_by_user_id=? AND cloud_project_id=? AND status='pending' ORDER BY created_at DESC,id DESC"),(TEMPLATE_IMPORT_RESOURCE_TYPE,TEMPLATE_IMPORT_KIND,user.0.id,project_id.as_str())).await?;
        Ok(Some(operations.into_iter().filter(|operation| !steps_complete(operation)).map(|operation| summary(&operation)).collect::<Vec<_>>()))
    }).await.map_err(storage)?.ok_or_else(missing)?;
    Ok(json!({"items":result}))
}

#[brz_http_server::get("/api/v1/cloud-projects/:project_id/template-imports/:operation_id")]
#[tracing::instrument(skip_all, name = "collaboration.template_import.status")]
async fn import_status(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    project_id: &str,
    operation_id: &str,
) -> Result<Value, FastApiError> {
    let project = project_number(project_id)?;
    let project_id = project.to_string();
    let result = state
        .mysql
        .with_transaction(async |tx| {
            let operation = operation_by_id(tx, operation_id, user.0.id, &project_id).await?;
            let Some(operation) = operation else {
                return Ok(None);
            };
            if operation.kind != TEMPLATE_IMPORT_KIND || operation.actor_user_id != user.0.id {
                return Ok(None);
            }
            if !can_maintain(tx, project, user.0.id).await? {
                return Ok(None);
            }
            Ok(Some(operation))
        })
        .await
        .map_err(storage)?
        .ok_or_else(missing)?;
    view(result, &IntentCipher::from_env()?)
}

#[cfg(test)]
mod mysql_tests;
#[cfg(test)]
mod tests;

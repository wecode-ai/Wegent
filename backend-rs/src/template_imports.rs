//! Actor-private durable template import identities and resource-owned receipts.

use std::collections::{HashMap, HashSet};

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlRow, MysqlTransaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

mod cipher;
use cipher::IntentCipher;

// Binary storage preserves exact identities; SQLx requires text result metadata.
const OPERATION_COLUMNS: &str = concat!(
    "CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS id,",
    "CONVERT(project_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS project_id,",
    "protocol_version,",
    "CONVERT(intent_sha256 USING utf8mb4) COLLATE utf8mb4_unicode_ci AS intent_sha256,",
    "CONVERT(intent_encrypted USING utf8mb4) COLLATE utf8mb4_unicode_ci AS intent_encrypted,manifest"
);
const SUMMARY_COLUMNS: &str = concat!(
    "CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS id,",
    "CONVERT(project_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS project_id,",
    "protocol_version,manifest"
);
const RECEIPT_COLUMNS: &str = concat!(
    "CONVERT(step_key USING utf8mb4) COLLATE utf8mb4_unicode_ci AS step_key,",
    "CONVERT(kind USING utf8mb4) COLLATE utf8mb4_unicode_ci AS kind,",
    "CONVERT(resource_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS resource_id"
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
    protocol_version: i32,
    intent_sha256: String,
    intent_encrypted: String,
    manifest: Json<Vec<Step>>,
}

#[derive(FromMysqlRow)]
struct Receipt {
    step_key: String,
    kind: String,
    resource_id: String,
}

#[derive(FromMysqlRow)]
struct SummaryOperation {
    id: String,
    project_id: String,
    protocol_version: i32,
    manifest: Json<Vec<Step>>,
}

#[derive(FromMysqlRow)]
struct OperationReceipt {
    operation_id: String,
    step_key: String,
    kind: String,
    resource_id: String,
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

fn digest(intent: &Value, steps: &[Step]) -> Result<String, FastApiError> {
    let payload = canonical(&json!({"protocolVersion":1,"intent":intent,"steps":steps}));
    let bytes = serde_json::to_vec(&payload).map_err(|_| FastApiError::internal())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
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

async fn receipts(
    tx: &mut impl MysqlTransaction,
    operation: &str,
) -> brz_mysql::MysqlResult<Vec<Receipt>> {
    tx.fetch_all(
        format!(
            "SELECT {RECEIPT_COLUMNS} FROM template_import_receipts WHERE operation_id=? FOR UPDATE"
        ),
        (operation,),
    )
    .await
}

async fn predecessor_complete(
    tx: &mut impl MysqlTransaction,
    project: &str,
    actor: i32,
    previous: &str,
) -> brz_mysql::MysqlResult<Option<bool>> {
    let operation:Option<SummaryOperation>=tx.fetch_optional(format!("SELECT {SUMMARY_COLUMNS} FROM template_import_operations WHERE id=? AND actor_user_id=? AND project_id=? AND protocol_version=1 FOR UPDATE"),(previous,actor,project)).await?;
    let Some(operation) = operation else {
        return Ok(None);
    };
    let receipt = receipts(tx, previous).await?;
    Ok(Some(
        step_views(&operation.manifest.0, &receipt)
            .iter()
            .all(|step| step.get("resourceId").is_some()),
    ))
}

fn step_views(manifest: &[Step], receipts: &[Receipt]) -> Vec<Value> {
    manifest
        .iter()
        .map(|step| {
            let mut value = json!({"key":step.key,"kind":step.kind});
            if let Some(receipt) = receipts.iter().find(|receipt| {
                receipt.step_key == step.key
                    && serde_json::to_value(&step.kind).ok().as_ref()
                        == Some(&Value::String(receipt.kind.clone()))
            }) {
                value["resourceId"] = Value::String(receipt.resource_id.clone());
            }
            value
        })
        .collect()
}

fn summary(operation: SummaryOperation, receipts: Vec<Receipt>) -> Value {
    let steps = step_views(&operation.manifest.0, &receipts);
    let complete = steps.iter().all(|step| step.get("resourceId").is_some());
    json!({
        "id":operation.id,"projectId":operation.project_id,
        "protocolVersion":operation.protocol_version,
        "status":if complete { "completed" } else { "pending" },
        "steps":steps
    })
}

fn view(
    operation: Operation,
    receipts: Vec<Receipt>,
    cipher: &IntentCipher,
) -> Result<Value, FastApiError> {
    let intent = cipher.open(&operation.intent_encrypted)?;
    if digest(&intent, &operation.manifest.0)? != operation.intent_sha256 {
        return Err(unavailable());
    }
    let mut result = summary(
        SummaryOperation {
            id: operation.id,
            project_id: operation.project_id,
            protocol_version: operation.protocol_version,
            manifest: operation.manifest,
        },
        receipts,
    );
    result["intent"] = intent;
    Ok(result)
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
    let id = crate::wework_auth_tokens::uuid4_hex()?;
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
            // The unique configuration identity serializes concurrent clients without a lease.
            tx.execute("INSERT INTO template_import_operations (id,project_id,actor_user_id,protocol_version,intent_sha256,intent_encrypted,manifest,created_at,updated_at) VALUES (?,?,?,1,?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE id=template_import_operations.id",(id.as_str(),project_id.as_str(),user.0.id,checksum.as_str(),encrypted.as_str(),Json(&body.steps))).await?;
            let operation:Operation=tx.fetch_one(format!("SELECT {OPERATION_COLUMNS} FROM template_import_operations WHERE actor_user_id=? AND project_id=? AND protocol_version=1 AND intent_sha256=? FOR UPDATE"),(user.0.id,project_id.as_str(),checksum.as_str())).await?;
            // Locking reads above do not establish an RR snapshot. This first consistent
            // read observes revocations committed while waiting, and denial rolls back INSERT.
            if !can_maintain(tx, project, user.0.id).await? {
                return Err(brz_mysql::MysqlError::RowNotFound);
            }
            let receipt = receipts(tx, &operation.id).await?;
            Ok(Ok((operation, receipt)))
        })
        .await
        .map_err(|error| match error {
            brz_mysql::MysqlError::RowNotFound => missing(),
            other => storage(other),
        })??;
    view(result.0, result.1, &cipher)
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
        let operations:Vec<SummaryOperation>=tx.fetch_all(format!("SELECT {SUMMARY_COLUMNS} FROM template_import_operations o WHERE actor_user_id=? AND project_id=? AND (SELECT COUNT(*) FROM template_import_receipts r WHERE r.operation_id=o.id)<JSON_LENGTH(manifest) ORDER BY created_at DESC,id DESC"),(user.0.id,project_id.as_str())).await?;
        let rows:Vec<OperationReceipt>=tx.fetch_all("SELECT CONVERT(r.operation_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS operation_id,CONVERT(r.step_key USING utf8mb4) COLLATE utf8mb4_unicode_ci AS step_key,CONVERT(r.kind USING utf8mb4) COLLATE utf8mb4_unicode_ci AS kind,CONVERT(r.resource_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS resource_id FROM template_import_receipts r JOIN template_import_operations o ON o.id=r.operation_id WHERE o.actor_user_id=? AND o.project_id=? AND (SELECT COUNT(*) FROM template_import_receipts completed WHERE completed.operation_id=o.id)<JSON_LENGTH(o.manifest)",(user.0.id,project_id.as_str())).await?;
        let mut receipts:HashMap<String,Vec<Receipt>>=HashMap::new();
        for row in rows {
            receipts.entry(row.operation_id).or_default().push(Receipt {
                step_key:row.step_key,kind:row.kind,resource_id:row.resource_id,
            });
        }
        Ok(Some(operations.into_iter().map(|operation| {
            let receipt=receipts.remove(&operation.id).unwrap_or_default();
            summary(operation,receipt)
        }).collect::<Vec<_>>()))
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
    let result = state.mysql.with_transaction(async |tx| {
        let operation:Option<Operation>=tx.fetch_optional(format!("SELECT {OPERATION_COLUMNS} FROM template_import_operations WHERE id=? AND actor_user_id=? AND project_id=? FOR UPDATE"),(operation_id,user.0.id,project_id.as_str())).await?;
        let Some(operation)=operation else { return Ok(None); };
        if !can_maintain(tx, project, user.0.id).await? { return Ok(None); }
        let receipt=receipts(tx, &operation.id).await?;
        Ok(Some((operation,receipt)))
    }).await.map_err(storage)?.ok_or_else(missing)?;
    view(result.0, result.1, &IntentCipher::from_env()?)
}

#[cfg(test)]
mod mysql_tests;
#[cfg(test)]
mod tests;

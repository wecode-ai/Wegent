//! Durable observation state is separate from collectors and model executions.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlError, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};

use crate::{ObservationState, auth::SessionUser, http_compat::FastApiError};
mod auth;
pub(crate) mod collector;
mod observers;
mod state;
mod target;
mod validation;

#[cfg(feature = "test-support")]
pub use state::hash as canonical_hash;

#[derive(FromMysqlRow)]
struct Account {
    id: i64,
}
#[derive(FromMysqlRow)]
struct Document {
    id: i64,
    json: Value,
}

fn failure(reason: &str) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: reason.to_owned(),
    }
}

pub async fn command<M: Mysql>(mysql: &M, owner: i64, input: &Value) -> MysqlResult<Value> {
    mysql
        .with_transaction(async |tx| command_on(tx, owner, input).await)
        .await
}

async fn command_on(
    tx: &mut impl MysqlTransaction,
    owner: i64,
    input: &Value,
) -> MysqlResult<Value> {
    let account = lock_account_on(tx, owner).await?;
    command_for_account_on(tx, account, input).await
}

async fn lock_account_on(tx: &mut impl MysqlTransaction, owner: i64) -> MysqlResult<Account> {
    // Kind has no composite unique constraint. This short parent lock also
    // serializes first creation without a process-local or expiring lock.
    let active: Option<Account> = tx
        .fetch_optional(
            "SELECT id FROM users WHERE id=? AND is_active=1 FOR UPDATE",
            (owner,),
        )
        .await?;
    active
        .filter(|row| row.id == owner)
        .ok_or_else(|| failure("observation_owner_unavailable"))
}

async fn command_for_account_on(
    tx: &mut impl MysqlTransaction,
    account: Account,
    input: &Value,
) -> MysqlResult<Value> {
    let owner = account.id;
    let rows: Vec<Document> = tx.fetch_all("SELECT id,json FROM kinds WHERE user_id=? AND kind='RuntimeObservations' AND namespace='wework' AND name='account' AND is_active=1 LIMIT 2 FOR UPDATE",(owner,)).await?;
    if rows.len() > 1 {
        return Err(failure("observation_storage_conflict"));
    }
    let mut document = rows
        .first()
        .map(|row| row.json.clone())
        .unwrap_or_else(state::empty);
    let previous = document.clone();
    let output = state::apply(&mut document, input, chrono::Utc::now().timestamp_millis())
        .map_err(failure)?;
    validation::validate(&document).map_err(failure)?;
    if document != previous {
        if let Some(row) = rows.first() {
            tx.execute("UPDATE kinds SET json=?,updated_at=NOW() WHERE id=? AND user_id=? AND kind='RuntimeObservations' AND namespace='wework' AND name='account'",(document,row.id,owner)).await?;
        } else {
            tx.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (?,'RuntimeObservations','wework','account',?,1,NOW(),NOW())",(owner,document)).await?;
        }
    }
    Ok(output)
}

fn http_failure(error: MysqlError) -> FastApiError {
    if let MysqlError::InvalidQuery { reason } = error {
        let status = if reason.ends_with("unavailable") {
            StatusCode::NOT_FOUND
        } else if reason.contains("conflict") || reason.contains("lease") {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_REQUEST
        };
        return FastApiError::detail(status, reason);
    }
    tracing::error!(%error,"Runtime observation transaction failed");
    FastApiError::internal()
}

#[brz_http_server::post("/api/runtime-observations/command")]
async fn user_command(
    #[inject(state)] app: &ObservationState,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<Value, FastApiError> {
    if body
        .get("expectedOwnerId")
        .is_some_and(|owner| owner.as_i64() != Some(i64::from(user.id)))
    {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "observation_owner_changed",
        ));
    }
    if !matches!(
        body["action"].as_str(),
        Some(
            "attach"
                | "cancel_registration"
                | "cancel"
                | "list"
                | "refresh"
                | "get_subscription"
                | "get_task_subscriptions"
                | "admit_delivery"
                | "ack_projection"
                | "observe"
                | "renew_observer"
                | "stop_observer"
        )
    ) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "invalid_observation_action",
        ));
    }
    let mut response = command(&app.mysql, i64::from(user.id), &body)
        .await
        .map_err(http_failure)?;
    response["ownerId"] = json!(user.id);
    Ok(response)
}

#[brz_http_server::post("/api/internal/runtime-observations/command")]
async fn worker_command(
    #[inject(state)] app: &ObservationState,
    #[auth] _service: crate::internal_auth::InternalService,
    body: Value,
) -> Result<Value, FastApiError> {
    if !matches!(
        body["action"].as_str(),
        Some(
            "claim"
                | "renew"
                | "commit"
                | "fail"
                | "claim_delivery"
                | "renew_delivery"
                | "ack_delivery"
        )
    ) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "invalid_observation_worker_action",
        ));
    }
    let owner = body["userId"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            FastApiError::detail(StatusCode::BAD_REQUEST, "observation_owner_required")
        })?;
    let mut response = command(&app.mysql, owner, &body)
        .await
        .map_err(http_failure)?;
    if body["action"] == "claim" && response["lease"].is_object() {
        response["collectorToken"] = json!(collector_token(app, owner, &response)?);
    }
    Ok(response)
}

pub(crate) fn collector_token(
    app: &ObservationState,
    owner: i64,
    claim: &Value,
) -> Result<String, FastApiError> {
    auth::issue(
        &app.auth,
        owner,
        claim["observation"]["id"]
            .as_str()
            .ok_or_else(FastApiError::internal)?,
        claim["lease"]["id"]
            .as_str()
            .ok_or_else(FastApiError::internal)?,
    )
}

#[brz_http_server::post("/api/runtime-observations/collector")]
async fn collector_command(
    #[inject(state)] app: &ObservationState,
    #[auth] collector: auth::Collector,
    body: Value,
) -> Result<Value, FastApiError> {
    if !body.is_object() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "invalid_observation_input",
        ));
    }
    if !matches!(
        body["action"].as_str(),
        Some("read_lease" | "renew" | "commit" | "fail")
    ) {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "observation_collector_scope_denied",
        ));
    }
    let mut input = body;
    input["observationId"] = json!(collector.observation_id);
    input["leaseId"] = json!(collector.lease_id);
    let mut response = command(&app.mysql, collector.user_id, &input)
        .await
        .map_err(http_failure)?;
    response["ownerId"] = json!(collector.user_id);
    Ok(response)
}

#[brz_http_server::get("/api/internal/runtime-observations/accounts")]
async fn accounts(
    #[inject(state)] app: &ObservationState,
    #[auth] _service: crate::internal_auth::InternalService,
) -> Result<Value, FastApiError> {
    Ok(json!({"items":active_accounts(&app.mysql).await.map_err(http_failure)?}))
}

pub(crate) async fn active_accounts<M: Mysql>(mysql: &M) -> MysqlResult<Vec<i64>> {
    #[derive(FromMysqlRow)]
    struct Owner {
        user_id: i64,
    }
    let rows: Vec<Owner> = mysql.fetch_all("SELECT kinds.user_id FROM kinds JOIN users ON users.id=kinds.user_id WHERE kinds.kind='RuntimeObservations' AND kinds.namespace='wework' AND kinds.name='account' AND kinds.is_active=1 AND users.is_active=1 ORDER BY kinds.user_id",()).await?;
    Ok(rows.into_iter().map(|row| row.user_id).collect())
}

#[cfg(test)]
mod tests;

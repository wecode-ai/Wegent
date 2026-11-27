// SPDX-License-Identifier: Apache-2.0

use brz_http_server::StatusCode;
use brz_mysql::{MysqlError, MysqlTransaction};
use hmac::Mac;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{AGENT_KIND, database, hex, invalid, mac, verify};
use crate::auth::SessionUser;
use crate::background_jobs::project::{
    authority,
    store::{self, DATABASE_NOW_SQL},
};
use crate::cloud_projects::{authorized_project, members};
use crate::http_compat::FastApiError;
use crate::state::AppState;

#[derive(Deserialize)]
struct Registration {
    name: String,
    #[serde(flatten)]
    transport: Transport,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", deny_unknown_fields)]
enum Transport {
    Hook { hook: super::hook::Hook },
    Worker,
}

#[brz_http_server::post("/api/v1/cloud-projects/:project_id/external-agents", api_log = false)]
async fn create(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    project_id: i64,
    body: Registration,
) -> Result<Value, FastApiError> {
    let actor = user.0.id;
    let (_, role) = authorized_project(&state.mysql, project_id, actor)
        .await
        .map_err(database)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found"))?;
    if !members::has_permission(role, "Maintainer") {
        return Err(FastApiError::forbidden(
            "Project administration is required",
        ));
    }
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(invalid("Enter an agent name up to 100 characters"));
    }
    let project = project_id.to_string();
    let agent = store::id();
    let (mode, private, credential) = match body.transport {
        Transport::Worker => {
            let mut random = [0u8; 32];
            getrandom::getrandom(&mut random).map_err(|_| FastApiError::internal())?;
            let token = hex(&random);
            let hash = hex(
                &mac(&state.auth.jwt_key, "external-worker", &[&agent, &token])
                    .finalize()
                    .into_bytes(),
            );
            (
                "worker",
                json!({"credential": hash}),
                Some(format!("{agent}.{token}")),
            )
        }
        Transport::Hook { hook } => {
            hook.validate(&allowed_origins()).map_err(invalid)?;
            callback_base()
                .ok_or_else(|| invalid("The server has no public callback URL configured"))?;
            let serialized = serde_json::to_string(&hook).map_err(|_| FastApiError::internal())?;
            let encrypted =
                super::hook::protect(&state.auth.jwt_key, &agent, serialized.as_bytes())
                    .ok_or_else(FastApiError::internal)?;
            ("hook", json!({"hook": encrypted}), None)
        }
    };
    state.mysql.with_transaction(async |tx| {
        let workspace = authority::parent_on(&mut &mut *tx, &project).await
            .map_err(|_| MysqlError::RowNotFound)?;
        store::insert(tx, "chat_agent", json!({
            "id": agent, "cloud_project_id": project, "name": name, "title": name,
            "created_by_user_id": actor, "updated_by_user_id": actor, "status":"active",
            "metadata": {"runtime":"external", "execution_environment":"cloud",
                "external_transport":mode, "visibility":"creator_admin", "authorization_version":2}
        })).await?;
        store::insert(tx, AGENT_KIND, json!({
            "id": config_id(&agent), "cloud_project_id": project,
            "loop_item_id":agent, "created_by_user_id": actor, "status":"active", "metadata":private
        })).await?;
        tx.execute("INSERT INTO resource_members
            (resource_type,resource_id,entity_type,entity_id,role,status,invited_by_user_id,requested_at,created_at,updated_at)
            VALUES ('Workspace',?,'project_agent',?,'Developer','approved',?,NOW(),NOW(),NOW())",
            (workspace, agent.as_str(), actor)).await?;
        Ok(())
    }).await.map_err(database)?;
    Ok(json!({"id":agent,"workerToken":credential}))
}

#[brz_http_server::get("/api/v1/cloud-projects/:project_id/external-agents/:agent_id/connection")]
async fn connection(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    project_id: i64,
    agent_id: &str,
) -> Result<Value, FastApiError> {
    let (_, role) = authorized_project(&state.mysql, project_id, user.0.id)
        .await
        .map_err(database)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found"))?;
    if !members::has_permission(role, "Maintainer") {
        return Err(FastApiError::forbidden(
            "Project administration is required",
        ));
    }
    let project = project_id.to_string();
    let recent: Option<(i64,)> = state
        .mysql
        .fetch_optional(
            format!(
                "SELECT CASE WHEN updated_at > ({DATABASE_NOW_SQL})-INTERVAL 35 SECOND
           AND JSON_EXTRACT(metadata,'$.hasConnected') = 1 THEN 1 ELSE 0 END
         FROM loop_items WHERE id=? AND cloud_project_id=? AND resource_type='external_agent'
         AND status='active' AND JSON_EXTRACT(metadata,'$.credential') IS NOT NULL"
            ),
            (config_id(agent_id), project),
        )
        .await
        .map_err(database)?;
    let connected = recent
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Worker not found"))?
        .0
        != 0;
    Ok(json!({"connected":connected}))
}

pub(super) async fn mark_connected(
    state: &AppState,
    config: &store::Node,
) -> Result<(), FastApiError> {
    if config.metadata.0["hasConnected"] == 1 && config.version > 1 {
        state
            .mysql
            .execute(
                format!(
                    "UPDATE loop_items SET updated_at=({DATABASE_NOW_SQL}) WHERE id=?
             AND updated_at < ({DATABASE_NOW_SQL})-INTERVAL 8 SECOND"
                ),
                (config.id.as_str(),),
            )
            .await
            .map_err(database)?;
    } else {
        state
            .mysql
            .execute(
                format!(
                    "UPDATE loop_items SET updated_at=({DATABASE_NOW_SQL}),version=2,
             metadata=JSON_SET(metadata,'$.hasConnected',1)
             WHERE id=? AND version=1"
                ),
                (config.id.as_str(),),
            )
            .await
            .map_err(database)?;
    }
    Ok(())
}

pub(super) fn config_id(agent: &str) -> String {
    format!("external-config:{agent}")
}

pub(super) async fn worker_authorized(state: &AppState, credential: &str) -> Option<store::Node> {
    let (id, token) = credential.split_once('.')?;
    if id.len() > 20 || !id.bytes().all(|byte| byte.is_ascii_digit()) || token.len() != 64 {
        return None;
    }
    let config = store::get(&state.mysql, AGENT_KIND, &config_id(id))
        .await
        .ok()??;
    let signature = config.metadata.0["credential"].as_str()?;
    if !verify(
        mac(&state.auth.jwt_key, "external-worker", &[id, token]),
        signature,
    ) {
        return None;
    }
    active_agent(state, &config, config.created_by_user_id).await?;
    Some(config)
}

pub(super) async fn active_agent(
    state: &AppState,
    config: &store::Node,
    actor: i64,
) -> Option<store::Node> {
    let agent = authority::agent(
        &state.mysql,
        &config.cloud_project_id,
        &config.loop_item_id,
        actor,
        true,
    )
    .await
    .ok()?;
    (config.status == "active" && agent.metadata.0["runtime"] == "external").then_some(agent)
}

pub(super) fn allowed_origins() -> String {
    std::env::var("WEWORK_EXTERNAL_HOOK_ORIGINS").unwrap_or_default()
}

pub(super) fn callback_base() -> Option<url::Url> {
    let url = url::Url::parse(&std::env::var("WEGENT_BACKEND_PUBLIC_URL").ok()?).ok()?;
    (super::hook::safe_scheme(&url)
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

#[brz_http_server::post("/api/v1/external-agent-replies", api_log = false, access = public)]
async fn callback(
    #[inject(state)] state: &AppState,
    #[header("authorization")] authorization: Option<&str>,
    body: super::protocol::ReplyEvent,
) -> Result<Value, FastApiError> {
    let token = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    let signature = mac(
        &state.auth.jwt_key,
        "external-hook-callback",
        &[&body.invocation_id, &body.delivery_id],
    );
    if !verify(signature, token) {
        return Err(FastApiError::detail(
            StatusCode::UNAUTHORIZED,
            "Invalid callback credential",
        ));
    }
    super::queue::reply(state, None, body).await
}

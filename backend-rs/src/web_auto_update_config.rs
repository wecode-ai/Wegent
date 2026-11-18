// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Knowledge-base-level web auto-update configuration endpoints.
//!
//! `PUT /api/knowledge-bases/{id}/web-auto-update` — enable or disable the
//! scheduled web-document refresh for a knowledge base. The switch is stored
//! in `kinds.json` under `$.spec.webAutoUpdateEnabled` (the same location
//! DingTalk auto-sync uses for `$.spec.dingtalkAutoSyncEnabled`).
//!
//! `GET /api/knowledge-bases/{id}/web-auto-update` — read the current state.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::knowledge_documents_content::access;
use crate::state::AppState;

/// `PUT /api/knowledge-bases/{id}/web-auto-update`.
#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
struct WebAutoUpdateRequest {
    enabled: bool,
}

/// Response body for both GET and PUT.
#[derive(Debug, Serialize)]
struct WebAutoUpdateResponse {
    enabled: bool,
}

/// PUT /api/knowledge-bases/{kb_id}/web-auto-update.
#[brz_http_server::put("/api/knowledge-bases/:kb_id/web-auto-update")]
async fn set_web_auto_update(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: crate::auth::SessionUser,
    kb_id: i64,
    body: Value,
) -> Result<WebAutoUpdateResponse, FastApiError> {
    let enabled = body
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| FastApiError::unhandled())?;
    let user_id = i64::from(user.id);
    require_manage(state, kb_id, user_id).await?;
    let json_bool = if enabled { "true" } else { "false" };
    state
        .mysql
        .execute(
            "UPDATE kinds SET json = JSON_SET(json, '$.spec.webAutoUpdateEnabled', CAST(? AS JSON)), updated_at = NOW() WHERE id = ? AND kind = 'KnowledgeBase' AND is_active = true",
            (json_bool, kb_id),
        )
        .await
        .map_err(|_| FastApiError::unhandled())?;
    Ok(WebAutoUpdateResponse { enabled })
}

/// GET /api/knowledge-bases/{kb_id}/web-auto-update.
#[brz_http_server::get("/api/knowledge-bases/:kb_id/web-auto-update")]
async fn get_web_auto_update(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: crate::auth::SessionUser,
    kb_id: i64,
) -> Result<WebAutoUpdateResponse, FastApiError> {
    let user_id = i64::from(user.id);
    let Some(kb) = access::knowledge_base_record(&state.mysql, kb_id)
        .await
        .map_err(|_| FastApiError::unhandled())?
    else {
        return Err(FastApiError::unhandled());
    };
    let has_access = access::knowledge_base_access(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &kb,
        user_id,
    )
    .await
    .map_err(|_| FastApiError::unhandled())?;
    if !has_access {
        return Err(FastApiError::unhandled());
    }
    let enabled = kb
        .kinds_json
        .to_value()
        .pointer("/spec/webAutoUpdateEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(WebAutoUpdateResponse { enabled })
}

async fn require_manage(
    state: &AppState,
    kb_id: i64,
    user_id: i64,
) -> Result<(), FastApiError> {
    let Some(kb) = access::knowledge_base_record(&state.mysql, kb_id)
        .await
        .map_err(|_| FastApiError::unhandled())?
    else {
        return Err(FastApiError::unhandled());
    };
    let has_access = access::knowledge_base_access(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &kb,
        user_id,
    )
    .await
    .map_err(|_| FastApiError::unhandled())?;
    if !has_access {
        return Err(FastApiError::unhandled());
    }
    let can_manage = access::can_manage_knowledge_base_documents(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        kb_id,
        user_id,
    )
    .await
    .map_err(|_| FastApiError::unhandled())?;
    if !can_manage {
        return Err(FastApiError::unhandled());
    }
    Ok(())
}

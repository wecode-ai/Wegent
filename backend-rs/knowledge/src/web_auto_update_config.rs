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

use brz_mysql::{FromMysqlRow, Mysql, MysqlTransaction};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::KnowledgeState;
use crate::http_compat::FastApiError;
use crate::knowledge_documents_content::access;

/// Response body for both GET and PUT.
#[derive(Debug, Serialize)]
struct WebAutoUpdateResponse {
    enabled: bool,
}

/// PUT /api/knowledge-bases/{kb_id}/web-auto-update.
#[brz_http_server::put("/api/knowledge-bases/:kb_id/web-auto-update")]
async fn set_web_auto_update(
    #[inject(state)] state: &Arc<KnowledgeState>,
    #[auth] user: crate::auth::SessionUser,
    kb_id: i64,
    body: Value,
) -> Result<WebAutoUpdateResponse, FastApiError> {
    let enabled = enabled_from_body(&body)?;
    let user_id = i64::from(user.id);
    require_manage(state, kb_id, user_id).await?;
    save_web_auto_update(&state.mysql, kb_id, enabled).await?;
    Ok(WebAutoUpdateResponse { enabled })
}

async fn save_web_auto_update(
    mysql: &impl Mysql,
    kb_id: i64,
    enabled: bool,
) -> Result<(), FastApiError> {
    let json_bool = if enabled { "true" } else { "false" };
    #[derive(FromMysqlRow)]
    struct ActiveKnowledgeBase {
        id: i64,
    }
    let exists = mysql.with_transaction(async |transaction| {
        let active: Option<ActiveKnowledgeBase> = transaction.fetch_optional(
            "SELECT id FROM kinds WHERE id=? AND kind='KnowledgeBase' AND is_active=true FOR UPDATE", (kb_id,)
        ).await?;
        let Some(active) = active else { return Ok(false); };
        transaction.execute(
            "UPDATE kinds SET json = JSON_SET(json, '$.spec.webAutoUpdateEnabled', CAST(? AS JSON)), updated_at = NOW() WHERE id = ? AND kind = 'KnowledgeBase' AND is_active = true",
            (json_bool, active.id),
        ).await?;
        Ok(true)
    }).await
        .map_err(|_| FastApiError::unhandled())?;
    if !exists {
        return Err(FastApiError::not_found("Knowledge base not found"));
    }
    Ok(())
}

fn enabled_from_body(body: &Value) -> Result<bool, FastApiError> {
    body.get("enabled").and_then(Value::as_bool).ok_or_else(|| {
        FastApiError::detail(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "enabled must be a boolean",
        )
    })
}

/// GET /api/knowledge-bases/{kb_id}/web-auto-update.
#[brz_http_server::get("/api/knowledge-bases/:kb_id/web-auto-update")]
async fn get_web_auto_update(
    #[inject(state)] state: &Arc<KnowledgeState>,
    #[auth] user: crate::auth::SessionUser,
    kb_id: i64,
) -> Result<WebAutoUpdateResponse, FastApiError> {
    let user_id = i64::from(user.id);
    let Some(kb) = access::knowledge_base_record(&state.mysql, kb_id)
        .await
        .map_err(|_| FastApiError::unhandled())?
    else {
        return Err(FastApiError::not_found("Knowledge base not found"));
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
        return Err(FastApiError::forbidden("Access denied"));
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
    state: &KnowledgeState,
    kb_id: i64,
    user_id: i64,
) -> Result<(), FastApiError> {
    let Some(kb) = access::knowledge_base_record(&state.mysql, kb_id)
        .await
        .map_err(|_| FastApiError::unhandled())?
    else {
        return Err(FastApiError::not_found("Knowledge base not found"));
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
        return Err(FastApiError::forbidden("Access denied"));
    }
    // P1-5: require Maintainer or Creator to change KB-level settings
    // (Developer is insufficient). Reuse the shared permission resolver.
    let facts = access::resolve_permission_facts(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &kb,
        user_id,
    )
    .await
    .map_err(|_| FastApiError::unhandled())?;
    let can_manage = facts.has_access
        && (facts.is_creator
            || facts
                .role
                .as_deref()
                .is_some_and(|role| access::has_permission(role, "Maintainer")));
    if !can_manage {
        return Err(FastApiError::forbidden("Access denied"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn setting_write_handles_disappeared_kb_and_idempotent_zero_row_updates() {
        use wegent_backend_test_support::mysql_rows::{MysqlRows, Value};
        for (active, enabled) in [(false, true), (true, false), (true, true)] {
            let fixture = MysqlRows::start_results(move |sql| {
                if sql.starts_with("SELECT id FROM kinds") {
                    let row = vec![("id", Value::I64(1))];
                    (row.clone(), if active { vec![row] } else { vec![] })
                } else {
                    (vec![], vec![])
                }
            })
            .await;
            // The protocol fixture returns zero affected rows for writes.
            let result = save_web_auto_update(&fixture.mysql, 1, enabled).await;
            if active {
                result.unwrap();
            } else {
                assert_eq!(
                    result.unwrap_err().status(),
                    brz_http_server::StatusCode::NOT_FOUND
                );
                assert!(
                    !fixture
                        .queries()
                        .iter()
                        .any(|sql| sql.starts_with("UPDATE kinds"))
                );
            }
        }
    }

    #[test]
    fn switch_requires_an_explicit_json_boolean() {
        for enabled in [false, true] {
            assert_eq!(
                enabled_from_body(&json!({"enabled": enabled})).unwrap(),
                enabled
            );
        }
        for body in [
            json!({}),
            json!({"enabled": "false"}),
            json!({"enabled": 0}),
            json!({"enabled": null}),
            json!([]),
            Value::Null,
        ] {
            assert_eq!(
                enabled_from_body(&body).unwrap_err().status(),
                brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }
}

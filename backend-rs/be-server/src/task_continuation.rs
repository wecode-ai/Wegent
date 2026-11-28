// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use brz_mysql::{FromMysqlRow, Json};
use serde_json::{Value, json};

use crate::device_identity::resolve_runtime_route_identity;
use crate::task_pipeline_stage_info_repo::get_active_task;
use crate::{http_compat::FastApiError, state::AppState, task_routing::ByTaskId};
use wegent_identity::runtime_model_auth::RuntimeModelUser;

#[derive(FromMysqlRow)]
struct SessionEvidence {
    team_id: i64,
    session: Json<Value>,
    bot_ids: Json<Vec<i64>>,
}

impl SessionEvidence {
    fn native_thread(&self) -> Option<(&'static str, &str)> {
        let session = &self.session.0;
        let bot = session.get("botId").or_else(|| session.get("bot_id"))?;
        let bot = bot.as_i64().or_else(|| bot.as_str()?.parse().ok())?;
        if bot <= 0 || !self.bot_ids.0.contains(&bot) {
            return None;
        }
        let (shell, key, alias) = match session["agent"].as_str()? {
            "Codex" => ("Codex", "threadId", "thread_id"),
            "ClaudeCode" => ("ClaudeCode", "sessionId", "session_id"),
            _ => return None,
        };
        let id = session.get(key).or_else(|| session.get(alias))?.as_str()?;
        (!id.is_empty()
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')))
        .then_some((shell, id))
    }
}

#[derive(Default, serde::Deserialize)]
struct ContinuationQuery {
    #[serde(default)]
    include_history: bool,
}

#[brz_http_server::get("/api/tasks/:task_id/wework-continuation")]
async fn task_continuation(
    #[inject(state)] state: &AppState,
    task_id: i64,
    #[auth] owner: RuntimeModelUser,
    query: brz_http_server::Query<ContinuationQuery>,
) -> Result<Value, FastApiError> {
    let owner = i64::from(owner.0.id);
    let mut context = continuation_for(state, task_id, owner).await?;
    // Platform turns may use a named Bot Home outside the standalone workbench.
    if query.include_history {
        let detail = wegent_task_views::task_detail_api::assembly::build_task_detail(
            &crate::task_view_state::build(state),
            task_id,
            owner,
            None,
            false,
        )
        .await
        .map_err(|_| FastApiError::internal())?
        .body;
        context["messages"] = Value::Array(detail.into_subtask_messages().filter_map(|row| {
            if row.status == "DELETE" { return None; }
            let (role, content) = match row.role.as_str() {
                "USER" => ("user", row.prompt.unwrap_or_default()),
                "ASSISTANT" => ("assistant", crate::socketio::chat_references::assistant_text(&serde_json::from_str(row.result.get()).unwrap_or_default())),
                _ => return None,
            };
            Some(json!({"role":role,"content":content, "id":format!("platform-{role}-{}",row.id),
                "subtaskId":row.id.to_string(),"status":row.status.to_ascii_lowercase(),"createdAt":row.created_at}))
        }).collect());
    }
    Ok(context)
}

pub(crate) async fn continuation_for(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> Result<Value, FastApiError> {
    let missing = || FastApiError::not_found("Task continuation unavailable");
    let task = get_active_task(&*state.task_store, task_id)
        .await
        .map_err(dependency)?
        .filter(|task| task.user_id == user_id)
        .ok_or_else(missing)?;
    let document = task.json.to_value();
    let spec = &document["spec"];
    let bound = spec["device_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(missing)?;
    let device = resolve_runtime_route_identity(&state.mysql, user_id, bound)
        .await
        .map_err(dependency)?
        .ok_or_else(missing)?;
    let table = state.task_store.table_templates().subtasks;
    // Only this owner's device-dispatched assistant turns carry native session evidence.
    let row: SessionEvidence = state
        .mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(
            format!(
                "SELECT team_id, JSON_EXTRACT(result, '$.executor_session') AS session, bot_ids \
            FROM {table} WHERE task_id = ? AND user_id = ? AND `role` = 'ASSISTANT' \
            AND BINARY executor_namespace = ? AND BINARY executor_name IN (?, ?) \
            AND status <> 'DELETE' AND executor_deleted_at = 0 \
            AND JSON_TYPE(JSON_EXTRACT(result, '$.executor_session')) = 'OBJECT' \
            ORDER BY message_id DESC, id DESC LIMIT 1"
            ),
            (
                task_id,
                user_id,
                format!("user-{user_id}"),
                format!("device-{}", device.runtime_device_id),
                format!("device-{bound}"),
            ),
        )
        .await
        .map_err(dependency)?
        .ok_or_else(missing)?;
    let (shell, thread) = row.native_thread().ok_or_else(missing)?;
    let labels = &document["metadata"]["labels"];
    let model_options = labels["modelOptions"]
        .as_str()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    Ok(json!({
        "team_id": row.team_id, "model_id": labels["modelId"], "model_type": labels["forceOverrideBotModelType"], "model_options": model_options,
        "task_id": task_id, "user_id": user_id, "device_id": device.runtime_device_id,
        "thread_id": thread, "shell_type": shell, "title": spec["title"].as_str().unwrap_or_default(),
        "workspace_path": spec.pointer("/execution/workspace/path").and_then(Value::as_str).unwrap_or_default(),
    }))
}

fn dependency(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "Could not load task continuation");
    FastApiError::internal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_thread_requires_dispatch_bot_and_matching_native_identifier() {
        let evidence = |session| SessionEvidence {
            team_id: 4,
            session: Json(session),
            bot_ids: Json(vec![7]),
        };
        assert_eq!(
            evidence(json!({"agent":"Codex","threadId":"abc","botId":"7"})).native_thread(),
            Some(("Codex", "abc"))
        );
        assert_eq!(
            evidence(json!({"agent":"ClaudeCode","session_id":"b-1","bot_id":7})).native_thread(),
            Some(("ClaudeCode", "b-1"))
        );
        for session in [
            json!({"agent":"Codex","threadId":"abc","botId":"8"}),
            json!({"agent":"ClaudeCode","threadId":"abc","botId":"7"}),
            json!({"agent":"Codex","threadId":"../abc","botId":"7"}),
            json!({"agent":"Codex","threadId":"abc"}),
        ] {
            assert!(evidence(session).native_thread().is_none());
        }
    }
}

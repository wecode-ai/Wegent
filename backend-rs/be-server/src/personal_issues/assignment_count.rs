//! Lightweight badge for outstanding human Issue assignments.
use super::*;
use brz_redis::Redis;

#[derive(FromMysqlRow, Serialize)]
struct AssignmentCount {
    count: i64,
}

#[brz_http_server::get("/api/v1/me/issue-assignment-count")]
async fn assignment_count(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<AssignmentCount, FastApiError> {
    let user_id = user.0.id;
    let visible = crate::cloud_projects::project_access_statement(user_id, None, None);
    let invited = collaborator_exists("issue.id", "?");
    state.mysql.fetch_one(
        format!(
            "SELECT COUNT(*) AS count FROM loop_items AS issue
             WHERE issue.assignee_user_id=? AND issue.resource_type='task'
             AND (issue.deleted_at IS NULL OR issue.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))
             AND issue.status NOT IN ('completed','cancelled','archived')
             AND (
                 ((issue.cloud_project_id IS NULL OR issue.cloud_project_id='') AND
                  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(issue.metadata,'$.archived')),'false')='false' AND
                  (issue.created_by_user_id=? OR {invited}))
                 OR issue.cloud_project_id IN (SELECT loop_items_id FROM ({visible}) AS visible)
             )"
        ),
        (user_id, user_id, user_id),
    ).await.map_err(internal)
}

pub(super) async fn invalidate(state: &AppState, user_id: i32) {
    use crate::socketio_emit::SOCKETIO_CHANNEL;

    let room = format!("wework-runtime:user:{user_id}");
    let frame = json!({"event":"wework.issue.assignments.changed","payload":{"userId":user_id}});
    crate::socketio::runtime::deliver_local_emit(
        "/wework-runtime",
        "runtime:event",
        &room,
        None,
        &frame,
    )
    .await;
    if let Some(redis) = &state.redis {
        let message = crate::socketio_emit::emit_message(
            "runtime:event",
            &serde_json::to_string(&json!([frame])).expect("JSON value"),
            "/wework-runtime",
            &room,
        );
        if let Err(error) = redis.publish(SOCKETIO_CHANNEL, message).await {
            tracing::warn!(%error, "Issue assignment count invalidation failed");
        }
    }
}

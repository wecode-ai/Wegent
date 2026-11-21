//! Publish committed Issue activity changes to their existing recipients.

use super::*;

pub(in crate::socketio) async fn publish_item_change(
    state: &crate::state::AppState,
    runtime: &std::sync::Arc<crate::socketio::runtime::SocketRuntime>,
    item_id: &str,
    actor_user_id: i64,
) {
    publish_item_change_with_reason(state, runtime, item_id, actor_user_id, "project_chat").await;
}

pub(in crate::socketio) async fn publish_item_change_with_reason(
    state: &crate::state::AppState,
    runtime: &crate::socketio::runtime::SocketRuntime,
    item_id: &str,
    actor_user_id: i64,
    reason: &str,
) {
    let recipients = state
        .mysql
        .with_transaction(async |transaction| {
            changed_item_recipients(transaction, item_id, actor_user_id).await
        })
        .await;
    let Ok(Some(recipients)) = recipients else {
        return;
    };
    let payload = json!({
        "projectId": recipients.project_id,
        "itemId": item_id,
        "version": recipients.version,
        "reason": reason,
    });
    for user_id in recipients.users {
        let room = format!("wework-runtime:user:{user_id}");
        if let Err(error) = runtime
            .emitters()
            .loop_item_changed(user_id, &payload)
            .await
        {
            tracing::warn!(%error, room, "loop item changed local delivery failed");
        }
        crate::socketio::device_lifecycle::publish_room_event(
            state,
            crate::socketio::device_runtime_event::LOOP_ITEM_CHANGED_EVENT,
            &payload,
            crate::socketio::device_runtime_event::RUNTIME_NAMESPACE,
            &room,
        )
        .await;
    }
}

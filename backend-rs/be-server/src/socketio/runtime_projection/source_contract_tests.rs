//! Shared live projection contracts.
use super::*;

#[test]
fn live_projection_keeps_an_opaque_source_for_viewer_authorized_history_reads() {
    let message = completed_message(
        json!({"private_prompt":"private input","kind":"task_ai_subagent"}),
        "completed",
        "trigger",
        "project",
        "issue",
    );
    for view in [
        projected_view(&message),
        projected_delta_view(&message, "private output"),
    ] {
        let shared = crate::socketio::project_chat_messages::shared_message_payload(&view);
        assert_eq!(shared["traceState"], "restricted");
        let trace = shared["traceRef"]
            .as_str()
            .expect("persisted source reference");
        assert_eq!(trace.len(), 64);
        assert!(!trace.contains(&message.runtime_task_id));
        assert!(shared["runtimeAddress"].is_null());
        assert_eq!(shared["content"], "");
        assert!(shared["metadata"].get("private_prompt").is_none());
        assert_eq!(shared["traceRef"], message.view()["traceRef"]);
    }
    let mut unavailable = message.clone();
    unavailable.runtime_device_id.clear();
    assert!(projected_view(&unavailable)["traceRef"].is_null());
    assert_eq!(
        projected_view(&unavailable)["traceState"],
        "history-unavailable"
    );
    unavailable.runtime_device_id = "another-device".into();
    assert_ne!(
        projected_view(&unavailable)["traceRef"],
        projected_view(&message)["traceRef"]
    );
}

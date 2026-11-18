use super::*;
use chrono::DateTime;

fn project_sources(
    project: &str,
    issue: &str,
    sources: Vec<ParticipationSource>,
    names: &BTreeMap<i32, String>,
    viewer_user_id: i32,
) -> Vec<AssistantParticipation> {
    project_source_pairs(project, issue, sources, names, viewer_user_id)
        .into_iter()
        .map(|(_, participation)| participation)
        .collect()
}

fn source(id: &str) -> ParticipationSource {
    ParticipationSource {
        source_kind: "binding".into(),
        source_id: id.into(),
        owner_user_id: 7,
        conversation_id: Some("stand-in-chat-7-role-review".into()),
        role_id: None,
        available: 1,
        device_id: Some("device".into()),
        task_id: Some("task".into()),
        backend_task_id: None,
        source_created_at: DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
    }
}

#[test]
fn repeated_sources_and_reruns_have_identical_identity_without_copied_content() {
    let names = BTreeMap::from([(7, "jiangyang7".to_string())]);
    let once = project_sources("p", "i", vec![source("one")], &names, 7);
    let twice = project_sources("p", "i", vec![source("one"), source("one")], &names, 7);
    assert_eq!(once, twice);
    let value = serde_json::to_value(&once).unwrap();
    assert!(value[0].get("transcript").is_none());
    assert!(value[0].get("runtimeAddress").is_none());
    assert_eq!(value[0]["roleId"], "review");
    assert_eq!(value[0]["ownerDisplayName"], "jiangyang7");
}

#[test]
fn missing_history_is_explicit_and_never_uses_another_available_source() {
    let mut missing = source("old-missing");
    missing.available = 0;
    let records = project_sources(
        "p",
        "i",
        vec![missing, source("new-available")],
        &BTreeMap::new(),
        7,
    );
    let old = records
        .iter()
        .find(|item| item.source.id == "old-missing")
        .unwrap();
    assert_eq!(old.history_state, "history-unavailable");
    assert_eq!(old.source.id, "old-missing");
}

#[test]
fn identity_includes_role_endpoint_and_exact_source() {
    let names = BTreeMap::new();
    let review = project_sources("p", "i", vec![source("one")], &names, 7);
    let mut general = source("one");
    general.conversation_id = Some("stand-in-chat-7-primary".into());
    let general = project_sources("p", "i", vec![general], &names, 7);
    assert_ne!(review[0].id, general[0].id);
}

#[test]
fn another_member_sees_a_restricted_source_without_a_runtime_address() {
    let names = BTreeMap::from([(7, "jiangyang7".to_string())]);
    let records = project_sources("p", "i", vec![source("one")], &names, 8);
    assert_eq!(records[0].history_state, "restricted");
    assert!(records[0].conversation_id.is_none());
    assert!(
        !serde_json::to_string(&records)
            .unwrap()
            .contains("stand-in-chat")
    );
    assert!(records[0].trace_ref.is_some());
    assert!(records[0].workroom_ref.is_some());
}

#[test]
fn persisted_participation_is_scoped_to_its_exact_project_and_issue() {
    let metadata = json!({
        "project_id":"p",
        "issue_id":"i",
        "owner_user_id":7,
        "owner_display_name":"jiangyang7",
        "role_id":"review",
        "endpoint_ref":"runtime:7:review",
        "conversation_id":"stand-in-chat-7-role-review",
        "source":{"kind":"binding","id":"binding-1"},
        "workroom_ref":{"kind":"endpoint","id":"runtime:7:review"},
        "trace_ref":"trace",
        "history_state":"unverified",
        "audit_source":"recorded"
    });
    let mut stored = stored_participation("participation", &metadata, "p", "i").unwrap();
    assert_eq!(stored.owner_user_id, 7);
    assert_eq!(stored.source.id, "binding-1");
    hide_private_conversation(&mut stored, 8);
    assert!(stored.conversation_id.is_none());
    assert!(stored_participation("participation", &metadata, "other", "i").is_none());
}

#[test]
fn managed_sources_use_verified_backend_tasks_without_inventing_a_device() {
    let mut source = source("managed");
    source.device_id = Some(String::new());
    source.backend_task_id = Some(42);
    let target = participation_target(&source);
    assert!(target.runtime_address.is_none());
    let backend = target.backend_task.unwrap();
    assert_eq!(backend.task_id, 42);
    assert!(backend.execution_url.ends_with("/chat?taskId=42"));
    source.available = 0;
    let target = participation_target(&source);
    assert!(target.runtime_address.is_none());
    assert!(target.backend_task.is_none());
}

#[tokio::test]
async fn every_source_is_scoped_to_the_exact_project_issue_and_owner() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    participation_sources(&mysql, "project", "issue", 7)
        .await
        .unwrap();
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    let sql = &queries[0].sql;
    assert!(sql.contains("cloud_project_id=?"));
    assert!(sql.contains("loop_item_id=? AND task_user_id=?"));
    assert!(sql.contains("executor_owner_user_id=?"));
    assert!(sql.contains("m.project_id=? AND m.task_id=?"));
    assert!(sql.contains("a.resource_type='chat_agent'"));
    assert!(
        sql.contains(
            "'message', m.message_id, ?, NULLIF(m.runtime_task_id,'') AS conversation_id,"
        )
    );
    assert!(!sql.contains("SELECT content"));
    assert!(!sql.contains("wework_transcripts"));
    assert!(!sql.contains("m.sender_id=CAST(? AS CHAR)"));
    assert_eq!(sql.matches("COLLATE utf8mb4_unicode_ci AS").count(), 6);
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

#[test]
fn knowledge_history_resolves_whole_and_scoped_bindings_without_changing_them() {
    let cases = [
        (
            "knowledge",
            json!({"knowledgeBaseRefs": [{"id": 7}], "knowledgeBaseScopes": [{"id": 8}]}),
            Some(7),
        ),
        (
            "knowledge",
            json!({"knowledgeBaseRefs": [], "knowledgeBaseScopes": [{"id": 8, "scopeRestricted": true, "explicitDocumentIds": [11]}]}),
            Some(8),
        ),
        (
            "knowledge",
            json!({"knowledgeBaseScopes": [{"id": 8, "folderIds": [12]}]}),
            Some(8),
        ),
        ("knowledge", json!({}), None),
        ("chat", json!({"knowledgeBaseScopes": [{"id": 8}]}), None),
    ];
    for (task_type, spec, expected) in cases {
        let json = json!({"metadata": {"labels": {"taskType": task_type}}, "spec": spec});
        let now = chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc();
        let task = TaskCandidateRow {
            id: 1,
            user_id: 1,
            json: json.clone(),
            created_at: now,
            updated_at: now,
            project_id: None,
            client_origin: None,
            is_group_chat: false,
        };
        let tasks = [task];
        let output = project_lite_tasks(
            &tasks,
            &TeamData::default(),
            &HashMap::new(),
            &HashMap::new(),
            GroupChatRule::SpecOnly,
        );
        assert_eq!(output[0].knowledge_base_id, expected);
        assert_eq!(tasks[0].json, json);
    }
}

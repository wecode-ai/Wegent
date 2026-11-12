// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn superseding_a_turn_removes_both_request_and_native_identities() {
    for source_id in ["request-turn", "native-turn"] {
        let (handler, index_path) = isolated_runtime_work_handler("superseded-turn-alias");
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        );
        link.runtime_handle = json!({"turnIdsBySubtask": {
            "request-turn": "native-turn", "other-request": "other-turn",
        }});
        handler.upsert_local_task(link);

        handler.record_superseded_runtime_transcript_turn("task-1", source_id);
        let link = handler.local_task_link("task-1").unwrap();
        let mut messages = vec![
            json!({"turnId":"request-turn", "content":"Old optimistic message"}),
            json!({"turnId":"native-turn", "content":"Old native message"}),
            json!({"turnId":"other-turn", "content":"Preserve this message"}),
        ];
        remove_superseded_transcript_turns(&mut messages, &link.runtime_handle);
        assert_eq!(
            messages,
            vec![json!({"turnId":"other-turn", "content":"Preserve this message"})]
        );
        fs::remove_dir_all(index_path).unwrap();
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn assistant_status_replaces_user_runtime_status_in_canonical_turn() {
    for (user_status, assistant_status) in [("done", "streaming"), ("running", "done")] {
        let turns = transcript_canonical_turns(
            &[
                json!({
                    "id": "user-1",
                    "turnId": "turn-1",
                    "role": "user",
                    "content": "Run a tool",
                    "status": "done",
                    "runtimeStatus": user_status
                }),
                json!({
                    "id": "assistant-turn-1",
                    "turnId": "turn-1",
                    "role": "assistant",
                    "content": "",
                    "status": assistant_status,
                    "blocks": [{"id": "tool-1", "type": "tool", "status": "done"}]
                }),
            ],
            TranscriptTurnItemSource::CachedMessages,
        );

        assert_eq!(turns[0]["status"], assistant_status);
        assert_eq!(turns[0]["runtimeStatus"], assistant_status);
    }
}

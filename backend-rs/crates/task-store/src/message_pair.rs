use crate::task_store::NewSubtaskRow;

/// The next subtask message id and the parent it replies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessageIds {
    pub next_message_id: i64,
    pub parent_id: i64,
}

/// `task_fork_history_resolver.get_next_message_id` for an empty/continued
/// task: the next message id after `existing_max` and the parent message id.
pub fn next_message_ids(existing_max: Option<i64>) -> MessageIds {
    let next_message_id = existing_max.map_or(1, |max| max + 1);
    let parent_id = if next_message_id > 1 {
        next_message_id - 1
    } else {
        0
    };
    MessageIds {
        next_message_id,
        parent_id,
    }
}

/// The paired user/assistant subtask rows (`create_user_and_assistant_subtasks`
/// values) for `ids`.
pub fn subtask_rows<'a>(
    user_id: i64,
    task_id: i64,
    team_id: i64,
    bot_ids: &'a str,
    input_text: &'a str,
    completed_at: &'a str,
    ids: MessageIds,
) -> (NewSubtaskRow<'a>, NewSubtaskRow<'a>) {
    let user_subtask = NewSubtaskRow {
        id: 0,
        user_id,
        task_id,
        team_id,
        title: "User message",
        bot_ids,
        role: "USER",
        executor_namespace: "",
        executor_name: "",
        executor_deleted_at: 0,
        prompt: input_text,
        message_id: ids.next_message_id,
        parent_id: ids.parent_id,
        status: "COMPLETED",
        progress: 100,
        // `build_user_subtask_result` with no video/image/source config.
        result: "null",
        error_message: "",
        completed_at,
        sender_type: "USER",
        sender_user_id: user_id,
        reply_to_subtask_id: 0,
    };
    let assistant_subtask = NewSubtaskRow {
        id: 0,
        user_id,
        task_id,
        team_id,
        title: "Assistant response",
        bot_ids,
        role: "ASSISTANT",
        executor_namespace: "",
        executor_name: "",
        executor_deleted_at: 0,
        prompt: "",
        message_id: ids.next_message_id + 1,
        parent_id: ids.next_message_id,
        status: "PENDING",
        progress: 0,
        result: "null",
        error_message: "",
        completed_at,
        sender_type: "TEAM",
        sender_user_id: 0,
        reply_to_subtask_id: 0,
    };
    (user_subtask, assistant_subtask)
}

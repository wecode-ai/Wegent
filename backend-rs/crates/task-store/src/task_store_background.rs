// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Store-owned IDs and one transaction for hidden background Chat tasks.

use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlResult, MysqlService, MysqlTransaction};
use serde_json::{Value, json};

use crate::{
    task_store::DefaultTaskStore,
    task_store_create::{NewSubtaskRow, NewTaskRow, insert_task_row},
    task_store_executor_reference::insert_subtask_row,
};

pub struct BackgroundRecords<'a> {
    pub user_id: i64,
    pub title: &'a str,
    pub task_type: &'a str,
    pub summary_type: &'a str,
    pub document_id: Option<i64>,
    pub knowledge_base_id: Option<i64>,
    pub prompt: &'a str,
    pub now: &'a str,
}

#[derive(Debug)]
pub struct BackgroundIds {
    pub task_id: i64,
    pub user_subtask_id: i64,
    pub assistant_subtask_id: i64,
}

#[async_trait]
pub trait TaskStoreBackground: Send + Sync {
    async fn create_background_task_records(
        &self,
        mysql: &MysqlService,
        records: &BackgroundRecords<'_>,
    ) -> MysqlResult<BackgroundIds>;
}

pub fn task_document(input: &BackgroundRecords<'_>, id: i64) -> Value {
    let short: String = input.prompt.chars().take(100).collect();
    let short = if input.prompt.chars().count() > 100 {
        format!("{short}...")
    } else {
        short
    };
    json!({
        "kind":"Task","apiVersion":"agent.wecode.io/v1",
        "spec":{"title":input.title,"prompt":short,"teamRef":{"name":"system-background","namespace":"system"},
            "workspaceRef":{"name":"","namespace":""},"is_group_chat":false},
        "status":{"state":"Available","status":"RUNNING","progress":0,"createdAt":input.now,"updatedAt":input.now},
        "metadata":{"name":format!("task-{id}"),"namespace":"system","labels":{
            "type":"background","taskType":input.task_type,"summaryType":input.summary_type,
            "documentId":input.document_id.map(|id|id.to_string()).unwrap_or_default(),
            "knowledgeBaseId":input.knowledge_base_id.map(|id|id.to_string()).unwrap_or_default(),"source":"background_executor"}}
    })
}

/// `assigned_ids` is supplied by deployments with a global ID allocator.
pub async fn create_background_records<M: Mysql>(
    mysql: &M,
    tasks: &str,
    subtasks: &str,
    input: &BackgroundRecords<'_>,
    assigned_ids: Option<(i64, i64, i64)>,
) -> MysqlResult<BackgroundIds> {
    mysql
        .with_transaction(async |tx| {
            let pending = crate::task_creation::pending_task_name();
            let task = NewTaskRow {
                id: assigned_ids.map_or(0, |ids| ids.0),
                user_id: input.user_id,
                kind: "Task",
                name: &pending,
                namespace: "system",
                json: "{}",
                is_active: 1,
                created_at: input.now,
                updated_at: input.now,
                project_id: 0,
                client_origin: "",
                is_group_chat: 0,
            };
            let task_id = insert_task_row(tx, tasks, assigned_ids.is_some(), &task).await?;
            let name = format!("task-{task_id}");
            tx.execute(
                format!("UPDATE {tasks} SET name=?,json=?,updated_at=? WHERE id=? AND user_id=?"),
                (
                    name,
                    brz_mysql::Json(task_document(input, task_id)),
                    input.now,
                    task_id,
                    input.user_id,
                ),
            )
            .await?;
            let user = NewSubtaskRow {
                id: assigned_ids.map_or(0, |ids| ids.1),
                user_id: input.user_id,
                task_id,
                team_id: 0,
                title: "Background task input",
                bot_ids: "[]",
                role: "USER",
                executor_namespace: "",
                executor_name: "",
                executor_deleted_at: 0,
                prompt: input.prompt,
                message_id: 1,
                parent_id: 0,
                status: "COMPLETED",
                progress: 100,
                result: "null",
                error_message: "",
                completed_at: input.now,
                sender_type: "user",
                sender_user_id: input.user_id,
                reply_to_subtask_id: 0,
            };
            let user_subtask_id =
                insert_subtask_row(tx, subtasks, assigned_ids.is_some(), &user).await?;
            let assistant = NewSubtaskRow {
                id: assigned_ids.map_or(0, |ids| ids.2),
                role: "ASSISTANT",
                title: "Background task output",
                prompt: "",
                message_id: 2,
                parent_id: 1,
                status: "RUNNING",
                progress: 0,
                completed_at: "",
                sender_type: "",
                sender_user_id: 0,
                ..user
            };
            let assistant_subtask_id =
                insert_subtask_row(tx, subtasks, assigned_ids.is_some(), &assistant).await?;
            Ok(BackgroundIds {
                task_id,
                user_subtask_id,
                assistant_subtask_id,
            })
        })
        .await
}

#[async_trait]
impl<M: Mysql> TaskStoreBackground for DefaultTaskStore<M> {
    async fn create_background_task_records(
        &self,
        mysql: &MysqlService,
        input: &BackgroundRecords<'_>,
    ) -> MysqlResult<BackgroundIds> {
        create_background_records(mysql, "tasks", "subtasks", input, None).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_metadata_stays_hidden_and_identifies_summary_subject() {
        let input = BackgroundRecords {
            user_id: 7,
            title: "Summary",
            task_type: "summary",
            summary_type: "document",
            document_id: Some(8),
            knowledge_base_id: Some(9),
            prompt: "你好",
            now: "2026-10-23T00:00:00",
        };
        let document = task_document(&input, 10);
        assert_eq!(document["metadata"]["namespace"], "system");
        assert_eq!(document["metadata"]["labels"]["documentId"], "8");
        assert_eq!(
            document["metadata"]["labels"]["source"],
            "background_executor"
        );
    }
}

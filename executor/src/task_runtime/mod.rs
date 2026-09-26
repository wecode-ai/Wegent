// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

mod aitable_provider;
mod content;
mod credentials;
mod issue_provider;
pub mod mcp;
pub(crate) mod mcp_http;
mod model;
mod router;
mod store;

use serde_json::Value;

pub use model::{
    BinaryInput, ChatAgent, ChatAgentCreate, ChatAgentUpdate, Delivery, DeliveryAsset,
    DeliveryCreate, DeliveryDetail, DeliveryFinalize, IssueComment, LocalComment,
    LocalCommentCreate, LocalExecution, LocalExecutionClaim, LocalRuntimeCommentStart, LoopItem,
    ProjectCreate, ProjectDescriptor, ProjectFile, ProjectStoreKind, ProjectUpdate,
    RuntimeTaskAddress, TaskAttachment, TaskBinding, TaskCreate, TaskProviderKind, TaskReorder,
    TaskSearch, TaskUpdate,
};
pub use router::TaskRuntime;
pub use store::{LocalTaskStore, TaskRuntimeError};

const COLLABORATION_MEMBER_RESULT_INSTRUCTIONS: &str = "\
本轮执行的过程和最终答复会由 Executor 自动记录到当前 Issue 动态。\
请直接在最终答复中提交结果、证据、未完成项和风险；不要调用 \
add_board_item_comment 重复发布本轮执行结果，即使任务文本要求将结果记录为评论。\
如果生成了需要随 Issue 交付的文件，必须调用 upload_item_attachment 上传；\
只在工作目录中创建文件不会形成 Issue 附件。";

pub(crate) fn collaboration_member_system_prompt(current: &str) -> String {
    let current = current.trim();
    if current.contains(COLLABORATION_MEMBER_RESULT_INSTRUCTIONS) {
        return current.to_owned();
    }
    if current.is_empty() {
        COLLABORATION_MEMBER_RESULT_INSTRUCTIONS.to_owned()
    } else {
        format!("{current}\n\n{COLLABORATION_MEMBER_RESULT_INSTRUCTIONS}")
    }
}

pub(crate) fn collaboration_member_profile_instructions(payload: &Value) -> String {
    payload
        .get("projectInstructions")
        .or_else(|| payload.get("project_instructions"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("executionRequest")
                .or_else(|| payload.get("execution_request"))
                .and_then(|request| {
                    request
                        .get("system_prompt")
                        .or_else(|| request.get("systemPrompt"))
                })
                .and_then(Value::as_str)
        })
        .unwrap_or_default()
        .to_owned()
}

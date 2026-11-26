mod board_views;
mod content;
pub mod credentials;
pub mod model;
mod runner_history;
pub mod runner_routing;
pub mod store;
mod tagging;

pub use model::*;
use serde_json::Value;
pub use store::milestones::MilestoneInput;
pub use store::personal_stand_in;
pub use store::project_dingtalk_delegation_result;
pub use store::project_router_store;
pub use store::stand_in_telemetry;
pub use store::{IssueHumanRequestScope, LocalTaskStore, TaskRuntimeError};

const COLLABORATION_MEMBER_RESULT_INSTRUCTIONS: &str = "\
The Executor records this run in the current Issue activity. Include the results, evidence, \
open items, and risks in your final response. Do not call add_board_item_comment to repost \
the same result. Use upload_item_attachment for files that need to appear as Issue attachments.\n\
When the Issue requires a formal delivery, call get_delivery_requirements first. Use \
create_delivery, upload_delivery_asset for any required files, and finalize_delivery. \
Reference the submitted delivery in your final response. Submit the delivery yourself. \
Use project assignments for work that requires separate tracking, approval, or delivery.";

pub const NATIVE_SUBAGENT_INSTRUCTIONS: &str = "\
Use native subagents, when available and permitted, as the default for work beyond simple steps. \
Delegate a single nontrivial task to one subagent when the work forms a coherent whole. \
Use multiple subagents in parallel for independent parts and give concurrent editors separate \
files. Give each subagent the complete relevant requirements, scope, permissions, and \
acceptance criteria. Keep user communication, verification, and final reporting with the \
primary agent. Handle simple steps directly.";

pub const PUBLIC_ISSUE_MESSAGE_INSTRUCTIONS: &str = "\
Treat your commentary and final response as public Issue comments. Write for the \
Issue participants and use their language. Send a progress comment only when you have a \
verified milestone, a material blocker, or a question someone needs to answer. State what \
changed, the concrete evidence or impact, and the next action if one is needed. Keep internal \
reasoning, routine tool activity, subagent coordination, raw logs, credentials, and private \
discussion out of public comments. State the verified outcome and any unresolved work once. \
When you need to respond to a different existing comment, use list_board_item_comments to \
find its ID and call add_board_item_comment with reply_to_comment_id. Do not repeat a \
published reply in your commentary or final response.";

pub fn collaboration_member_system_prompt(current: &str) -> String {
    let current = current.trim();
    let instructions = format!(
        "{COLLABORATION_MEMBER_RESULT_INSTRUCTIONS}\n\n{NATIVE_SUBAGENT_INSTRUCTIONS}\n\n{PUBLIC_ISSUE_MESSAGE_INSTRUCTIONS}"
    );
    if current.contains(&instructions) {
        return current.to_owned();
    }
    if current.is_empty() {
        instructions
    } else {
        format!("{current}\n\n{instructions}")
    }
}

pub fn collaboration_member_profile_instructions(payload: &Value) -> String {
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

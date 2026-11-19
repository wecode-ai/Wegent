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
pub use store::project_router_store;
pub use store::stand_in_telemetry;
pub use store::{IssueHumanRequestScope, LocalTaskStore, TaskRuntimeError};

const COLLABORATION_MEMBER_RESULT_INSTRUCTIONS: &str = "\
The Executor records this run in the current Issue activity. Include the results, evidence, \
open items, and risks in your final response. Do not call add_board_item_comment to repost \
the same result. Use upload_item_attachment for files that need to appear as Issue attachments.\n\
When the Issue requires a formal delivery, call get_delivery_requirements first. Use \
create_delivery, upload_delivery_asset for any required files, and finalize_delivery. \
Reference the submitted delivery in your final response.\n\
Use native subagents, when available, to run independent investigation, implementation, \
testing, or review tasks in parallel. Give each subagent a clear goal, scope, permissions, \
and acceptance criteria. Assign separate files to subagents working in parallel. Handle \
small or tightly coupled steps directly. Review and integrate the subagents' work, then \
post the final response and submit the delivery yourself. Use project assignments for work \
that requires separate tracking, approval, or delivery.";

pub fn collaboration_member_system_prompt(current: &str) -> String {
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

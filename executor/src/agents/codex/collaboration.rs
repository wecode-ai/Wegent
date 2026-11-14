//! Issue delegation is thread-owned, never a shared app-server startup policy.
use super::*;

fn is_issue_work(request: &ExecutionRequest) -> bool {
    // Local queue assignments without a group dispatch use project_automation.
    request.extra.get("origin").is_some_and(|origin| {
        matches!(
            origin["type"].as_str(),
            Some("issue_dispatch" | "board_task" | "board_comment" | "project_automation")
        )
    })
}

pub(super) fn apply_thread_config(params: &mut Map<String, Value>, request: &ExecutionRequest) {
    let config = thread_config(request);
    if config.is_empty() {
        return;
    }
    params
        .entry("config")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("Thread configuration is an object")
        .extend(config);
}

pub(super) fn thread_config(request: &ExecutionRequest) -> Map<String, Value> {
    if !is_issue_work(request)
        || codex_collaboration_mode(request).is_some_and(|mode| mode.eq_ignore_ascii_case("single"))
    {
        return Map::new();
    }
    let policy = concat!(
        "In this Wework collaboration Issue, the primary agent delegates substantial ",
        "assigned work to native subagents without requiring the user to request delegation. ",
        "Discover collaboration tools through Code Mode, pass the complete requirements ",
        "and authorization limits, review the worker's evidence, and return a concise result. ",
        "Answer simple questions directly. Keep routine execution progress internal by default; ",
        "normally publish only a brief useful acknowledgment, verified results, material blockers or required questions. ",
        "Honor explicit user requests for progress updates. ",
        "If you are a delegated subagent, perform your bounded assignment and return evidence ",
        "to the parent without publishing Issue comments or recursively delegating by default. ",
        "Child agents share the workspace; preserve shared edits and verify the combined outcome. ",
        "Use inherited model and reasoning settings unless explicitly instructed otherwise. ",
        "Delegation never expands native permissions or bypasses approvals."
    );
    // Native resolves root, mode and spawn-tool guidance independently.
    let mut config: Map<String, Value> = [
        "root_agent_usage_hint_text",
        "multi_agent_mode_hint_text",
        "usage_hint_text",
    ]
    .into_iter()
    .map(|key| (format!("features.multi_agent_v2.{key}"), json!(policy)))
    .collect();
    config.insert("agents.enabled".into(), json!(true));
    config.insert("features.multi_agent_v2".into(), json!(true));
    config
}

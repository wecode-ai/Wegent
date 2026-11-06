//! Bind native approvals to one exact unfinished call in the current execution.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn bind_native_mcp_approval(&self, local_task_id: &str, message: &mut Value) {
        let params = &message["params"];
        if message["method"] != "mcpServer/elicitation/request"
            || params["mode"] != "form"
            || params["_meta"]["codex_approval_kind"] != "mcp_tool_call"
        {
            return;
        }
        let binding = self
            .active_codex_transcript_items
            .lock()
            .ok()
            .and_then(|items| {
                let active = items.get(local_task_id)?;
                if params["threadId"].as_str() != Some(active.thread_id.as_str())
                    || params["turnId"].as_str() != Some(active.turn_id.as_str())
                    || params
                        .get("interactionStatus")
                        .is_some_and(|value| value != "pending")
                {
                    return None;
                }
                unique_pending_call(&active.items, params)
            });
        let Some(meta) = message["params"]["_meta"].as_object_mut() else {
            return;
        };
        // These display identities must come from the scoped native call, never a claimed name.
        meta.remove("tool_name");
        meta.remove("tool_call_id");
        if let Some((tool, call)) = binding {
            meta.insert("tool_name".into(), json!(tool));
            meta.insert("tool_call_id".into(), json!(call));
        }
    }
}

fn unique_pending_call(items: &[Value], params: &Value) -> Option<(String, String)> {
    let server = params["serverName"]
        .as_str()
        .filter(|value| !value.is_empty())?;
    let arguments = params["_meta"]["tool_params"].as_object()?;
    let mut matches = items.iter().filter(|item| {
        item["type"] == "mcpToolCall"
            && item["status"] == "inProgress"
            && item["lifecycleCompleted"] != true
            && item["server"] == server
            && item["arguments"].as_object() == Some(arguments)
    });
    let item = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let tool = item["tool"].as_str().filter(|value| !value.is_empty())?;
    let call = item["id"].as_str().filter(|value| !value.is_empty())?;
    Some((tool.to_owned(), call.to_owned()))
}

#[cfg(test)]
#[path = "mcp_approval_context_tests.rs"]
mod tests;

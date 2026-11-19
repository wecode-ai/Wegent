//! Every turn ends only its own command, including a queued followup.
use serde_json::Value;

pub(crate) fn terminal_is_current(intent: &Value, execution: i64, payload: &Value) -> bool {
    if !intent["origin_context"]["assistant_request_id"].is_string() {
        return true;
    }
    let execution = execution.to_string();
    let command = intent["assistant_request"]["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|command| command["action"] == "followup" && command["executionId"] == execution)
        .and_then(|command| command["id"].as_str())
        .or_else(|| intent["assistant_request"]["attemptCommandId"].as_str());
    let initial = format!("assistant-start:{execution}");
    payload["assistantRequestCommandId"].as_str() == Some(command.unwrap_or(&initial))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepted_followup_fences_the_earlier_completion_even_before_ack() {
        let mut intent = json!({"origin_context":{"assistant_request_id":"r"},"assistant_request":{"attemptCommandId":"assistant-start:7","commands":[]}});
        assert!(terminal_is_current(
            &intent,
            7,
            &json!({"assistantRequestCommandId":"assistant-start:7"})
        ));
        intent["assistant_request"]["commands"] =
            json!([{"id":"followup-1","action":"followup","executionId":"7","acknowledged":false}]);
        assert!(!terminal_is_current(
            &intent,
            7,
            &json!({"assistantRequestCommandId":"assistant-start:7"})
        ));
        assert!(terminal_is_current(
            &intent,
            7,
            &json!({"assistantRequestCommandId":"followup-1"})
        ));
        intent["assistant_request"]["attemptCommandId"] = json!("assistant-start:8");
        assert!(terminal_is_current(
            &intent,
            8,
            &json!({"assistantRequestCommandId":"assistant-start:8"})
        ));
        assert!(!terminal_is_current(
            &intent,
            8,
            &json!({"assistantRequestCommandId":"followup-1"})
        ));
    }
}

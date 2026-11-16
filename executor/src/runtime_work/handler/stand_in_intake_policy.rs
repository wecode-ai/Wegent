//! Shared policy facts for bounded intake ordering and native routing.
use crate::task_runtime::personal_stand_in::{
    immediate_policy, project_policy, stand_in_connection,
};
use serde_json::Value;

pub(super) fn immediate_intake(roles: &[Value], event: &Value) -> bool {
    roles.iter().any(|role| {
        role["enabled"] == true
            && event["roleIds"]
                .as_array()
                .is_some_and(|ids| ids.contains(&role["id"]))
            && match event["kind"].as_str() {
                Some("calendar") => role["calendar"]["policy"]["immediate"]
                    .as_bool()
                    .unwrap_or(role["id"] != "@primary"),
                Some("assignment") => immediate_policy(&project_policy(
                    role,
                    event["projectId"].as_str().unwrap_or_default(),
                    event["projectStore"].as_str().unwrap_or_default(),
                )),
                _ => stand_in_connection(role, &event["source"])
                    .is_some_and(|connection| immediate_policy(&connection["policy"])),
            }
    })
}

pub(super) fn intake_order(roles: &[Value], event: &Value, now: i64) -> (bool, bool, i64) {
    let at = event["notBefore"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.timestamp_millis())
        .unwrap_or(i64::MIN);
    let direct = event["roleIds"]
        .as_array()
        .is_some_and(|ids| ids.len() == 1)
        && immediate_intake(roles, event);
    // Due single-recipient direct work precedes a silent or ambiguous backlog.
    // Future events retain deadline order, including the earliest wake-up.
    (at > now, at <= now && !direct, at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn direct_priority_preserves_future_deadlines_and_does_not_prioritize_ambiguous_intake() {
        let source = json!({"providerId":"example/events","kind":"resource","id":"source","profile":"account","policy":{"automatic":true,"immediate":true}});
        let roles = vec![json!({"id":"one","enabled":true,"connections":[source]})];
        let mut direct = json!({"kind":"connection","roleIds":["one"],"source":source});
        let mut ambiguous = direct.clone();
        ambiguous["roleIds"] = json!(["one", "two"]);
        assert!(intake_order(&roles, &direct, 2000) < intake_order(&roles, &ambiguous, 2000));
        direct["notBefore"] = json!("1970-01-01T00:00:04Z");
        ambiguous["notBefore"] = json!("1970-01-01T00:00:03Z");
        assert!(intake_order(&roles, &ambiguous, 2000) < intake_order(&roles, &direct, 2000));
    }
}

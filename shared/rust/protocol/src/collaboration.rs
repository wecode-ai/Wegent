use serde_json::Value;

/// Group references include its working lead, members and stage assignees.
pub fn group_references_agent(group: &Value, agent_id: &str) -> bool {
    let references = |member: &Value| {
        member["kind"].as_str() == Some("agent") && member["id"].as_str() == Some(agent_id)
    };
    references(&group["leader"])
        || group["members"]
            .as_array()
            .is_some_and(|members| members.iter().any(references))
        || group["stages"]
            .as_array()
            .is_some_and(|stages| stages.iter().any(|stage| references(&stage["assignee"])))
}

pub fn is_managed_project_agent(name: &str) -> bool {
    matches!(name, "current-device-agent" | "current-device-assistant")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn references_cover_leaders_members_and_stages_without_matching_humans() {
        for group in [
            json!({"leader":{"kind":"agent","id":"a"}}),
            json!({"members":[{"kind":"agent","id":"a"}]}),
            json!({"stages":[{"assignee":{"kind":"agent","id":"a"}}]}),
        ] {
            assert!(group_references_agent(&group, "a"));
            assert!(!group_references_agent(&group, "b"));
        }
        assert!(!group_references_agent(
            &json!({"members":[{"kind":"human","id":"a"}]}),
            "a"
        ));
    }
}

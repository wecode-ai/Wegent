use serde_json::Value;

/// Group references include its working lead, members and stage assignees.
pub fn group_references_agent(group: &Value, agent_id: &str, source_team_id: Option<i64>) -> bool {
    let source_id = source_team_id.filter(|id| *id > 0).map(|id| id.to_string());
    let references = |member: &Value| {
        member["kind"].as_str() == Some("agent")
            && member["id"]
                .as_str()
                .is_some_and(|id| id == agent_id || source_id.as_deref() == Some(id))
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
    fn shared_source_references_also_protect_the_project_definition() {
        let group = json!({"members":[{"kind":"agent","id":"4001"}]});
        assert!(group_references_agent(&group, "project-agent", Some(4001)));
        assert!(!group_references_agent(&group, "project-agent", Some(4002)));
        assert!(!group_references_agent(
            &json!({"leader":{"kind":"human","id":"4001"}}),
            "project-agent",
            Some(4001)
        ));
    }

    #[test]
    fn references_cover_leaders_members_and_stages_without_matching_humans() {
        for group in [
            json!({"leader":{"kind":"agent","id":"a"}}),
            json!({"members":[{"kind":"agent","id":"a"}]}),
            json!({"stages":[{"assignee":{"kind":"agent","id":"a"}}]}),
        ] {
            assert!(group_references_agent(&group, "a", None));
            assert!(!group_references_agent(&group, "b", None));
        }
        assert!(!group_references_agent(
            &json!({"members":[{"kind":"human","id":"a"}]}),
            "a",
            None
        ));
    }
}

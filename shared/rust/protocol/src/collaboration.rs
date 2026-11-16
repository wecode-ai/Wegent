use serde_json::Value;

/// Group references include its working lead, members and stage assignees.
pub fn group_references_agent(group: &Value, agent_id: &str, source_team_id: Option<i64>) -> bool {
    let source_id = source_team_id.filter(|id| *id > 0).map(|id| id.to_string());
    group_agent_ids(group).any(|id| id == agent_id || source_id.as_deref() == Some(id))
}

/// Canonical Agent references used by group validation and deletion guards.
pub fn group_agent_ids(group: &Value) -> impl Iterator<Item = &str> {
    std::iter::once(&group["leader"])
        .chain(group["members"].as_array().into_iter().flatten())
        .chain(
            group["stages"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|stage| &stage["assignee"]),
        )
        .filter(|member| member["kind"] == "agent")
        .filter_map(|member| member["id"].as_str())
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

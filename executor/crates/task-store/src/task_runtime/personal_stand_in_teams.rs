//! Team definitions reference existing stand-in identities without owning their configuration.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StandInTeam {
    pub id: String,
    pub name: String,
    pub lead_id: String,
    pub members: BTreeMap<String, String>,
    #[serde(default)]
    pub member_routes: BTreeMap<String, TeamMemberRoute>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_copy_revision: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamMemberRoute {
    pub execution_device_id: String,
    pub name: String,
}

pub fn team_scope_id(scope: &Value) -> Option<&str> {
    scope
        .as_str()
        .and_then(|scope| scope.strip_prefix("team:"))
        .filter(|id| uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == *id))
}

pub fn supports_role_delegation(origin: &Value) -> bool {
    origin["type"] == "stand_in_identity"
        && (origin["conversationScope"].is_null()
            || team_scope_id(&origin["conversationScope"]).is_some())
}

pub fn stand_in_team(settings: &Value, id: &str) -> Option<StandInTeam> {
    let row = settings["teams"]
        .as_array()?
        .iter()
        .find(|row| row["id"] == id)?;
    serde_json::from_value(row.clone()).ok()
}

pub(super) fn validate_teams(settings: &Value) -> Result<(), TaskRuntimeError> {
    let Some(rows) = settings.get("teams") else {
        return Ok(());
    };
    let invalid = || TaskRuntimeError::Invalid("invalid personal assistant team".into());
    let rows = rows.as_array().ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    for row in rows {
        let team: StandInTeam = serde_json::from_value(row.clone()).map_err(|_| invalid())?;
        if !uuid::Uuid::parse_str(&team.id).is_ok_and(|id| id.to_string() == team.id)
            || !ids.insert(team.id)
            || team.name.trim().is_empty()
            || !team.members.contains_key(&team.lead_id)
            || (team.lead_id != "@primary" && team.members.contains_key("@primary"))
            || team.member_routes.iter().any(|(id, route)| {
                id == &team.lead_id
                    || !team.members.contains_key(id)
                    || route.execution_device_id.trim().is_empty()
                    || route.execution_device_id == settings["executionDeviceId"]
            })
            || team.members.keys().any(|id| {
                id != "@primary"
                    && (id.is_empty()
                        || id.len() > 64
                        || !id
                            .bytes()
                            .all(|ch| ch.is_ascii_alphanumeric() || b"-_".contains(&ch)))
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_definition_excludes_private_profile_state_and_device_routes() {
        use super::super::assistant_share_definition;
        let settings = json!({
            "executionDeviceId":"local",
            "roles":[
                {"id":"data","executionDeviceId":"local","name":"Data","prompt":"Summarize metrics",
                    "connections":[{"profile":"private"}],"workspace":"/private/workspace",
                    "model":{"provider":"private"},"calendar":{"policy":"private"}},
                {"id":"remote","executionDeviceId":"peer","name":"Remote","prompt":"Review releases"}
            ],
            "teams":[{"id":"weekly","name":"Reports","leadId":"data","members":{"data":"daily metrics","remote":"review"},
                "memberRoutes":{"remote":{"name":"Remote","executionDeviceId":"peer"}}}]
        });
        assert_eq!(
            json!(assistant_share_definition(&settings, "assistant", "data")),
            json!({"kind":"assistant","definition":{"id":"data","name":"Data","prompt":"Summarize metrics"}})
        );
        assert!(assistant_share_definition(&settings, "assistant", "remote").is_none());
        assert_eq!(
            json!(assistant_share_definition(&settings, "team", "weekly")),
            json!({"kind":"team","definition":{"id":"weekly","name":"Reports","leadId":"data","members":{"data":"daily metrics","remote":"review"}}})
        );
    }

    #[test]
    fn teams_keep_independent_duties_for_the_same_assistant() {
        let first = "0cad1151-ed2d-4456-9546-d3954d3314c9";
        let settings = json!({"teams":[
            {"id":first,"name":"Reports","leadId":"@primary","members":{"@primary":"","data":"weekly metrics"}},
            {"id":"9286be68-95f9-452a-8f19-5b4038afa746","name":"Releases","leadId":"data","members":{"data":"release metrics"}}
        ]});
        assert!(validate_teams(&settings).is_ok());
        let team = stand_in_team(&settings, first).unwrap();
        assert_eq!(team.members["data"], "weekly metrics");
        assert_eq!(team_scope_id(&json!(format!("team:{first}"))), Some(first));
        let mut without_lead = settings;
        without_lead["teams"][0]["leadId"] = json!("missing");
        assert!(validate_teams(&without_lead).is_err());
        without_lead["teams"][0]["leadId"] = json!("@primary");
        without_lead["teams"][0]["memberRoutes"] =
            json!({"outside":{"executionDeviceId":"remote","name":"Outside"}});
        assert!(validate_teams(&without_lead).is_err());
    }
}

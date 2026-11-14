//! Connection configuration validation and current intake membership.
use super::*;

/// Validate source identities, handling policies and project scopes before persistence.
pub(super) fn validate_connections(role: &Value) -> Result<(), TaskRuntimeError> {
    if role
        .get("calendar")
        .is_some_and(|calendar| !validate_policy(&calendar["policy"]))
    {
        return Err(TaskRuntimeError::Invalid(
            "invalid stand-in calendar policy".into(),
        ));
    }
    if role.get("dingtalk").is_some() {
        return Err(TaskRuntimeError::Invalid(
            "conflicting connection formats".into(),
        ));
    }
    let source = &role["collaboration"];
    let valid = role.get("collaboration").map_or(true, valid_collaboration)
        && source.get("policy").map_or(true, validate_policy)
        && source.get("projectPolicies").map_or(true, |rows| {
            rows.as_array().is_some_and(|rows| {
                let mut ids = HashSet::new();
                rows.len() <= 1000
                    && rows.iter().all(|row| {
                        validate_projects(&json!([row]))
                            && validate_policy(&row["policy"])
                            && ids.insert((row["store"].to_string(), row["id"].to_string()))
                    })
            })
        })
        && role.get("connections").map_or(true, |rows| {
            rows.as_array().is_some_and(|rows| {
                let mut ids = HashSet::new();
                rows.len() <= 1000
                    && rows.iter().all(|row| {
                        let all = row["scope"] == "all";
                        row["id"]
                            .as_str()
                            .is_some_and(|id| !id.trim().is_empty() && id.len() <= 512)
                            && row["name"]
                                .as_str()
                                .is_some_and(|name| !name.trim().is_empty() && name.len() <= 512)
                            && row["profile"].as_str().is_some_and(|profile| {
                                !profile.trim().is_empty() && profile.len() <= 512
                            })
                            && row["providerId"]
                                .as_str()
                                .is_some_and(|id| !id.is_empty() && id.len() <= 256)
                            && row["kind"]
                                .as_str()
                                .is_some_and(|kind| !kind.is_empty() && kind.len() <= 128)
                            && row.get("collectionKey").map_or(true, |key| {
                                key.as_str().is_some_and(|key| {
                                    !key.is_empty() && key.trim() == key && key.len() <= 256
                                })
                            })
                            && row.get("configurationSummary").map_or(true, |summary| {
                                summary.as_str().is_some_and(|text| {
                                    !text.trim().is_empty() && text.len() <= 4096
                                })
                            })
                            && (all || row.get("scope").is_none())
                            && (all == (row["id"] == "*"))
                            && !rows.iter().any(|other| {
                                other["providerId"] == row["providerId"]
                                    && other["profile"] == row["profile"]
                                    && other["kind"] == row["kind"]
                                    && other["id"] != row["id"]
                                    && (all || other["scope"] == "all")
                            })
                            && valid_exclusions(row)
                            && validate_policy(&row["policy"])
                            && (!source_provider(row).starts_with("@wegent/dsh-connection-git/")
                                || row["policy"]["askBeforeAct"] == true)
                            && ids.insert((
                                row["providerId"].to_string(),
                                row["profile"].to_string(),
                                row["kind"].to_string(),
                                row["id"].to_string(),
                            ))
                    })
            })
        });
    if !valid {
        return Err(TaskRuntimeError::Invalid(
            "invalid stand-in connections".into(),
        ));
    }
    Ok(())
}

pub fn stand_in_connection<'a>(identity: &'a Value, source: &Value) -> Option<&'a Value> {
    identity["connections"].as_array()?.iter().find(|row| {
        (row["id"] == source["id"]
            || (row["scope"] == "all"
                && row["id"] == "*"
                && source["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && id != "*")))
            && source_provider(row) == source_provider(source)
            && row["profile"] == source["profile"]
            && row["kind"] == source["kind"]
            && row["transport"] == source["transport"]
    })
}

/// Intake must still belong to the currently configured collection partition.
pub fn stand_in_collection_connection<'a>(
    identity: &'a Value,
    source: &Value,
) -> Option<&'a Value> {
    stand_in_connection(identity, source).filter(|connection| {
        connection.get("collectionKey") == source.get("collectionKey")
            && !connection["excludedResources"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["id"] == source["id"]))
    })
}

fn valid_exclusions(source: &Value) -> bool {
    source.get("excludedResources").map_or(true, |value| {
        source_provider(source) == DINGTALK_PROVIDER
            && source["scope"] == "all"
            && ["group", "direct"].contains(&source["kind"].as_str().unwrap_or_default())
            && value.as_array().is_some_and(|rows| {
                let mut ids = HashSet::new();
                rows.iter().all(|row| {
                    ["id", "name"].iter().all(|key| {
                        row[*key]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty() && text.len() <= 512)
                    }) && row["id"] != "*"
                        && ids.insert(row["id"].to_string())
                })
            })
    })
}

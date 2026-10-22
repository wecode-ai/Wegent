//! Device consent remains scoped to a project and its unique active parent.

use crate::device_identity::resolve_owned_device_alias;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::Value;
use std::collections::HashSet;

#[derive(FromMysqlRow)]
struct Grant {
    resource_id: i64,
    entity_type: String,
    #[mysql(rename = "grant_role")]
    role: String,
    status: String,
}

impl Grant {
    fn allows_use(&self) -> bool {
        self.status == "approved"
            && matches!(self.role.as_str(), "Owner" | "Maintainer" | "Developer")
    }
}

#[derive(FromMysqlRow)]
struct LegacyAgent {
    device_id: Option<String>,
    created_by_user_id: Option<i32>,
    metadata: Option<Json<Value>>,
}

pub(super) async fn authorized_device_ids<M: Mysql>(
    mysql: &M,
    project_id: &str,
    workspace_id: i64,
    metadata: Option<&super::CloudMetadataInput>,
) -> MysqlResult<HashSet<i64>> {
    let grants: Vec<Grant> = mysql
        .fetch_all(
            include_str!("environment_grants.sql"),
            (workspace_id.to_string(), project_id.to_owned()),
        )
        .await?;
    let mut authorized = explicit_consent(&grants);
    let revoked: HashSet<i64> = metadata
        .and_then(|m| m.legacy_device_revocations.as_ref())
        .map(|v| v.to_value())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_i64)
        .collect();
    let agents: Vec<LegacyAgent> = mysql
        .fetch_all(
            include_str!("legacy_environment_agents.sql"),
            (project_id.to_owned(),),
        )
        .await?;
    for agent in agents {
        if agent
            .metadata
            .as_ref()
            .and_then(|m| m.0.get("authorization_version"))
            .is_some_and(python_truthy)
        {
            continue;
        }
        let Some(alias) = agent.device_id.as_deref() else {
            continue;
        };
        let Some(owner_id) = agent.created_by_user_id.filter(|id| *id != 0) else {
            continue;
        };
        let Some(device) = resolve_owned_device_alias(mysql, i64::from(owner_id), alias).await?
        else {
            continue;
        };
        if legacy_consent(&grants, &revoked, device.id) {
            authorized.insert(device.id);
        }
    }
    Ok(authorized)
}

fn explicit_consent(grants: &[Grant]) -> HashSet<i64> {
    let spaces: HashSet<_> = grants
        .iter()
        .filter(|g| g.entity_type == "workspace" && g.allows_use())
        .map(|g| g.resource_id)
        .collect();
    grants
        .iter()
        .filter(|g| g.entity_type == "project" && g.allows_use() && spaces.contains(&g.resource_id))
        .map(|g| g.resource_id)
        .collect()
}

fn legacy_consent(grants: &[Grant], revoked: &HashSet<i64>, device_id: i64) -> bool {
    !revoked.contains(&device_id)
        && grants
            .iter()
            .filter(|g| g.resource_id == device_id)
            .all(Grant::allows_use)
}

fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(scope: &str, role: &str, status: &str) -> Grant {
        Grant {
            resource_id: 42,
            entity_type: scope.to_owned(),
            role: role.to_owned(),
            status: status.to_owned(),
        }
    }

    #[test]
    fn cp10_cp15_space_and_project_consent_are_both_required() {
        for role in ["Owner", "Maintainer", "Developer"] {
            let mut grants = vec![
                grant("workspace", role, "approved"),
                grant("project", role, "approved"),
            ];
            assert!(explicit_consent(&grants).contains(&42));
            grants.remove(0);
            assert!(explicit_consent(&grants).is_empty());
        }
        for scope in ["workspace", "project"] {
            for (role, status) in [
                ("Viewer", "approved"),
                ("Developer", "revoked"),
                ("Developer", "pending"),
            ] {
                let grants = vec![
                    grant("workspace", "Developer", "approved"),
                    grant(scope, role, status),
                ];
                assert!(explicit_consent(&grants).is_empty());
            }
        }
    }

    #[test]
    fn cp11_cp15_legacy_installations_respect_every_revocation() {
        assert!(legacy_consent(&[], &HashSet::new(), 42));
        assert!(!legacy_consent(&[], &HashSet::from([42]), 42));
        for scope in ["workspace", "project"] {
            let denied = [grant(scope, "Developer", "revoked")];
            assert!(!legacy_consent(&denied, &HashSet::new(), 42));
            assert!(legacy_consent(&denied, &HashSet::new(), 99));
        }
    }
}

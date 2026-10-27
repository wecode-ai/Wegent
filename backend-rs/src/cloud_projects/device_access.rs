//! Device-owner consent is an additional constraint on existing project grants.

use serde::{Deserialize, Serialize};

pub(super) fn present_policies<'de, D>(
    deserializer: D,
) -> Result<Option<brz_json::OpaqueJson>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    brz_json::OpaqueJson::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Scope {
    #[default]
    Owner,
    Project,
    Members,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub(super) struct DeviceAccess {
    pub scope: Scope,
    #[serde(default)]
    pub member_ids: Vec<i32>,
}

impl DeviceAccess {
    pub fn for_device(metadata: Option<&super::CloudMetadataInput>, device_id: i64) -> Self {
        let policies = metadata.and_then(|m| m.execution_device_access.as_ref());
        let Some(policies) = policies else {
            // CP11 preserves the consent of installations predating scoped policies.
            return Self {
                scope: Scope::Project,
                member_ids: vec![],
            };
        };
        let value = policies.to_value();
        let Some(policies) = value.as_object() else {
            return Self::default();
        };
        let Some(value) = policies.get(&device_id.to_string()) else {
            return Self {
                scope: Scope::Project,
                member_ids: vec![],
            };
        };
        let policy: Self = serde_json::from_value(value.clone()).unwrap_or_default();
        if policy.member_ids.iter().any(|id| *id <= 0)
            || (policy.scope == Scope::Members) == policy.member_ids.is_empty()
        {
            Self::default()
        } else {
            policy
        }
    }

    pub fn allows(&self, owns_device: bool, user_id: i32) -> bool {
        owns_device
            || self.scope == Scope::Project
            || self.scope == Scope::Members && self.member_ids.contains(&user_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn owner_consent_has_no_administrator_bypass() {
        let policy = DeviceAccess {
            scope: Scope::Members,
            member_ids: vec![7],
        };
        assert!(policy.allows(true, 3));
        assert!(policy.allows(false, 7));
        assert!(!policy.allows(false, 9));
        assert!(DeviceAccess::for_device(None, 42).allows(false, 9));
    }

    #[test]
    fn explicit_policies_never_fall_back_to_project_sharing() {
        for value in [
            json!(null),
            json!("invalid"),
            json!({"scope":"unknown"}),
            json!({"scope":"project", "member_ids":[7]}),
            json!({"scope":"members", "member_ids":[-1]}),
            json!({"scope":"members", "member_ids":[]}),
        ] {
            let metadata = serde_json::from_value::<super::super::CloudMetadataInput>(json!({
                "execution_device_access": {"42": value}
            }))
            .unwrap();
            let policy = DeviceAccess::for_device(Some(&metadata), 42);
            assert!(policy.allows(true, 3));
            assert!(!policy.allows(false, 9));
        }
    }

    #[test]
    fn malformed_policy_containers_are_not_legacy_consent() {
        for value in [json!(null), json!([]), json!("invalid")] {
            let metadata = serde_json::from_value::<super::super::CloudMetadataInput>(json!({
                "execution_device_access": value
            }))
            .unwrap();
            assert!(!DeviceAccess::for_device(Some(&metadata), 42).allows(false, 9));
        }
    }
}

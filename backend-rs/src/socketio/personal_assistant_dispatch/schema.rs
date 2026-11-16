// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Only non-secret endpoint authority crosses the device boundary.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Declaration {
    pub version: u8,
    #[serde(default)]
    pub roles: Vec<Role>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Role {
    pub id: String,
    pub user_id: i64,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub enabled_since: Option<String>,
    #[serde(default)]
    pub version: u64,
    pub collaboration: Collaboration,
    #[serde(default)]
    pub handling_policy: Policy,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Policy {
    #[serde(default)]
    pub automatic: bool,
    #[serde(default)]
    pub ask_before_act: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Collaboration {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub all_projects: bool,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub excluded_projects: Vec<Project>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<Policy>,
    #[serde(default)]
    pub project_policies: Vec<ProjectPolicy>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Project {
    pub id: String,
    pub store: Store,
}

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Store {
    Cloud,
    Local,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct ProjectPolicy {
    #[serde(flatten)]
    pub project: Project,
    pub policy: Policy,
}

impl Project {
    fn valid(&self) -> bool {
        !self.id.is_empty() && self.id.len() <= 64
    }

    fn matches(&self, project_id: &str) -> bool {
        self.store == Store::Cloud && self.id == project_id
    }
}

impl Role {
    fn valid(&self) -> bool {
        self.id == "@primary"
            && self.user_id > 0
            && self
                .enabled_since
                .as_ref()
                .is_none_or(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
            && self.collaboration.projects.iter().all(Project::valid)
            && self
                .collaboration
                .excluded_projects
                .iter()
                .all(Project::valid)
            && self
                .collaboration
                .project_policies
                .iter()
                .all(|value| value.project.valid())
    }

    pub(super) fn permits(&self, user_id: i64, project_id: &str, tags: &Value) -> bool {
        let scope = &self.collaboration;
        let policy = scope
            .project_policies
            .iter()
            .find(|value| value.project.matches(project_id))
            .map(|value| &value.policy)
            .or(scope.policy.as_ref())
            .unwrap_or(&self.handling_policy);
        self.user_id == user_id
            && self.enabled
            && scope.enabled
            && policy.automatic
            && !scope
                .excluded_projects
                .iter()
                .any(|value| value.matches(project_id))
            && (scope.all_projects || scope.projects.iter().any(|value| value.matches(project_id)))
            && (scope.tags.is_empty()
                || tags.as_array().is_some_and(|tags| {
                    tags.iter()
                        .filter_map(Value::as_str)
                        .any(|tag| scope.tags.iter().any(|required| required == tag))
                }))
    }
}

pub(super) fn declaration(value: &Value) -> Option<Declaration> {
    let parsed: Declaration = serde_json::from_value(value.clone()).ok()?;
    (parsed.version == 1 && parsed.roles.iter().all(Role::valid)).then_some(parsed)
}

/// Invalid explicit declarations revoke earlier authority; absence is separate.
pub(super) fn normalize(value: &Value) -> Value {
    declaration(value)
        .map(|parsed| serde_json::to_value(parsed).expect("declaration serializes"))
        .unwrap_or_else(|| json!({"version": 1, "roles": []}))
}

pub(super) fn owned(value: &Value, user_id: i64) -> Value {
    let mut parsed = declaration(value).unwrap_or(Declaration {
        version: 1,
        roles: vec![],
    });
    parsed.roles.retain(|role| role.user_id == user_id);
    serde_json::to_value(parsed).expect("owned declaration serializes")
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared, read-only projections for the stable parts of persisted CRDs.
//!
//! Database rows remain JSON compatibility boundaries. Business code projects
//! only the fields it understands; unknown fields and malformed siblings do
//! not make an otherwise usable document fail to decode.

use std::collections::BTreeMap;

use crate::json_compat::{JsonProjection, OpaqueJson};

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct CrdDocument {
    pub metadata: Option<CrdMetadata>,
    pub spec: Option<CrdSpec>,
    pub status: Option<CrdStatus>,
    pub agent_type: Option<OpaqueJson>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct CrdMetadata {
    pub labels: Option<CrdLabels>,
    #[serde(rename = "displayName")]
    pub display_name: Option<OpaqueJson>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct CrdLabels {
    #[serde(rename = "taskType")]
    pub task_type: Option<String>,
    #[serde(rename = "type")]
    pub legacy_type: Option<String>,
    #[serde(rename = "requestedSkillRefs")]
    pub requested_skill_refs: Option<String>,
    #[serde(rename = "additionalSkills")]
    pub additional_skills: Option<String>,
    pub share_status: Option<String>,
    pub source: Option<String>,
    #[serde(rename = "modelId")]
    pub model_id: Option<OpaqueJson>,
    #[serde(rename = "forceOverrideBotModelType")]
    pub force_override_bot_model_type: Option<OpaqueJson>,
    #[serde(rename = "modelOptions")]
    pub model_options: Option<OpaqueJson>,
    #[serde(rename = "preserveExecutor")]
    pub preserve_executor: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct CrdSpec {
    #[serde(rename = "workspaceRef")]
    pub workspace_ref: Option<ResourceReference>,
    #[serde(rename = "teamRef")]
    pub team_ref: Option<ResourceReference>,
    #[serde(rename = "shellRef")]
    pub shell_ref: Option<ResourceReference>,
    #[serde(rename = "modelRef")]
    pub model_ref: Option<ResourceReference>,
    #[serde(rename = "ghostRef")]
    pub ghost_ref: Option<ResourceReference>,
    #[serde(rename = "skillRef")]
    pub skill_ref: Option<ResourceReference>,
    pub members: Option<Vec<Option<CrdMember>>>,
    pub capability: Option<CrdCapability>,
    #[serde(rename = "externalKnowledgeRefs")]
    pub external_knowledge_refs: Option<Vec<Option<ExternalKnowledgeRef>>>,
    #[serde(rename = "skillRefs")]
    pub subscription_skill_refs: Option<Vec<Option<ResourceReference>>>,
    pub skills: Option<Vec<Option<String>>>,
    pub preload_skills: Option<Vec<Option<String>>>,
    pub skill_refs: Option<BTreeMap<String, Option<SkillRefMetaInput>>>,
    pub preload_skill_refs: Option<BTreeMap<String, Option<SkillRefMetaInput>>>,
    #[serde(rename = "targetType")]
    pub target_type: Option<String>,
    #[serde(rename = "targetId")]
    pub target_id: Option<String>,
    #[serde(rename = "forcePreload")]
    pub force_preload: Option<bool>,
    #[serde(rename = "force_preload")]
    pub legacy_force_preload: Option<bool>,
    pub is_group_chat: Option<bool>,
    pub exceptions: Option<Vec<Option<BindingException>>>,
    pub recommended_mode: Option<OpaqueJson>,
    pub bind_mode: Option<OpaqueJson>,
    #[serde(rename = "directAccessRequirement")]
    pub direct_access_requirement: Option<String>,
    pub title: Option<OpaqueJson>,
    pub prompt: Option<OpaqueJson>,
    pub device_id: Option<OpaqueJson>,
    pub execution: Option<TaskExecution>,
    #[serde(rename = "knowledgeBaseRefs")]
    pub knowledge_base_refs: Option<Vec<Option<KnowledgeBaseRef>>>,
    pub fork: Option<TaskFork>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct CrdMember {
    #[serde(rename = "botRef")]
    pub bot_ref: Option<ResourceReference>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct ResourceReference {
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub user_id: Option<NumericId>,
    pub is_public: Option<bool>,
    #[serde(rename = "skillId")]
    pub skill_id: Option<NumericId>,
    #[serde(rename = "skill_id")]
    pub legacy_skill_id: Option<NumericId>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct CrdCapability {
    pub visibility: Option<String>,
    #[serde(rename = "publishStatus")]
    pub publish_status: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct CrdStatus {
    pub status: Option<String>,
    #[serde(rename = "fileHash")]
    pub file_hash: Option<String>,
    pub progress: Option<OpaqueJson>,
    pub result: Option<OpaqueJson>,
    #[serde(rename = "errorMessage")]
    pub error_message: Option<OpaqueJson>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<OpaqueJson>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<OpaqueJson>,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<OpaqueJson>,
    pub app: Option<OpaqueJson>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct TaskExecution {
    pub workspace: Option<ExecutionWorkspace>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct ExecutionWorkspace {
    pub source: Option<String>,
    pub path: Option<String>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct KnowledgeBaseRef {
    pub id: Option<i64>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct TaskFork {
    #[serde(rename = "sourceTaskId")]
    pub source_task_id: Option<i64>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct ExternalKnowledgeRef {
    pub provider: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct SkillRefMetaInput {
    pub skill_id: Option<i64>,
    pub namespace: Option<String>,
    pub is_public: Option<bool>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct BindingException {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub value: Option<String>,
}
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
pub(crate) enum NumericId {
    Number(serde_json::Number),
    Text(String),
    Null(()),
}

impl NumericId {
    pub(crate) fn json_integer(&self) -> Option<i64> {
        match self {
            Self::Number(number) => number.as_i64(),
            Self::Text(_) | Self::Null(()) => None,
        }
    }

    pub(crate) fn integer(&self) -> Option<i64> {
        match self {
            Self::Number(number) => number.as_i64(),
            Self::Text(text) => text.parse().ok(),
            Self::Null(()) => None,
        }
    }

    pub(crate) fn integer_or_truncated_float(&self) -> Option<i64> {
        match self {
            Self::Number(number) => number
                .as_i64()
                .or_else(|| number.as_f64().map(|value| value as i64)),
            Self::Text(text) => text.parse().ok(),
            Self::Null(()) => None,
        }
    }

    pub(crate) fn is_null(&self) -> bool {
        matches!(self, Self::Null(()))
    }

    pub(crate) fn team_owner(&self) -> Option<i32> {
        self.integer().map(|id| id as i32).filter(|id| *id != 0)
    }
}

impl ResourceReference {
    pub(crate) fn name(&self) -> &str {
        self.name.as_deref().unwrap_or("")
    }

    pub(crate) fn namespace(&self) -> &str {
        self.namespace.as_deref().unwrap_or("default")
    }

    pub(crate) fn nonempty_parts(&self) -> Option<(String, String)> {
        (!self.name().is_empty()).then(|| (self.name().to_owned(), self.namespace().to_owned()))
    }
}

/// Return normalized reference parts when the input contains a typed object.
pub(crate) fn reference_parts(field: &Option<ResourceReference>) -> Option<(String, String)> {
    field.is_some().then(|| {
        let reference = field.as_ref();
        (
            reference
                .map(ResourceReference::name)
                .unwrap_or("")
                .to_owned(),
            reference
                .map(ResourceReference::namespace)
                .unwrap_or("default")
                .to_owned(),
        )
    })
}

impl CrdDocument {
    pub(crate) fn project(value: &serde_json::Value) -> Self {
        JsonProjection::<Self>::from_json(value)
            .value
            .unwrap_or_default()
    }

    /// Project a persisted opaque document without materializing it as a
    /// mutable JSON tree.
    pub(crate) fn project_opaque(value: &OpaqueJson) -> Self {
        value.project::<Self>().unwrap_or_default()
    }

    pub(crate) fn is_deleted(&self) -> bool {
        self.status
            .as_ref()
            .and_then(|status| status.status.as_deref())
            == Some("DELETE")
    }

    pub(crate) fn skill_id(&self) -> Option<i32> {
        let reference = self.spec.as_ref()?.skill_ref.as_ref()?;
        let id = if reference.skill_id.is_some() {
            &reference.skill_id
        } else {
            &reference.legacy_skill_id
        };
        id.as_ref()?
            .integer_or_truncated_float()
            .map(|id| id as i32)
    }

    pub(crate) fn matches_target(&self, kind: &str, id: &str) -> bool {
        self.spec.as_ref().is_some_and(|spec| {
            spec.target_type.as_deref() == Some(kind) && spec.target_id.as_deref() == Some(id)
        })
    }

    pub(crate) fn is_published_public(&self) -> bool {
        self.spec
            .as_ref()
            .and_then(|spec| spec.capability.as_ref())
            .is_some_and(|capability| {
                capability.visibility.as_deref() == Some("public")
                    && capability.publish_status.as_deref() == Some("published")
            })
    }
}

pub(crate) fn json_status_is_delete(payload: &serde_json::Value) -> bool {
    CrdDocument::project(payload).is_deleted()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_treats_missing_and_null_as_none_but_keeps_empty_strings() {
        let missing = CrdDocument::project(&serde_json::json!({}));
        assert!(missing.spec.is_none());

        let null = CrdDocument::project(&serde_json::json!({"spec": null}));
        assert!(null.spec.is_none());

        let empty = CrdDocument::project(&serde_json::json!({"spec": {"teamRef": {"name": ""}}}));
        let reference = empty.spec.unwrap().team_ref.unwrap();
        assert!(reference.name.is_some());
        assert_eq!(reference.name(), "");
        assert_eq!(reference.namespace(), "default");
    }

    #[test]
    fn status_deletion_requires_the_exact_string() {
        assert!(json_status_is_delete(
            &serde_json::json!({"status": {"status": "DELETE"}})
        ));
        for value in [
            serde_json::json!({}),
            serde_json::json!({"status": null}),
            serde_json::json!({"status": {"status": null}}),
            serde_json::json!({"status": {"status": ""}}),
        ] {
            assert!(!json_status_is_delete(&value));
        }
    }
}

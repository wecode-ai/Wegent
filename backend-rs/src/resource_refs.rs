// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed references after legacy JSON normalization. The boundary stays
//! permissive so one malformed array entry does not discard its siblings.
use crate::crd::{NumericId, ResourceReference};
use crate::json_compat::JsonProjection;
use serde::Serialize;

impl ResourceReference {
    fn resource(self) -> Option<ResourceRef> {
        let name = self.name.filter(|name| !name.is_empty())?;
        Some(ResourceRef {
            name,
            namespace: self.namespace.unwrap_or_else(|| "default".into()),
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ResourceRef {
    pub name: String,
    pub namespace: String,
}

/// A requested skill reference as the task-detail response renders it
/// (`app/schemas/task.py:18-24`): the stored id is always present, as an
/// explicit null when the label carries none.
#[derive(Debug, Clone, Serialize)]
pub struct RequestedSkillRef {
    pub skill_id: Option<i64>,
    pub name: String,
    pub namespace: String,
    pub is_public: bool,
}

/// The existing detail and skill-resolution endpoints deliberately retain
/// their distinct empty-namespace behavior during this compatibility refactor.
pub(crate) enum EmptyNamespace {
    Preserve,
    UseDefault,
}

/// `normalize_requested_skill_refs`
/// (`app/services/task_skill_selection.py:16-56`): the label's `skill_id` is
/// kept only when it is an integer greater than zero, so a string, a float, a
/// null or a non-positive id all normalize to "no id" and render as null.
fn requested_skill_id(reference: &ResourceReference) -> Option<i64> {
    reference
        .legacy_skill_id
        .as_ref()
        .and_then(NumericId::json_integer)
        .filter(|skill_id| *skill_id > 0)
}

pub(crate) fn parse_requested_skill_refs(
    raw: &str,
    empty_namespace: EmptyNamespace,
) -> Vec<RequestedSkillRef> {
    let Ok(JsonProjection { value: Some(items) }) =
        serde_json::from_str::<JsonProjection<Vec<Option<ResourceReference>>>>(raw)
    else {
        return Vec::new();
    };
    let mut normalized: Vec<RequestedSkillRef> = Vec::new();
    for item in items.into_iter().flatten() {
        let is_public = item.is_public.unwrap_or(false);
        let skill_id = requested_skill_id(&item);
        let Some(mut reference) = item.resource() else {
            continue;
        };
        if reference.namespace.is_empty() && matches!(empty_namespace, EmptyNamespace::UseDefault) {
            reference.namespace = "default".to_owned();
        }
        normalized.retain(|existing| existing.name != reference.name);
        normalized.push(RequestedSkillRef {
            skill_id,
            name: reference.name,
            namespace: reference.namespace,
            is_public,
        });
    }
    normalized
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// `get_requested_skills_from_task` renders `SkillRef.skill_id` for every
    /// entry, so a label without an id still produces an explicit null
    /// (`SkillRef.skill_id: Optional[int] = None`), and
    /// `normalize_requested_skill_refs` drops ids that are not positive
    /// integers.
    #[test]
    fn requested_skill_refs_render_the_stored_id_or_null() {
        let raw = r#"[
            {"name": "wehot", "namespace": "default", "is_public": false},
            {"name": "pptx", "namespace": "default", "is_public": false, "skill_id": 42},
            {"name": "zero", "skill_id": 0},
            {"name": "negative", "skill_id": -3},
            {"name": "float", "skill_id": 1.5},
            {"name": "text", "skill_id": "7"},
            {"name": "null", "skill_id": null}
        ]"#;
        let rendered =
            serde_json::to_value(parse_requested_skill_refs(raw, EmptyNamespace::UseDefault))
                .expect("references serialize");
        let entries = rendered.as_array().expect("references render as an array");
        assert_eq!(entries[0]["skill_id"], Value::Null);
        assert_eq!(entries[1]["skill_id"], json!(42));
        for entry in &entries[2..] {
            assert_eq!(entry["skill_id"], Value::Null, "{entry}");
        }
        assert_eq!(
            entries[0],
            json!({"skill_id": null, "name": "wehot", "namespace": "default", "is_public": false})
        );
    }

    /// The `skillId` alias is not the key `normalize_requested_skill_refs`
    /// reads, so it does not become a rendered id.
    #[test]
    fn requested_skill_refs_ignore_the_skill_id_alias() {
        let rendered = serde_json::to_value(parse_requested_skill_refs(
            r#"[{"name": "alias", "skillId": 42}]"#,
            EmptyNamespace::UseDefault,
        ))
        .expect("references serialize");
        assert_eq!(rendered[0]["skill_id"], Value::Null);
    }
}

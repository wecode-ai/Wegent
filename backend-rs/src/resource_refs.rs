// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed references after legacy JSON normalization. The boundary stays
//! permissive so one malformed array entry does not discard its siblings.
use crate::crd::ResourceReference;
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

#[derive(Debug, Clone, Serialize)]
pub struct RequestedSkillRef {
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
        let Some(mut reference) = item.resource() else {
            continue;
        };
        if reference.namespace.is_empty() && matches!(empty_namespace, EmptyNamespace::UseDefault) {
            reference.namespace = "default".to_owned();
        }
        normalized.retain(|existing| existing.name != reference.name);
        normalized.push(RequestedSkillRef {
            name: reference.name,
            namespace: reference.namespace,
            is_public,
        });
    }
    normalized
}

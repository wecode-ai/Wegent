// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `skill_binding_service` access rules for the resource-library listings.
//!
//! Port of `app.services.skill_binding_service`: the user's default bindings,
//! the Skill ids they resolve to, and the per-Skill access check the listing
//! projection runs (`list_user_default_skill_ids`, `_is_personally_installed`,
//! `can_user_access_skill`).

use brz_mysql::{Mysql, MysqlResult};

use crate::py_set_order::SetOrder;
use crate::skills::skills_unified::effective_role_in_group;
use crate::teams::group_membership::ErpContext;

use super::models::{JsonScalar, KindPayload, scalar_to_int};
use super::repository::{
    KindPayloadRow, KindRow, fetch_active_skill, fetch_user_default_bindings,
    has_resource_reference, has_team_member,
};
use super::service::Source;

/// `REFERENCE_KINDS` (`app.services.capability_reference_service`).
const REFERENCE_KINDS: [&str; 3] = ["Model", "Shell", "Retriever"];

/// `_is_personally_installed`.
pub(super) async fn is_personally_installed<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    source: &Source<'_>,
    user_id: i64,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    if source.kind == "Skill" {
        let installed = user_default_skill_ids(mysql, erp, user_id).await?;
        return Ok(installed.contains(&source.id));
    }
    if REFERENCE_KINDS.contains(&source.kind) {
        if source.user_id == 0 {
            return Ok(true);
        }
        return has_resource_reference(mysql, source.kind, source.id, user_id).await;
    }
    if source.user_id == 0 || (source.namespace == "default" && source.user_id == user_id) {
        return Ok(true);
    }
    has_team_member(mysql, source.id, user_id).await
}

/// `skill_binding_service.list_user_default_skill_ids`.
///
/// The source returns `set[int]`, and `list_public` renders it straight into
/// `Kind.id.notin_(...)`, so the statement's id list follows CPython's set
/// slot order rather than the binding insertion order.
pub(super) async fn user_default_skill_ids<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    user_id: i64,
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    let bindings = fetch_user_default_bindings(mysql, user_id).await?;
    let target_id = format!("user:{user_id}");
    let mut skill_ids = SetOrder::new();
    for binding in &bindings {
        let Some(payload) = binding.payload() else {
            continue;
        };
        if !is_user_default_binding(payload, &target_id) {
            continue;
        }
        let Some(skill_id) = extract_skill_id(payload) else {
            continue;
        };
        let Some(skill) = fetch_active_skill(mysql, skill_id).await? else {
            continue;
        };
        if !can_user_access_skill(mysql, erp, user_id, &skill).await? {
            continue;
        }
        skill_ids.add(skill_id);
    }
    Ok(skill_ids.order())
}

/// `_is_user_default_binding`.
fn is_user_default_binding(payload: &KindPayload, target_id: &str) -> bool {
    let target_type = payload.spec.target_type.as_ref().map(JsonScalar::text);
    let target = payload.spec.target_id.as_ref().map(JsonScalar::text);
    target_type.as_deref() == Some("user") && target.as_deref() == Some(target_id)
}

/// `_extract_skill_id`: `spec.skillRef.skillId or spec.skillRef.skill_id`.
fn extract_skill_id(payload: &KindPayload) -> Option<i64> {
    let skill_ref = payload.spec.skill_ref.as_ref()?;
    let raw = match skill_ref.skill_id.as_ref() {
        Some(value) if !value.is_falsy() => Some(value),
        _ => skill_ref.skill_id_snake.as_ref(),
    }?;
    scalar_to_int(raw)
}

/// `can_user_access_skill`.
async fn can_user_access_skill<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    user_id: i64,
    skill: &KindRow,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    // The lookup already restricted rows to `is_active = true`.
    if skill.kinds_user_id == user_id || skill.kinds_user_id == 0 {
        return Ok(true);
    }
    if skill.payload().is_some_and(is_published_public) {
        return Ok(true);
    }
    if skill.kinds_namespace != "default" {
        let role = effective_role_in_group(
            mysql,
            erp,
            i32::try_from(user_id).unwrap_or(i32::MAX),
            &skill.kinds_namespace,
        )
        .await?;
        if role.as_deref().is_some_and(has_reporter_permission) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `capability.visibility == "public" and capability.publishStatus ==
/// "published"`.
fn is_published_public(payload: &KindPayload) -> bool {
    let Some(capability) = payload.spec.capability.as_ref() else {
        return false;
    };
    let visibility = capability.visibility.as_ref().map(JsonScalar::text);
    let status = capability.publish_status.as_ref().map(JsonScalar::text);
    visibility.as_deref() == Some("public") && status.as_deref() == Some("published")
}

/// `has_permission(role, GroupRole.Reporter)`.
fn has_reporter_permission(role: &str) -> bool {
    matches!(role, "Owner" | "Maintainer" | "Developer" | "Reporter")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_payload(json: serde_json::Value) -> KindPayload {
        serde_json::from_value(json).expect("test payload projects")
    }

    #[test]
    fn published_public_requires_public_and_published() {
        let published = kind_payload(serde_json::json!({
            "spec": {"capability": {"visibility": "public", "publishStatus": "published"}}
        }));
        assert!(is_published_public(&published));
        let draft = kind_payload(serde_json::json!({
            "spec": {"capability": {"visibility": "public", "publishStatus": "draft"}}
        }));
        assert!(!is_published_public(&draft));
    }

    #[test]
    fn skill_ref_prefers_camel_case_member() {
        let snake_case = kind_payload(serde_json::json!({
            "spec": {"skillRef": {"skillId": 0, "skill_id": 12}}
        }));
        assert_eq!(extract_skill_id(&snake_case), Some(12));
        let camel_case = kind_payload(serde_json::json!({
            "spec": {"skillRef": {"skillId": 9, "skill_id": 12}}
        }));
        assert_eq!(extract_skill_id(&camel_case), Some(9));
        let empty = kind_payload(serde_json::json!({"spec": {"skillRef": {}}}));
        assert_eq!(extract_skill_id(&empty), None);
    }
}

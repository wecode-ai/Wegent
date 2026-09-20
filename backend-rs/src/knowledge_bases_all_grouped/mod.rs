// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge-bases/all-grouped` — all knowledge bases accessible
//! to the current user, grouped by scope
//! (`app.api.endpoints.knowledge.get_all_knowledge_bases_grouped` ->
//! `KnowledgeService.get_all_knowledge_bases_grouped`).
//!
//! Source pipeline (recorded cases
//! `api-knowledge-bases-all-grouped` recordings, both JWT bearer sessions):
//!
//! 1. `security.get_current_user` — user by name, then
//!    `_get_user_or_raise` by id;
//! 2. `build_direct_access_permission_context` —
//!    `get_user_groups` (active namespace names + the full
//!    `iter_user_groups_with_roles` entity resolution through the optional
//!    employee-directory provider), organization names, effective group roles,
//!    accessible namespace ids, the direct KB member rows, and
//!    `collect_entity_authorized_kbs`;
//! 3. `get_user_groups_with_roles` — a second full membership batch
//!    (the group-role map of step 4);
//! 4. personal/shared/group/organization Kind batches, each filtered by
//!    `apply_direct_access_filter` (the rendered SQL predicate on
//!    `$.spec.directAccessRequirement` plus the ACL-deny EXISTS);
//! 5. `_batch_fetch_kb_metadata` — document counts, owner names, and the
//!    display-name namespace map;
//! 6. one `get_view_role_in_group` (`get_effective_role_in_group`) per
//!    organization KB for the merged `my_role`.
mod handler;
mod membership;
mod py_order;
mod queries;

use std::collections::HashMap;

use brz_mysql::{FromMysqlRow, Json};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

/// `namespace` columns as rendered by `db.query(Namespace)`.
const NAMESPACE_COLUMNS: &str = "namespace.id AS namespace_id, \
     namespace.name AS namespace_name, namespace.display_name AS namespace_display_name, \
     namespace.owner_user_id AS namespace_owner_user_id, \
     namespace.visibility AS namespace_visibility, \
     namespace.description AS namespace_description, namespace.level AS namespace_level, \
     namespace.is_active AS namespace_is_active, \
     namespace.created_at AS namespace_created_at, \
     namespace.updated_at AS namespace_updated_at";

/// `resource_members` columns as rendered by `db.query(ResourceMember)`.
const MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
     resource_members.resource_type AS resource_members_resource_type, \
     resource_members.resource_id AS resource_members_resource_id, \
     resource_members.entity_type AS resource_members_entity_type, \
     resource_members.entity_id AS resource_members_entity_id, \
     resource_members.entity_display_name AS resource_members_entity_display_name, \
     resource_members.user_id AS resource_members_user_id, \
     resource_members.`role` AS resource_members_role, \
     resource_members.status AS resource_members_status, \
     resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
     resource_members.share_link_id AS resource_members_share_link_id, \
     resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
     resource_members.reviewed_at AS resource_members_reviewed_at, \
     resource_members.copied_resource_id AS resource_members_copied_resource_id, \
     resource_members.requested_at AS resource_members_requested_at, \
     resource_members.created_at AS resource_members_created_at, \
     resource_members.updated_at AS resource_members_updated_at";

/// `kinds` columns as rendered by `db.query(Kind)`.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// `KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES`.
const KB_RESOURCE_TYPES: &str = "('KnowledgeBase', 'KNOWLEDGE_BASE')";
/// `APPROVED_MEMBER_STATUS_VALUES`.
const APPROVED_STATUSES: &str = "('approved', 'APPROVED')";

// ---------------------------------------------------------------------------
// Response schemas (field order matches the pydantic models)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct KbWithGroupInfo {
    id: i64,
    name: String,
    description: Option<String>,
    kb_type: String,
    namespace: String,
    document_count: i64,
    updated_at: String,
    created_at: String,
    user_id: i64,
    group_id: String,
    group_name: String,
    group_type: String,
    my_role: Option<String>,
    source_group: Option<String>,
    shared_from: Option<String>,
    shared_from_users: Option<Vec<String>>,
    shared_via: Option<String>,
    owner_name: Option<String>,
}

#[derive(Debug, Serialize)]
struct AllGroupedPersonal {
    created_by_me: Vec<KbWithGroupInfo>,
    shared_with_me: Vec<KbWithGroupInfo>,
}

#[derive(Debug, Serialize)]
struct AllGroupedTeamGroup {
    group_name: String,
    group_display_name: String,
    kb_count: usize,
    knowledge_bases: Vec<KbWithGroupInfo>,
}

#[derive(Debug, Serialize)]
struct AllGroupedOrganization {
    namespace: Option<String>,
    display_name: Option<String>,
    kb_count: usize,
    knowledge_bases: Vec<KbWithGroupInfo>,
}

#[derive(Debug, Serialize)]
struct AllGroupedSummary {
    total_count: usize,
    personal_count: usize,
    group_count: usize,
    organization_count: usize,
}

#[derive(Debug, Serialize)]
struct AllGroupedKnowledgeResponse {
    personal: AllGroupedPersonal,
    groups: Vec<AllGroupedTeamGroup>,
    organization: AllGroupedOrganization,
    summary: AllGroupedSummary,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// The `kinds.json` payload: only the `spec` fields the grouped response
/// reads are modeled; serde ignores the remaining keys.
#[derive(Debug, Clone, Deserialize)]
struct KindJson {
    #[serde(default)]
    spec: KindSpec,
}

/// `$.spec` of a KnowledgeBase `kinds.json` row.
#[derive(Debug, Clone, Default, Deserialize)]
struct KindSpec {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default, rename = "kbType")]
    kb_type: Option<String>,
}

/// A `kinds` row of a knowledge base.
#[derive(Debug, Clone, FromMysqlRow)]
struct KindRow {
    kinds_id: i64,
    kinds_user_id: i64,
    kinds_namespace: String,
    kinds_json: Json<KindJson>,
    kinds_created_at: NaiveDateTime,
    kinds_updated_at: NaiveDateTime,
}

/// Full `resource_members` row.
#[derive(Debug, FromMysqlRow)]
struct MemberRow {
    resource_members_resource_id: i64,
    #[allow(dead_code)]
    resource_members_entity_type: String,
    resource_members_entity_id: String,
    resource_members_role: String,
    resource_members_invited_by_user_id: i64,
}

/// `resource_members.resource_id` only.
#[derive(Debug, FromMysqlRow)]
struct IdRow {
    resource_members_resource_id: i64,
}

/// `(resource_id, entity_id, entity_type)` entity-member row.
#[derive(Debug, FromMysqlRow)]
struct EntityMemberRow {
    resource_members_resource_id: i64,
    resource_members_entity_id: String,
    resource_members_entity_type: String,
}

/// `resource_members.entity_id` only.
#[derive(Debug, FromMysqlRow)]
struct EntityIdRow {
    resource_members_entity_id: String,
}

/// `users.id`, `users.user_name`.
#[derive(Debug, FromMysqlRow)]
struct UserNameRow {
    users_id: i64,
    users_user_name: String,
}

/// Full `namespace` row.
#[derive(Debug, Clone, FromMysqlRow)]
struct NamespaceRow {
    namespace_id: i64,
    namespace_name: String,
    namespace_display_name: Option<String>,
    namespace_level: String,
}

/// `namespace.name` only.
#[derive(Debug, FromMysqlRow)]
struct NamespaceNameRow {
    namespace_name: String,
}

/// `namespace.id` only.
#[derive(Debug, FromMysqlRow)]
struct NamespaceIdRow {
    namespace_id: i64,
}

/// Document-count group row (`count(knowledge_documents.id) AS count`).
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    knowledge_documents_kind_id: i64,
    count: i64,
}

/// Role hierarchy ranks (`ROLE_HIERARCHY`); lower is more privileged.
fn role_rank(role: &str) -> Option<u8> {
    match role {
        "Owner" => Some(0),
        "Maintainer" => Some(1),
        "Developer" => Some(2),
        "Reporter" => Some(3),
        "RestrictedAnalyst" => Some(4),
        _ => None,
    }
}

/// `has_permission` (`app.schemas.base_role`).
fn has_permission(user_role: &str, required_role: &str) -> bool {
    match (role_rank(user_role), role_rank(required_role)) {
        (Some(user), Some(required)) => user <= required,
        _ => false,
    }
}

/// `get_highest_role`.
fn highest_role(roles: &[String]) -> Option<String> {
    roles
        .iter()
        .filter(|role| role_rank(role).is_some())
        .min_by_key(|role| role_rank(role).unwrap())
        .cloned()
}

/// `_merge_roles`: the highest privilege role among the candidates.
fn merge_roles(roles: &[Option<String>]) -> Option<String> {
    let mut highest: Option<String> = None;
    for role in roles.iter().flatten() {
        if highest
            .as_deref()
            .is_none_or(|current| has_permission(role, current))
        {
            highest = Some(role.clone());
        }
    }
    highest
}

/// MySQL default string-literal escaping (mirrors the source's rendered
/// COM_QUERY text).
fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for byte in value.bytes() {
        match byte {
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            b'\0' => out.push_str("\\0"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            0x1a => out.push_str("\\Z"),
            other => out.push(other as char),
        }
    }
    out.push('\'');
    out
}

// ---------------------------------------------------------------------------
// Response assembly
// ---------------------------------------------------------------------------

/// `_kb_to_response`.
#[allow(clippy::too_many_arguments)]
fn kb_to_response(
    kb: &KindRow,
    group_id: &str,
    group_name: &str,
    group_type: &str,
    document_counts: &HashMap<i64, i64>,
    owner_user_map: &HashMap<i64, String>,
    my_role: Option<String>,
    source_group: Option<String>,
    shared_from: Option<String>,
    shared_via: Option<String>,
    shared_from_users: Option<Vec<String>>,
) -> KbWithGroupInfo {
    let spec = &kb.kinds_json.0.spec;
    let description = (!spec.description.is_empty()).then(|| spec.description.clone());
    KbWithGroupInfo {
        id: kb.kinds_id,
        name: spec.name.clone(),
        description,
        kb_type: spec
            .kb_type
            .clone()
            .unwrap_or_else(|| "notebook".to_string()),
        namespace: kb.kinds_namespace.clone(),
        document_count: document_counts.get(&kb.kinds_id).copied().unwrap_or(0),
        updated_at: kb.kinds_updated_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
        created_at: kb.kinds_created_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
        user_id: kb.kinds_user_id,
        group_id: group_id.to_string(),
        group_name: group_name.to_string(),
        group_type: group_type.to_string(),
        my_role,
        source_group,
        shared_from,
        shared_from_users,
        shared_via,
        owner_name: owner_user_map.get(&kb.kinds_user_id).cloned(),
    }
}

/// `_build_shared_with_me` over the multi-source `kb_sources` aggregation.
struct SharedSourceInfo {
    kb: KindRow,
    roles: Vec<Option<String>>,
    inviter_ids: Vec<i64>,
    source_groups: Vec<String>,
    shared_vias: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
fn build_shared_with_me(
    sources: &[SharedSourceInfo],
    _namespace_display_names: &HashMap<String, String>,
    inviter_user_map: &HashMap<i64, String>,
    document_counts: &HashMap<i64, i64>,
    owner_user_map: &HashMap<i64, String>,
) -> Vec<KbWithGroupInfo> {
    let mut shared = Vec::new();
    for info in sources {
        let merged_role = merge_roles(&info.roles);
        let mut inviter_ids = info.inviter_ids.clone();
        inviter_ids.sort_unstable();
        inviter_ids.dedup();
        let mut source_groups = info.source_groups.clone();
        source_groups.sort();
        let mut shared_vias = info.shared_vias.clone();
        shared_vias.sort();
        shared_vias.dedup();

        let mut source_names: Vec<String> = Vec::new();
        for uid in &inviter_ids {
            if let Some(name) = inviter_user_map.get(uid)
                && !source_names.contains(name)
            {
                source_names.push(name.clone());
            }
        }
        for group in &source_groups {
            if !group.is_empty() && !source_names.contains(group) {
                source_names.push(group.clone());
            }
        }
        let shared_from = inviter_ids
            .first()
            .and_then(|uid| inviter_user_map.get(uid));
        let primary_source_group = source_groups.first().cloned();
        let primary_via = shared_vias.first().cloned();

        shared.push(kb_to_response(
            &info.kb,
            "default",
            "personal-shared",
            "personal-shared",
            document_counts,
            owner_user_map,
            merged_role,
            primary_source_group,
            shared_from.cloned(),
            primary_via,
            (source_names.len() > 1).then_some(source_names),
        ));
    }
    shared
}

#[cfg(test)]
mod tests {
    use super::membership::effective_roles;
    use super::py_order::{PySetOrder, PyStrSetOrder, cpython_hash_key, siphash13};
    use super::*;

    #[test]
    fn merge_roles_prefers_higher_privilege() {
        assert_eq!(
            merge_roles(&[Some("Reporter".into()), Some("Maintainer".into())]),
            Some("Maintainer".to_string())
        );
        assert_eq!(
            merge_roles(&[None, Some("Owner".into())]),
            Some("Owner".into())
        );
        assert_eq!(merge_roles(&[None, None]), None);
    }

    #[test]
    fn effective_roles_inherit_parent_groups() {
        let roles: Vec<(String, Vec<String>)> =
            vec![("aaa".to_string(), vec!["Developer".to_string()])];
        let effective = effective_roles(&roles, &["aaa/bbb".to_string(), "ccc".to_string()]);
        assert_eq!(
            effective.get("aaa/bbb").map(String::as_str),
            Some("Developer")
        );
        assert!(!effective.contains_key("ccc"));
    }

    #[test]
    fn py_set_order_matches_recorded_iterations() {
        // Case 2 (`xuran3`): owner ids inserted personal-then-group-then-org
        // render as (642, 101, 2800, 52, 1750, 1723, 2811).
        let mut set = PySetOrder::new();
        for id in [1750, 1723, 642, 2811, 52, 101, 2800] {
            set.add(id);
        }
        assert_eq!(set.order(), vec![642, 101, 2800, 52, 1750, 1723, 2811]);

        // Case 1 (`wenxuan10`): org-only owner ids render as
        // (2800, 2811, 52, 101).
        let mut set = PySetOrder::new();
        for id in [2811, 52, 101, 2800] {
            set.add(id);
        }
        assert_eq!(set.order(), vec![2800, 2811, 52, 101]);
    }

    #[test]
    fn py_str_set_order_matches_recorded_filter_iterations() {
        // The 2026-09-08 baseline recording (run 20260908120415) renders
        // the direct-access filter's `entity_id IN` list from the source's
        // `frozenset[str]` of accessible namespace ids. The three cases'
        // recorded draws under the default seed:
        let lisi = PyStrSetOrder::from_row_order(&[42, 61, 705]);
        assert_eq!(lisi.order(), vec!["705", "42", "61"]);

        let wangwu = PyStrSetOrder::from_row_order(&[710, 448, 298, 481]);
        assert_eq!(wangwu.order(), vec!["481", "710", "298", "448"]);

        let zhangsan = PyStrSetOrder::from_row_order(&[509, 277]);
        assert_eq!(zhangsan.order(), vec!["509", "277"]);
    }

    #[test]
    fn siphash13_matches_cpython_reference() {
        // SipHash-1-3 with a zero key (PYTHONHASHSEED=0) of b"42" matches
        // CPython 3.12's `hash("42")` under PYTHONHASHSEED=0.
        assert_eq!(siphash13(0, 0, b"42") as u64, 0xb17d_c261_8f65_2941);
        // The lcg key derivation for seed 91 reproduces CPython 3.12's
        // `hash("42")` under PYTHONHASHSEED=91.
        let (k0, k1) = cpython_hash_key(91);
        assert_eq!(siphash13(k0, k1, b"42") as u64, 0xc4ff_8075_03a1_f854);
    }

    #[test]
    fn kind_json_decodes_recorded_specs() {
        // The recorded specs carry `kbType` (camelCase) and sometimes omit
        // it entirely; description may be "".
        let with_type: KindJson = serde_json::from_str(
            r#"{"kind":"KnowledgeBase","spec":{"name":"Example Knowledge Base","description":"","document_count":12,"kbType":"classic"}}"#,
        )
        .expect("classic spec decodes");
        assert_eq!(with_type.spec.kb_type.as_deref(), Some("classic"));

        let without_type: KindJson = serde_json::from_str(
            r#"{"kind":"KnowledgeBase","spec":{"name":"Example Sharing","description":""}}"#,
        )
        .expect("spec without kbType decodes");
        assert!(without_type.spec.kb_type.is_none());

        let missing_spec: KindJson =
            serde_json::from_str(r#"{"kind":"KnowledgeBase"}"#).expect("missing spec decodes");
        assert_eq!(missing_spec.spec.name, "");
    }

    #[test]
    fn kb_response_field_order_matches_schema() {
        let kb = KindRow {
            kinds_id: 1,
            kinds_user_id: 2,
            kinds_namespace: "default".to_string(),
            kinds_json: Json(KindJson {
                spec: KindSpec {
                    name: "n".to_string(),
                    description: String::new(),
                    kb_type: Some("classic".to_string()),
                },
            }),
            kinds_created_at: NaiveDateTime::parse_from_str(
                "2026-01-02 03:04:05",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
            kinds_updated_at: NaiveDateTime::parse_from_str(
                "2026-01-02 03:04:05",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
        };
        let response = kb_to_response(
            &kb,
            "default",
            "personal",
            "personal",
            &HashMap::new(),
            &HashMap::new(),
            Some("Owner".to_string()),
            None,
            None,
            None,
            None,
        );
        let body = serde_json::to_string(&response).unwrap();
        assert!(body.starts_with(
            r#"{"id":1,"name":"n","description":null,"kb_type":"classic","namespace":"default","#
        ));
        assert!(body.contains(r#""updated_at":"2026-01-02T03:04:05""#));
        assert!(body.ends_with(r#""shared_via":null,"owner_name":null}"#));
    }

    #[test]
    fn empty_description_serializes_as_none() {
        let kb = KindRow {
            kinds_id: 1,
            kinds_user_id: 1,
            kinds_namespace: "default".to_string(),
            kinds_json: Json(KindJson {
                spec: KindSpec {
                    name: "n".to_string(),
                    description: String::new(),
                    kb_type: None,
                },
            }),
            kinds_created_at: Default::default(),
            kinds_updated_at: Default::default(),
        };
        let response = kb_to_response(
            &kb,
            "default",
            "personal",
            "personal",
            &HashMap::new(),
            &HashMap::new(),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(response.description, None);
        assert_eq!(response.kb_type, "notebook");
    }
}

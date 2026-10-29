// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/shells/unified` — the unified shell list.
//!
//! Mirrors `app.api.endpoints.adapter.shells.list_unified_shells` (the router
//! is mounted under `prefix="/shells"`, so the public path is
//! `/api/shells/unified`):
//!
//! 1. authenticate the bearer token (`security.get_current_user`);
//! 2. resolve the `scope` query parameter into the namespaces to query —
//!    `personal` -> `default`, `group` -> the named group or every group the
//!    user belongs to, `all` -> `default` plus every group; any other value is
//!    `400 {"detail": "Invalid scope: <scope>"}`;
//! 3. always prepend the public shells (`user_id = 0`, `namespace = 'default'`,
//!    active, ordered by name);
//! 4. for each namespace, load its own shells and then the capability
//!    references visible in it (`list_referenced_capabilities`), append the
//!    references that are not already present, and deduplicate the whole list
//!    by shell name. A source shell takes precedence over a reference to the
//!    same resource, even when the reference's group is queried first.
//!
//! The group list comes from the shared
//! [`crate::teams::group_membership`] resolution, which reproduces
//! `group_permission.get_user_groups` together with its entity-derived
//! (organization department) memberships.
use std::collections::{HashMap, HashSet};

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::sql_support::quote_sql_literal;
use crate::state::AppState;
use crate::teams::group_membership::{ErpContext, effective_roles, user_group_memberships};
use crate::teams::teams_repository::KIND_COLUMNS;
use brz_json::OpaqueJson;

/// The capability kind this endpoint references
/// (`capability_reference_service.REFERENCE_KINDS` includes `Shell`).
const REFERENCE_SHELL_KIND: &str = "Shell";

/// `GET /api/shells/unified` query parameters (`scope` and `group_name`).
#[derive(Debug, Default, Deserialize)]
pub struct UnifiedShellParams {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    group_name: Option<String>,
}

/// One `kinds` row selected with the SQLAlchemy `kinds_<column>` aliases.
/// Only the response fields are read; the remaining projected columns match
/// the source statement identity.
#[derive(Debug, FromMysqlRow)]
struct ShellKindRow {
    kinds_id: i64,
    kinds_name: String,
    kinds_namespace: String,
    kinds_json: Json<OpaqueJson>,
    kinds_created_at: NaiveDateTime,
    kinds_updated_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    kinds_user_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    kinds_kind: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    kinds_is_active: i8,
}

/// `namespace.id` from the referenced-capability target lookup
/// (`db.query(Namespace.id, Namespace.name)`).
#[derive(Debug, FromMysqlRow)]
struct NamespaceRefRow {
    namespace_id: i64,
}

/// `UnifiedShell` (`app.api.endpoints.adapter.shells.UnifiedShell`). Field
/// order follows the pydantic model declaration so `model_dump()`
/// serialization is byte-identical.
#[derive(Debug, Serialize)]
struct UnifiedShell {
    name: String,
    #[serde(rename = "type")]
    resource_type: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "shellType")]
    shell_type: String,
    #[serde(rename = "baseImage")]
    base_image: Option<String>,
    #[serde(rename = "baseShellRef")]
    base_shell_ref: Option<String>,
    #[serde(rename = "supportModel")]
    support_model: Option<Vec<String>>,
    #[serde(rename = "executionType")]
    execution_type: Option<String>,
    namespace: String,
    #[serde(rename = "requiresWorkspace")]
    requires_workspace: Option<bool>,
    created_at: String,
    updated_at: String,
    #[serde(rename = "isReference")]
    is_reference: bool,
    #[serde(rename = "listingId")]
    listing_id: Option<i64>,
}

/// The endpoint's `response_model=dict` body: `{"data": [...]}`.
#[derive(Debug, Serialize)]
struct UnifiedShellList {
    data: Vec<UnifiedShell>,
}

/// `ShellCRD` (`app.schemas.kind.Shell`): the fields the conversion reads. A
/// document that does not satisfy the model is rejected exactly like
/// `model_validate` raising (the shell is skipped with a warning).
#[derive(Debug, Deserialize)]
struct ShellDocument {
    metadata: ShellMetadata,
    spec: ShellSpec,
}

/// `ObjectMeta`: `name` is required; `displayName` and `labels` are optional.
#[derive(Debug, Deserialize)]
struct ShellMetadata {
    #[allow(dead_code, reason = "validated like the required ObjectMeta.name")]
    name: String,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    labels: Option<HashMap<String, String>>,
}

/// `ShellSpec`: `shellType` is required and accepts the `runtime` alias
/// (`AliasChoices("shellType", "runtime")`).
///
/// pydantic resolves `AliasChoices` to the first alias present, so a document
/// that carries both `shellType` and `runtime` is valid and `shellType` wins.
/// The two names are captured separately rather than as `#[serde(alias)]`,
/// which would reject the second occurrence as a duplicate field and silently
/// drop the shell.
#[derive(Debug, Deserialize)]
struct ShellSpec {
    #[serde(default, rename = "shellType")]
    shell_type: Option<String>,
    #[serde(default, rename = "runtime")]
    runtime: Option<String>,
    #[serde(default, rename = "supportModel")]
    support_model: Option<Vec<String>>,
    #[serde(default, rename = "baseImage")]
    base_image: Option<String>,
    #[serde(default, rename = "baseShellRef")]
    base_shell_ref: Option<String>,
    #[serde(default, rename = "requiresWorkspace")]
    requires_workspace: Option<bool>,
}

impl ShellSpec {
    /// Resolve `AliasChoices("shellType", "runtime")`: `shellType` wins when
    /// both are present, otherwise `runtime`. `None` mirrors the required
    /// `shellType` validation error that makes the source skip the shell.
    fn shell_type(&self) -> Option<&str> {
        self.shell_type.as_deref().or(self.runtime.as_deref())
    }
}

/// GET /api/shells/unified: the unified-shell free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/shells/unified")]
async fn list_unified_shells(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    query: brz_http_server::Query<UnifiedShellParams>,
) -> Result<UnifiedShellList, FastApiError> {
    unified_shells(state, &current_user, &query).await
}

/// Handler body for `GET /api/shells/unified`.
async fn unified_shells(
    state: &AppState,
    user: &SessionUser,
    params: &UnifiedShellParams,
) -> Result<UnifiedShellList, FastApiError> {
    let mysql = &state.mysql;
    let user_id = i64::from(user.id);

    // FastAPI evaluates the `scope` default to "personal"; `group_name` is
    // only truthy when non-empty (`if group_name:` in the source).
    let scope = params.scope.as_deref().unwrap_or("personal");
    let group_name = params.group_name.as_deref().filter(|name| !name.is_empty());

    let namespaces_to_query = match scope {
        "personal" => vec!["default".to_string()],
        "group" => match group_name {
            Some(name) => vec![name.to_string()],
            None => get_user_groups(state, user_id).await?,
        },
        "all" => {
            let mut namespaces = vec!["default".to_string()];
            namespaces.extend(get_user_groups(state, user_id).await?);
            namespaces
        }
        _ => {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                format!("Invalid scope: {scope}"),
            ));
        }
    };

    let mut result: Vec<UnifiedShell> = Vec::new();
    let mut selected_by_name: HashMap<String, usize> = HashMap::new();

    // Public shells are always included, independent of the scopes queried.
    let public_rows: Vec<ShellKindRow> = mysql
        .fetch_all(public_shells_sql().as_str(), ())
        .await
        .map_err(dependency_error)?;
    for row in &public_rows {
        match public_shell_to_unified(row) {
            Some(unified) => {
                selected_by_name.insert(row.kinds_name.clone(), result.len());
                result.push(unified);
            }
            None => tracing::warn!(name = %row.kinds_name, "failed to parse public shell"),
        }
    }

    for namespace in &namespaces_to_query {
        let direct_rows: Vec<ShellKindRow> = if namespace == "default" {
            mysql
                .fetch_all(personal_shells_sql(user_id).as_str(), ())
                .await
                .map_err(dependency_error)?
        } else {
            mysql
                .fetch_all(group_shells_sql(namespace).as_str(), ())
                .await
                .map_err(dependency_error)?
        };

        let referenced_rows = list_referenced_capabilities(mysql, user_id, namespace).await?;
        for row in &direct_rows {
            append_user_shell(&mut result, &mut selected_by_name, row, namespace, false);
        }
        for row in &referenced_rows {
            append_user_shell(&mut result, &mut selected_by_name, row, namespace, true);
        }
    }

    Ok(UnifiedShellList { data: result })
}

fn append_user_shell(
    result: &mut Vec<UnifiedShell>,
    selected_by_name: &mut HashMap<String, usize>,
    row: &ShellKindRow,
    namespace: &str,
    is_reference: bool,
) {
    let existing_index = selected_by_name.get(&row.kinds_name).copied();
    if let Some(index) = existing_index {
        let existing = &result[index];
        // Preserve public and unrelated same-name precedence. Only the source
        // itself may replace a reference selected from an earlier namespace.
        if is_reference || !existing.is_reference || existing.listing_id != Some(row.kinds_id) {
            return;
        }
    }
    match user_shell_to_unified(row, namespace, is_reference) {
        Some(unified) => {
            if let Some(index) = existing_index {
                result[index] = unified;
            } else {
                selected_by_name.insert(row.kinds_name.clone(), result.len());
                result.push(unified);
            }
        }
        None => tracing::warn!(name = %row.kinds_name, "failed to parse user shell"),
    }
}

/// `get_user_groups(db, user_id)`: the sorted group names where the user has
/// an effective role, including entity-derived memberships.
async fn get_user_groups(state: &AppState, user_id: i64) -> Result<Vec<String>, FastApiError> {
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    let resolved = user_group_memberships(&state.mysql, &erp, user_id)
        .await
        .map_err(dependency_error)?;
    let roles = effective_roles(&resolved.memberships, &resolved.active_names);
    let mut groups: Vec<String> = roles.into_keys().collect();
    groups.sort();
    Ok(groups)
}

/// The public-shell listing: `db.query(Kind).filter(user_id == 0, kind ==
/// 'Shell', namespace == 'default', is_active).order_by(name.asc())`.
fn public_shells_sql() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
         AND kinds.kind = 'Shell' AND kinds.namespace = 'default' \
         AND kinds.is_active = true ORDER BY kinds.name ASC"
    )
}

/// The personal-shell listing:
/// `db.query(Kind).filter(user_id == current, kind == 'Shell', namespace ==
/// 'default', is_active).order_by(name.asc())`.
fn personal_shells_sql(user_id: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = {user_id} \
         AND kinds.kind = 'Shell' AND kinds.namespace = 'default' \
         AND kinds.is_active = true ORDER BY kinds.name ASC"
    )
}

/// The group-shell listing:
/// `db.query(Kind).filter(kind == 'Shell', namespace == group, is_active)
/// .order_by(name.asc())`.
fn group_shells_sql(namespace: &str) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Shell' \
         AND kinds.namespace = {} AND kinds.is_active = true ORDER BY kinds.name ASC",
        quote_sql_literal(namespace),
    )
}

/// `list_referenced_capabilities(db, kind='Shell', user_id, namespace)`: the
/// source `Shell` rows referenced into the visible namespace.
///
/// The `default` namespace targets the user reference
/// (`("user", str(user_id))`); any other namespace first resolves its active
/// `namespace.id` by name and targets the namespace reference.
async fn list_referenced_capabilities<M>(
    mysql: &M,
    user_id: i64,
    namespace: &str,
) -> Result<Vec<ShellKindRow>, FastApiError>
where
    M: Mysql,
{
    let (entity_type, entity_id) = if namespace == "default" {
        ("user", user_id.to_string())
    } else {
        match namespace_id_by_name(mysql, namespace)
            .await
            .map_err(dependency_error)?
        {
            Some(namespace_id) => ("namespace", namespace_id.to_string()),
            // No active namespace matches: the source returns no references
            // and issues no join query.
            None => return Ok(Vec::new()),
        }
    };

    let sql = format!(
        "SELECT resource_members.entity_type AS resource_members_entity_type, \
         resource_members.entity_id AS resource_members_entity_id, {KIND_COLUMNS} \n\
         FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id \n\
         WHERE resource_members.resource_type = '{kind}' \
         AND resource_members.status = 'approved' \
         AND resource_members.entity_type = '{entity_type}' \
         AND resource_members.entity_id IN ('{entity_id}') \
         AND kinds.kind = '{kind}' AND kinds.user_id != 0 AND kinds.is_active IS true \
         ORDER BY kinds.id",
        kind = REFERENCE_SHELL_KIND,
    );
    let rows: Vec<ShellKindRow> = mysql
        .fetch_all(sql.as_str(), ())
        .await
        .map_err(dependency_error)?;

    // Deduplicate by referenced source id (the source's `seen` set keyed on
    // `(namespace, source.id)`; single namespace here).
    let mut seen: HashSet<i64> = HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|row| seen.insert(row.kinds_id))
        .collect())
}

/// `get_namespace_id_by_name` shape used by the reference target lookup:
/// `db.query(Namespace.id, Namespace.name).filter(name.in_, is_active)`.
async fn namespace_id_by_name<M>(mysql: &M, name: &str) -> MysqlResult<Option<i64>>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT namespace.id AS namespace_id, namespace.name AS namespace_name \n\
         FROM namespace \nWHERE namespace.name IN ({}) AND namespace.is_active IS true",
        quote_sql_literal(name),
    );
    let row: Option<NamespaceRefRow> = mysql.fetch_optional(sql.as_str(), ()).await?;
    Ok(row.map(|row| row.namespace_id))
}

/// `_public_shell_to_unified`: convert a public `Kind` row. `None` mirrors a
/// `model_validate` failure, which the source logs and skips.
fn public_shell_to_unified(row: &ShellKindRow) -> Option<UnifiedShell> {
    let document = parse_shell_document(row)?;
    let display_name = document
        .metadata
        .display_name
        .clone()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| row.kinds_name.clone());
    Some(UnifiedShell {
        name: row.kinds_name.clone(),
        resource_type: "public".to_string(),
        display_name,
        shell_type: document.spec.shell_type()?.to_string(),
        base_image: document.spec.base_image.clone(),
        base_shell_ref: document.spec.base_shell_ref.clone(),
        support_model: document.spec.support_model.clone(),
        execution_type: document
            .metadata
            .labels
            .as_ref()
            .and_then(|labels| labels.get("type"))
            .cloned(),
        namespace: row.kinds_namespace.clone(),
        requires_workspace: document.spec.requires_workspace,
        created_at: pydantic_datetime(row.kinds_created_at),
        updated_at: pydantic_datetime(row.kinds_updated_at),
        is_reference: false,
        listing_id: None,
    })
}

/// `_user_shell_to_unified`: convert a user/group `Kind` row. `is_reference`
/// marks a shell that came from a capability reference; its `listingId`
/// carries the referenced `Kind` id.
fn user_shell_to_unified(
    row: &ShellKindRow,
    visible_namespace: &str,
    is_reference: bool,
) -> Option<UnifiedShell> {
    let document = parse_shell_document(row)?;
    let resource_type = if visible_namespace == "default" {
        "user"
    } else {
        "group"
    };
    let display_name = document
        .metadata
        .display_name
        .clone()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| row.kinds_name.clone());
    Some(UnifiedShell {
        name: row.kinds_name.clone(),
        resource_type: resource_type.to_string(),
        display_name,
        shell_type: document.spec.shell_type()?.to_string(),
        base_image: document.spec.base_image.clone(),
        base_shell_ref: document.spec.base_shell_ref.clone(),
        support_model: document.spec.support_model.clone(),
        execution_type: document
            .metadata
            .labels
            .as_ref()
            .and_then(|labels| labels.get("type"))
            .cloned(),
        namespace: visible_namespace.to_string(),
        requires_workspace: document.spec.requires_workspace,
        created_at: pydantic_datetime(row.kinds_created_at),
        updated_at: pydantic_datetime(row.kinds_updated_at),
        is_reference,
        listing_id: if is_reference {
            Some(row.kinds_id)
        } else {
            None
        },
    })
}

/// Parse the stored `kinds.json` document with the `Shell` CRD contract.
fn parse_shell_document(row: &ShellKindRow) -> Option<ShellDocument> {
    row.kinds_json.0.project::<ShellDocument>()
}

/// pydantic serializes a DB `datetime` as `YYYY-MM-DDTHH:MM:SS`, appending
/// microseconds only when they are non-zero.
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

/// A dependency failure maps to the source's unhandled-exception body
/// (`app.core.exceptions.python_exception_handler`).
fn dependency_error(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(error = %error, "unified shells database dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_mysql::Json;
    use chrono::NaiveDate;
    use serde_json::json;

    fn shell_row(name: &str, namespace: &str, document: serde_json::Value) -> ShellKindRow {
        ShellKindRow {
            kinds_id: 42,
            kinds_name: name.to_string(),
            kinds_namespace: namespace.to_string(),
            kinds_json: Json(OpaqueJson::from_serializable(&document)),
            kinds_created_at: NaiveDate::from_ymd_opt(2025, 10, 12)
                .unwrap()
                .and_hms_opt(11, 16, 54)
                .unwrap(),
            kinds_updated_at: NaiveDate::from_ymd_opt(2025, 12, 3)
                .unwrap()
                .and_hms_opt(11, 39, 0)
                .unwrap(),
            kinds_user_id: 0,
            kinds_kind: "Shell".to_string(),
            kinds_is_active: 1,
        }
    }

    fn custom_shell_row(id: i64, namespace: &str) -> ShellKindRow {
        let mut row = shell_row(
            "custom-shell",
            namespace,
            json!({
                "metadata": {"name": "custom-shell", "labels": {"type": "local_engine"}},
                "spec": {"shellType": "ClaudeCode", "baseImage": "registry.test/runner:v1"},
            }),
        );
        row.kinds_id = id;
        row.kinds_user_id = 7;
        row
    }

    #[test]
    fn self_reference_keeps_the_source_editable() {
        for namespace in ["source-group", "default"] {
            let source = custom_shell_row(42, namespace);
            let mut result = Vec::new();
            let mut selected = HashMap::new();

            append_user_shell(&mut result, &mut selected, &source, namespace, false);
            append_user_shell(&mut result, &mut selected, &source, namespace, true);

            assert_eq!(result.len(), 1);
            assert_eq!(result[0].namespace, namespace);
            assert!(!result[0].is_reference);
            assert_eq!(result[0].listing_id, None);
        }
    }

    #[test]
    fn source_wins_over_its_reference_in_either_group_order() {
        let source = custom_shell_row(42, "z-source-group");
        for reference_first in [false, true] {
            let mut result = Vec::new();
            let mut selected = HashMap::new();
            let scopes = if reference_first {
                [("a-shared-group", true), ("z-source-group", false)]
            } else {
                [("z-source-group", false), ("a-shared-group", true)]
            };
            for (namespace, is_reference) in scopes {
                append_user_shell(&mut result, &mut selected, &source, namespace, is_reference);
            }

            assert_eq!(result.len(), 1);
            assert_eq!(result[0].namespace, "z-source-group");
            assert!(!result[0].is_reference);
            assert_eq!(result[0].listing_id, None);
        }
    }

    #[test]
    fn reference_only_scope_keeps_the_source_id_and_visible_namespace() {
        for (source_namespace, visible_namespace) in [
            ("source-group", "shared-group"),
            ("default", "shared-group"),
            ("default", "default"),
        ] {
            let source = custom_shell_row(42, source_namespace);
            let mut result = Vec::new();
            let mut selected = HashMap::new();

            append_user_shell(&mut result, &mut selected, &source, visible_namespace, true);

            assert_eq!(result.len(), 1);
            assert_eq!(result[0].namespace, visible_namespace);
            assert!(result[0].is_reference);
            assert_eq!(result[0].listing_id, Some(42));
        }
    }

    #[test]
    fn unrelated_same_name_source_cannot_replace_a_reference() {
        let referenced = custom_shell_row(42, "source-group");
        let unrelated = custom_shell_row(43, "another-group");
        let mut result = Vec::new();
        let mut selected = HashMap::new();

        append_user_shell(
            &mut result,
            &mut selected,
            &referenced,
            "shared-group",
            true,
        );
        append_user_shell(
            &mut result,
            &mut selected,
            &unrelated,
            "another-group",
            false,
        );

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].namespace, "shared-group");
        assert_eq!(result[0].listing_id, Some(42));
        assert!(result[0].is_reference);
    }

    #[test]
    fn user_shell_cannot_replace_a_public_shell_with_the_same_name() {
        let source = custom_shell_row(42, "source-group");
        let public = public_shell_to_unified(&source).unwrap();
        let mut result = vec![public];
        let mut selected = HashMap::from([(source.kinds_name.clone(), 0)]);

        append_user_shell(&mut result, &mut selected, &source, "source-group", false);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].resource_type, "public");
        assert!(!result[0].is_reference);
        assert_eq!(result[0].listing_id, None);
    }

    #[test]
    fn public_shell_uses_runtime_alias_and_defaults_display_name() {
        // `Agno` carries `runtime` instead of `shellType` and no
        // `displayName`, so the alias and the name fallback both apply.
        let row = shell_row(
            "Agno",
            "default",
            json!({
                "kind": "Shell",
                "spec": {"runtime": "Agno", "supportModel": []},
                "metadata": {"name": "Agno", "labels": {"type": "local_engine"},
                             "namespace": "default"},
                "apiVersion": "agent.wecode.io/v1"
            }),
        );
        let unified = public_shell_to_unified(&row).expect("public shell parses");
        let body = serde_json::to_string(&unified).unwrap();
        assert_eq!(
            body,
            "{\"name\":\"Agno\",\"type\":\"public\",\"displayName\":\"Agno\",\
             \"shellType\":\"Agno\",\"baseImage\":null,\"baseShellRef\":null,\
             \"supportModel\":[],\"executionType\":\"local_engine\",\
             \"namespace\":\"default\",\"requiresWorkspace\":null,\
             \"created_at\":\"2025-10-12T11:16:54\",\"updated_at\":\"2025-12-03T11:39:00\",\
             \"isReference\":false,\"listingId\":null}"
        );
    }

    #[test]
    fn shell_type_keeps_shell_type_when_both_aliases_are_present() {
        // The stored `ClaudeCode` document carries both `runtime` and
        // `shellType`. `AliasChoices("shellType", "runtime")` accepts it with
        // `shellType` winning; `#[serde(alias)]` would treat the second key as
        // a duplicate field and silently drop the shell.
        let row = shell_row(
            "ClaudeCode",
            "default",
            json!({
                "kind": "Shell",
                "spec": {"runtime": "ClaudeCode", "shellType": "ClaudeCode",
                         "supportModel": ["claude"]},
                "status": {"state": "Available"},
                "metadata": {"name": "ClaudeCode", "labels": {"type": "local_engine"},
                             "namespace": "default"},
                "apiVersion": "agent.wecode.io/v1"
            }),
        );
        let unified = public_shell_to_unified(&row).expect("both aliases parse");
        assert_eq!(unified.shell_type, "ClaudeCode");
        assert_eq!(unified.support_model, Some(vec!["claude".to_string()]));
    }

    #[test]
    fn missing_shell_type_alias_is_skipped() {
        // Neither `shellType` nor `runtime`: `model_validate` would raise, so
        // the shell must be dropped rather than rendered.
        let row = shell_row(
            "Nope",
            "default",
            json!({"metadata": {"name": "Nope"}, "spec": {"supportModel": []}}),
        );
        assert!(public_shell_to_unified(&row).is_none());
    }

    #[test]
    fn group_shell_is_type_group_with_namespace_and_reference_id() {
        let row = shell_row(
            "MyShell",
            "ignored",
            json!({
                "kind": "Shell",
                "spec": {"shellType": "ClaudeCode", "baseImage": "img"},
                "metadata": {"name": "MyShell", "displayName": "My Shell",
                             "labels": {"type": "external_api"}},
            }),
        );
        let unified =
            user_shell_to_unified(&row, "AI-TEST-ding", true).expect("group shell parses");
        let body = serde_json::to_string(&unified).unwrap();
        assert_eq!(
            body,
            "{\"name\":\"MyShell\",\"type\":\"group\",\"displayName\":\"My Shell\",\
             \"shellType\":\"ClaudeCode\",\"baseImage\":\"img\",\"baseShellRef\":null,\
             \"supportModel\":null,\"executionType\":\"external_api\",\
             \"namespace\":\"AI-TEST-ding\",\"requiresWorkspace\":null,\
             \"created_at\":\"2025-10-12T11:16:54\",\"updated_at\":\"2025-12-03T11:39:00\",\
             \"isReference\":true,\"listingId\":42}"
        );
    }

    #[test]
    fn personal_shell_is_type_user_without_listing_id() {
        let row = shell_row(
            "Mine",
            "default",
            json!({
                "kind": "Shell",
                "spec": {"shellType": "Codex"},
                "metadata": {"name": "Mine", "labels": {"type": "local_engine"}},
            }),
        );
        let unified = user_shell_to_unified(&row, "default", false).expect("personal parses");
        assert_eq!(unified.resource_type, "user");
        assert_eq!(unified.namespace, "default");
        assert_eq!(unified.listing_id, None);
        assert!(!unified.is_reference);
    }

    #[test]
    fn invalid_document_is_skipped() {
        // Missing `spec` entirely: `model_validate` would raise, so the shell
        // must be dropped rather than rendered.
        let row = shell_row("Broken", "default", json!({"metadata": {"name": "Broken"}}));
        assert!(public_shell_to_unified(&row).is_none());
    }

    #[test]
    fn group_shell_sql_quotes_the_namespace() {
        assert_eq!(
            group_shells_sql("AI-TEST-ding"),
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Shell' \
                 AND kinds.namespace = 'AI-TEST-ding' AND kinds.is_active = true \
                 ORDER BY kinds.name ASC"
            )
        );
        // A quote in the group name cannot break out of the literal.
        assert!(group_shells_sql("a'b").contains("'a\\'b'"));
    }

    #[test]
    fn pydantic_datetime_has_no_fraction_for_whole_seconds() {
        let value = NaiveDate::from_ymd_opt(2026, 5, 29)
            .unwrap()
            .and_hms_opt(16, 21, 14)
            .unwrap();
        assert_eq!(pydantic_datetime(value), "2026-05-29T16:21:14");
    }
}

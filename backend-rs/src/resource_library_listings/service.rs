// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/resource-library/listings` service.
//!
//! Port of `app.services.resource_library_service.ResourceLibraryService.list_public`
//! plus the `to_listing` projection it delegates to. Query order and shape
//! follow the source: the default-binding probe, the system and published
//! discovery scans, and the per-item listing projection (which re-runs the
//! default-binding probe for every Skill and reads Team group grants).

use brz_http_server::StatusCode;
use brz_mysql::{Mysql, MysqlResult};
use chrono::NaiveDateTime;

use crate::http_compat::FastApiError;
use crate::skills::skills_unified::effective_role_in_group;
use crate::teams::group_membership::ErpContext;

use super::models::{
    ALL_KINDS, Capability, CursorPayload, DiscoveryList, DiscoveryParams, ExampleConversation,
    JsonScalar, KindPayload, Listing, Version, format_datetime, resource_type_for_kind,
};
use super::repository::{
    CursorPosition, KindPayloadRow, KindRow, ListingRow, QueryParts, build_discovery_query,
    fetch_active_skill, fetch_discovery_rows, fetch_namespaces, fetch_team_group_members,
    fetch_user_default_bindings, fetch_user_name, has_resource_reference, has_team_member,
};
use super::set_order::SetOrder;

/// `REFERENCE_KINDS` (`app.services.capability_reference_service`).
const REFERENCE_KINDS: [&str; 3] = ["Model", "Shell", "Retriever"];

/// The rows a listing projection reads.
struct Source<'a> {
    id: i64,
    user_id: i64,
    kind: &'a str,
    name: &'a str,
    namespace: &'a str,
    payload: Option<&'a KindPayload>,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

impl<'a> From<&'a ListingRow> for Source<'a> {
    fn from(row: &'a ListingRow) -> Self {
        Self {
            id: row.kinds_id,
            user_id: row.kinds_user_id,
            kind: row.kinds_kind.as_str(),
            name: row.kinds_name.as_str(),
            namespace: row.kinds_namespace.as_str(),
            payload: row.payload(),
            created_at: row.kinds_created_at,
            updated_at: row.kinds_updated_at,
        }
    }
}

/// `list_public`.
pub async fn list_public<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    user_id: i64,
    params: &DiscoveryParams,
) -> Result<DiscoveryList, FastApiError>
where
    M: Mysql,
{
    let kinds: Vec<&str> = match params.resource_kind {
        Some(kind) => vec![kind],
        None => ALL_KINDS.to_vec(),
    };
    let system_kinds: Vec<&str> = if params.target_namespace == "default" {
        kinds.clone()
    } else {
        kinds
            .iter()
            .copied()
            .filter(|kind| *kind != "Team")
            .collect()
    };
    let normalized_keyword = params
        .keyword
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let keyword = (!normalized_keyword.is_empty()).then_some(normalized_keyword.as_str());
    let should_hide_installed_skills =
        params.target_namespace == "default" && params.tags.is_empty() && keyword.is_none();
    let installed_skill_ids = if should_hide_installed_skills {
        user_default_skill_ids(mysql, erp, user_id)
            .await
            .map_err(internal_error)?
    } else {
        Vec::new()
    };

    let cursor = match params.cursor.as_deref() {
        Some(value) if !value.is_empty() => Some(decode_cursor(value)?),
        _ => None,
    };
    let filters = DiscoveryFilters {
        kinds: &system_kinds,
        // `MarketplaceResource.resource_type == resource_type`: the published
        // scan compares the endpoint's own value, not the CRD Kind.
        resource_type: params.resource_type,
        featured_only: params.featured_only,
        installed_skill_ids: &installed_skill_ids,
        keyword,
        tags: &params.tags,
        limit: params.limit,
    };
    let mut rows = fetch_visible_rows(mysql, &filters, false, cursor.as_ref())
        .await
        .map_err(internal_error)?;
    if !params.system_only {
        let filters = DiscoveryFilters {
            kinds: &kinds,
            ..filters
        };
        rows.extend(
            fetch_visible_rows(mysql, &filters, true, cursor.as_ref())
                .await
                .map_err(internal_error)?,
        );
    }

    rows.sort_by(|left, right| {
        (right.recommendation_score, right.sort_time, right.kinds_id).cmp(&(
            left.recommendation_score,
            left.sort_time,
            left.kinds_id,
        ))
    });

    let has_more = rows.len() as i64 > params.limit;
    let page: Vec<ListingRow> = rows.into_iter().take(params.limit as usize).collect();
    let next_cursor = if has_more {
        page.last().and_then(|row| {
            encode_cursor(&CursorPosition {
                recommendation_score: cursor
                    .as_ref()
                    .and_then(|position| position.recommendation_score)
                    .map(|_| row.recommendation_score),
                updated_at: row.sort_time,
                kind_id: row.kinds_id,
            })
        })
    } else {
        None
    };

    let mut items = Vec::with_capacity(page.len());
    for row in &page {
        items.push(
            to_listing(mysql, erp, &Source::from(row), user_id, row.install_count)
                .await
                .map_err(internal_error)?,
        );
    }
    Ok(DiscoveryList {
        items,
        has_more,
        next_cursor,
        limit: params.limit,
    })
}

/// The shared discovery scan filters.
#[derive(Clone, Copy)]
struct DiscoveryFilters<'a> {
    kinds: &'a [&'a str],
    /// The endpoint's `resource_type` value, compared against
    /// `marketplace_resources.resource_type` by the published scan.
    resource_type: Option<&'a str>,
    featured_only: bool,
    installed_skill_ids: &'a [i64],
    keyword: Option<&'a str>,
    tags: &'a [String],
    limit: i64,
}

/// `fetch_visible_rows`: page through one discovery query until the requested
/// page is full or the source batch shrinks below the batch size.
async fn fetch_visible_rows<M>(
    mysql: &M,
    filters: &DiscoveryFilters<'_>,
    published: bool,
    initial_cursor: Option<&CursorPosition>,
) -> MysqlResult<Vec<ListingRow>>
where
    M: Mysql,
{
    let batch_size = filters.limit + 1;
    let uses_legacy_cursor =
        initial_cursor.is_some_and(|cursor| cursor.recommendation_score.is_none());
    let mut rows: Vec<ListingRow> = Vec::new();
    let mut position: Option<CursorPosition> = initial_cursor.cloned();
    loop {
        let sql = build_discovery_query(&QueryParts {
            kinds: filters.kinds,
            published,
            resource_type: filters.resource_type,
            score_floor: filters.featured_only,
            installed_skill_ids: filters.installed_skill_ids,
            keyword: filters.keyword,
            tags: filters.tags,
            cursor: position.as_ref(),
            batch_size,
        });
        let batch = fetch_discovery_rows(mysql, &sql).await?;
        if batch.is_empty() {
            break;
        }
        let batch_len = batch.len();
        let last = batch
            .last()
            .map(|row| (row.recommendation_score, row.sort_time, row.kinds_id));
        for row in batch {
            if is_visible_discovery_resource(&row) {
                rows.push(row);
                if rows.len() as i64 > filters.limit {
                    break;
                }
            }
        }
        if rows.len() as i64 > filters.limit || batch_len < batch_size as usize {
            break;
        }
        if let Some((score, time, id)) = last {
            position = Some(CursorPosition {
                recommendation_score: (!uses_legacy_cursor).then_some(score),
                updated_at: time,
                kind_id: id,
            });
        }
    }
    Ok(rows)
}

/// `_is_visible_discovery_resource`: a system Skill hides itself when
/// `spec.visible` is explicitly `false`.
fn is_visible_discovery_resource(row: &ListingRow) -> bool {
    is_visible_payload(row.payload(), row.kinds_user_id, &row.kinds_kind)
}

/// The predicate `_is_visible_discovery_resource` applies to one payload.
fn is_visible_payload(payload: Option<&KindPayload>, user_id: i64, kind: &str) -> bool {
    if user_id != 0 || kind != "Skill" {
        return true;
    }
    !matches!(
        payload.and_then(|payload| payload.spec.visible.as_ref()),
        Some(JsonScalar::Bool(false))
    )
}

/// `to_listing`.
async fn to_listing<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    source: &Source<'_>,
    user_id: i64,
    install_count: i64,
) -> MysqlResult<Listing>
where
    M: Mysql,
{
    let capability = effective_capability(source);
    let resource_type = resource_type_for_kind(source.kind).unwrap_or_default();
    let version = capability
        .version
        .as_ref()
        .filter(|value| !value.is_falsy())
        .map(JsonScalar::text)
        .unwrap_or_else(|| source_version(source));
    let status = capability
        .publish_status
        .as_ref()
        .map_or_else(|| "published".to_owned(), JsonScalar::text);
    let publisher_user_id = capability
        .published_by
        .as_ref()
        .and_then(publisher_id)
        .unwrap_or(source.user_id);
    let publisher_user_name = if publisher_user_id > 0 {
        fetch_user_name(mysql, publisher_user_id)
            .await?
            .map(|row| row.users_user_name)
    } else {
        None
    };
    let system = source.user_id == 0;
    let display_name = if system {
        spec_display_name(source)
    } else {
        non_falsy_text(capability.display_name.clone()).unwrap_or_else(|| spec_display_name(source))
    };
    let description = if system {
        non_falsy_text(source_field(source, |spec| spec.description.clone()))
            .or(first_text(capability.description.clone()))
    } else {
        non_falsy_text(capability.description.clone())
            .or(first_text(source_field(source, |spec| {
                spec.description.clone()
            })))
    };
    let icon = if system {
        non_falsy_text(source_field(source, |spec| spec.icon.clone()))
            .or(first_text(capability.icon.clone()))
    } else {
        non_falsy_text(capability.icon.clone())
            .or(first_text(source_field(source, |spec| spec.icon.clone())))
    };
    let tags = capability
        .tags
        .as_ref()
        .map(|values| values.iter().map(JsonScalar::text).collect())
        .unwrap_or_default();
    let feature_tags = if source.kind == "Skill" {
        source_list(source, |spec| spec.tags.clone())
            .unwrap_or_default()
            .iter()
            .map(JsonScalar::text)
            .collect()
    } else {
        Vec::new()
    };
    let bind_modes = if source.kind == "Team" {
        source_list(source, |spec| spec.bind_mode.clone())
            .unwrap_or_default()
            .iter()
            .map(JsonScalar::text)
            .collect()
    } else {
        Vec::new()
    };
    let target_groups = if source.kind == "Team" {
        agent_group_names(mysql, source).await?
    } else {
        normalize_group_names(
            capability
                .target_groups
                .as_ref()
                .map(|values| values.iter().map(JsonScalar::text).collect())
                .unwrap_or_default(),
        )
    };
    let is_installed = is_personally_installed(mysql, erp, source, user_id).await?;
    Ok(Listing {
        id: source.id,
        resource_type: resource_type.to_owned(),
        name: source.name.to_owned(),
        display_name,
        description,
        icon,
        tags,
        feature_tags,
        publisher_user_id,
        publisher_user_name,
        publisher_namespace: source.namespace.to_owned(),
        status: if status == "published" {
            "published".to_owned()
        } else {
            "archived".to_owned()
        },
        current_version_id: source.id,
        current_version: Version {
            id: source.id,
            listing_id: source.id,
            version,
            changelog: None,
            package_url: None,
            created_at: format_datetime(source.created_at),
            updated_at: format_datetime(source.updated_at),
        },
        install_count,
        is_installed,
        example_conversations: example_conversations(source),
        bind_modes,
        allow_personal_install: capability
            .allow_personal_install
            .as_ref()
            .is_none_or(|value| !value.is_falsy()),
        allow_group_install: capability
            .allow_group_install
            .as_ref()
            .is_none_or(|value| !value.is_falsy()),
        target_groups,
        created_at: format_datetime(source.created_at),
        updated_at: format_datetime(source.updated_at),
    })
}

/// `_effective_capability`.
fn effective_capability(source: &Source<'_>) -> Capability {
    if let Some(capability) = source
        .payload
        .and_then(|payload| payload.spec.capability.as_ref())
        && !capability.is_empty()
    {
        return capability.clone();
    }
    let version = Some(JsonScalar::Text(source_version(source)));
    if source.user_id == 0 {
        Capability {
            visibility: Some(JsonScalar::Text("public".to_owned())),
            publish_status: Some(JsonScalar::Text("published".to_owned())),
            version,
            allow_personal_install: Some(JsonScalar::Bool(true)),
            allow_group_install: Some(JsonScalar::Bool(true)),
            ..Capability::default()
        }
    } else {
        Capability {
            visibility: Some(JsonScalar::Text(
                if source.namespace == "default" {
                    "private"
                } else {
                    "group"
                }
                .to_owned(),
            )),
            publish_status: Some(JsonScalar::Text("draft".to_owned())),
            version,
            ..Capability::default()
        }
    }
}

/// `_source_version`: `str(spec.version or "1.0.0")`.
fn source_version(source: &Source<'_>) -> String {
    non_falsy_text(source_field(source, |spec| spec.version.clone()))
        .unwrap_or_else(|| "1.0.0".to_owned())
}

/// `_display_name` for a Skill: `spec.displayName or metadata.displayName or
/// name`; other kinds read `metadata.displayName or name`.
fn spec_display_name(source: &Source<'_>) -> String {
    let spec_value = first_non_falsy(source_field(source, |spec| spec.display_name.clone()));
    let metadata_value = source
        .payload
        .and_then(|payload| payload.metadata.display_name.clone());
    let chosen = if source.kind == "Skill" {
        spec_value.or(first_non_falsy(metadata_value))
    } else {
        first_non_falsy(metadata_value)
    };
    chosen.map_or_else(|| source.name.to_owned(), |value| value.text())
}

/// Read one `kinds.json.spec` member.
fn source_field(
    source: &Source<'_>,
    field: impl FnOnce(&super::models::KindSpec) -> Option<JsonScalar>,
) -> Option<JsonScalar> {
    source.payload.and_then(|payload| field(&payload.spec))
}

/// Read one `kinds.json.spec` list member.
fn source_list(
    source: &Source<'_>,
    field: impl FnOnce(&super::models::KindSpec) -> Option<Vec<JsonScalar>>,
) -> Option<Vec<JsonScalar>> {
    source.payload.and_then(|payload| field(&payload.spec))
}

/// `_description`, `_icon`, `_tags`, `_bind_modes`: the value is kept as-is
/// and rendered with Python `str` semantics.
fn first_text(value: Option<JsonScalar>) -> Option<String> {
    value.map(|scalar| scalar.text())
}

/// The left side of a Python `or` expression: falsy scalars fall through.
fn non_falsy_text(value: Option<JsonScalar>) -> Option<String> {
    first_non_falsy(value).map(|scalar| scalar.text())
}

/// `value or fallback` for scalars: empty strings, `0` and `false` fall
/// through.
fn first_non_falsy(value: Option<JsonScalar>) -> Option<JsonScalar> {
    value.filter(|scalar| !scalar.is_falsy())
}

/// `_is_personally_installed`.
async fn is_personally_installed<M>(
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
async fn user_default_skill_ids<M>(
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

/// `_agent_group_names`.
async fn agent_group_names<M>(mysql: &M, source: &Source<'_>) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    let mut group_names: Vec<String> = if source.namespace == "default" {
        Vec::new()
    } else {
        vec![source.namespace.to_owned()]
    };
    let member_group_ids: Vec<String> = fetch_team_group_members(mysql, source.id)
        .await?
        .into_iter()
        .map(|member| member.resource_members_entity_id)
        .collect();
    if !member_group_ids.is_empty() {
        let namespace_ids: Vec<i64> = member_group_ids
            .iter()
            .filter_map(|value| value.trim().parse().ok())
            .collect();
        group_names.extend(
            fetch_namespaces(mysql, &namespace_ids)
                .await?
                .into_iter()
                .map(|namespace| namespace.namespace_name),
        );
    }
    Ok(normalize_group_names(group_names))
}

/// `_normalize_group_names`.
fn normalize_group_names(values: Vec<String>) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for value in values {
        let name = value.trim();
        if name.is_empty() || name == "default" || result.iter().any(|existing| existing == name) {
            continue;
        }
        result.push(name.to_owned());
    }
    result
}

/// `_marketplace_examples` for an Agent listing.
fn example_conversations(source: &Source<'_>) -> Vec<ExampleConversation> {
    if source.kind != "Team" {
        return Vec::new();
    }
    let Some(entries) = source
        .payload
        .and_then(|payload| payload.spec.capability.as_ref())
        .and_then(|capability| capability.marketplace.as_ref())
        .and_then(|marketplace| marketplace.example_conversations.as_ref())
    else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let title = entry.title.as_ref()?;
            let url = entry.url.as_ref()?;
            match (title, url) {
                (JsonScalar::Text(title), JsonScalar::Text(url)) => Some(ExampleConversation {
                    title: title.trim().to_owned(),
                    url: url.trim().to_owned(),
                }),
                _ => None,
            }
        })
        .collect()
}

/// `_capability_publisher_id`: booleans and unparsable values are absent.
fn publisher_id(value: &JsonScalar) -> Option<i64> {
    match value {
        JsonScalar::Bool(_) => None,
        other => scalar_to_int(other),
    }
}

/// Python `int(value)` for a JSON scalar.
fn scalar_to_int(value: &JsonScalar) -> Option<i64> {
    match value {
        JsonScalar::Bool(value) => Some(i64::from(*value)),
        JsonScalar::Int(value) => Some(*value),
        JsonScalar::Float(value) => Some(*value as i64),
        JsonScalar::Text(value) => value.trim().parse().ok(),
    }
}

/// `_decode_discovery_cursor`: base64url JSON with `updated_at` and
/// `kind_id`. Invalid cursors raise `HTTPException(400, "Invalid discovery
/// cursor")`.
fn decode_cursor(value: &str) -> Result<CursorPosition, FastApiError> {
    use base64::Engine as _;
    let padding = "=".repeat((4 - value.len() % 4) % 4);
    let padded = format!("{value}{padding}");
    let decoded = base64::engine::general_purpose::URL_SAFE
        .decode(padded.as_bytes())
        .map_err(|_| invalid_cursor())?;
    let payload: CursorPayload = serde_json::from_slice(&decoded).map_err(|_| invalid_cursor())?;
    let updated_at = parse_cursor_time(&payload.updated_at).ok_or_else(invalid_cursor)?;
    let kind_id = payload.kind_id.to_i64().ok_or_else(invalid_cursor)?;
    let recommendation_score = payload
        .recommendation_score
        .as_ref()
        .map(|score| score.to_i64().ok_or_else(invalid_cursor))
        .transpose()?;
    if kind_id <= 0 || recommendation_score.is_some_and(|score| !(0..=100).contains(&score)) {
        return Err(invalid_cursor());
    }
    Ok(CursorPosition {
        recommendation_score,
        updated_at,
        kind_id,
    })
}

/// Parse one cursor `updated_at`, normalizing an offset timestamp to UTC
/// naive time like the source.
fn parse_cursor_time(value: &str) -> Option<NaiveDateTime> {
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(parsed);
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.naive_utc())
}

/// `_encode_discovery_cursor`: base64url JSON without padding.
fn encode_cursor(position: &CursorPosition) -> Option<String> {
    use base64::Engine as _;
    #[derive(serde::Serialize)]
    struct CursorOut<'a> {
        updated_at: &'a str,
        kind_id: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        recommendation_score: Option<i64>,
    }
    let updated_at = position
        .updated_at
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string();
    let payload = serde_json::to_vec(&CursorOut {
        updated_at: &updated_at,
        kind_id: position.kind_id,
        recommendation_score: position.recommendation_score,
    })
    .ok()?;
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload))
}

/// `HTTPException(400, "Invalid discovery cursor")`.
fn invalid_cursor() -> FastApiError {
    FastApiError::detail(StatusCode::BAD_REQUEST, "Invalid discovery cursor")
}

/// The source's `python_exception_handler` 500 body.
pub(super) fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "resource-library listings dependency failed");
    internal_error_body()
}

/// The source's `python_exception_handler` 500 body without a dependency
/// error.
pub(super) fn internal_error_body() -> FastApiError {
    #[derive(serde::Serialize)]
    struct Body {
        error_code: u16,
        detail: &'static str,
    }
    FastApiError::json_body(
        StatusCode::INTERNAL_SERVER_ERROR,
        Body {
            error_code: 500,
            detail: "Internal server error",
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naive(hour: u32) -> NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 7, 2)
            .unwrap()
            .and_hms_opt(hour, 57, 54)
            .unwrap()
    }

    fn kind_payload(json: serde_json::Value) -> KindPayload {
        serde_json::from_value(json).expect("test payload projects")
    }

    fn source<'a>(payload: &'a KindPayload, kind: &'a str) -> Source<'a> {
        Source {
            id: 41,
            user_id: 0,
            kind,
            name: "alpha",
            namespace: "default",
            payload: Some(payload),
            created_at: naive(11),
            updated_at: naive(12),
        }
    }

    #[test]
    fn datetime_serialization_matches_pydantic() {
        assert_eq!(format_datetime(naive(11)), "2026-07-02T11:57:54");
        let with_micros = naive(11) + chrono::Duration::microseconds(123_000);
        assert_eq!(format_datetime(with_micros), "2026-07-02T11:57:54.123000");
    }

    #[test]
    fn capability_defaults_when_absent_or_empty() {
        for json in [
            serde_json::json!({"spec": {}}),
            serde_json::json!({"spec": {"capability": {}}}),
        ] {
            let payload = kind_payload(json);
            let capability = effective_capability(&source(&payload, "Skill"));
            assert_eq!(
                capability
                    .visibility
                    .as_ref()
                    .map(JsonScalar::text)
                    .as_deref(),
                Some("public")
            );
            assert_eq!(
                capability
                    .publish_status
                    .as_ref()
                    .map(JsonScalar::text)
                    .as_deref(),
                Some("published")
            );
            assert_eq!(source_version(&source(&payload, "Skill")), "1.0.0");
        }
    }

    #[test]
    fn capability_members_win_over_defaults() {
        let payload = kind_payload(serde_json::json!({
            "spec": {"capability": {
                "visibility": "public",
                "publishStatus": "archived",
                "version": "2.1.0",
                "displayName": "Alpha",
                "tags": ["daily_work"],
                "allowPersonalInstall": false,
                "marketplace": {"recommendationScore": 90}
            }}
        }));
        let capability = effective_capability(&source(&payload, "Skill"));
        assert_eq!(
            capability.version.as_ref().map(JsonScalar::text).as_deref(),
            Some("2.1.0")
        );
        assert!(!capability.is_empty());
    }

    #[test]
    fn empty_capability_scalars_fall_through_to_source_values() {
        let payload = kind_payload(serde_json::json!({
            "metadata": {"displayName": "Meta"},
            "spec": {
                "displayName": "",
                "version": "",
                "capability": {"displayName": "Cap"}
            }
        }));
        let skill = source(&payload, "Skill");
        assert_eq!(spec_display_name(&skill), "Meta");
        assert_eq!(source_version(&skill), "1.0.0");
    }

    #[test]
    fn non_system_capability_is_private_by_default() {
        let payload = kind_payload(serde_json::json!({"spec": {}}));
        let mut skill = source(&payload, "Team");
        skill.user_id = 9;
        let capability = effective_capability(&skill);
        assert_eq!(
            capability
                .visibility
                .as_ref()
                .map(JsonScalar::text)
                .as_deref(),
            Some("private")
        );
        assert_eq!(
            capability
                .publish_status
                .as_ref()
                .map(JsonScalar::text)
                .as_deref(),
            Some("draft")
        );
    }

    #[test]
    fn agent_group_names_drop_default_and_duplicates() {
        assert_eq!(
            normalize_group_names(vec![
                "default".to_owned(),
                " team-a ".to_owned(),
                "team-a".to_owned(),
                String::new(),
                "team-b".to_owned(),
            ]),
            vec!["team-a".to_owned(), "team-b".to_owned()]
        );
    }

    #[test]
    fn cursor_round_trips_through_base64url() {
        let encoded = encode_cursor(&CursorPosition {
            recommendation_score: Some(80),
            updated_at: naive(11),
            kind_id: 259_748,
        })
        .unwrap();
        let decoded = decode_cursor(&encoded).unwrap();
        assert_eq!(decoded.recommendation_score, Some(80));
        assert_eq!(decoded.updated_at, naive(11));
        assert_eq!(decoded.kind_id, 259_748);
    }

    #[test]
    fn invalid_cursors_report_http_400() {
        let error = decode_cursor("not-base64!!").unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert!(
            error
                .validation_detail()
                .contains("Invalid discovery cursor")
        );
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
    fn publisher_id_ignores_booleans() {
        assert_eq!(publisher_id(&JsonScalar::Bool(true)), None);
        assert_eq!(publisher_id(&JsonScalar::Int(7)), Some(7));
        assert_eq!(publisher_id(&JsonScalar::Text(" 7 ".to_owned())), Some(7));
        assert_eq!(publisher_id(&JsonScalar::Text("7.5".to_owned())), None);
    }

    #[test]
    fn hidden_system_skills_are_filtered_out() {
        let hidden = kind_payload(serde_json::json!({"spec": {"visible": false}}));
        let visible = kind_payload(serde_json::json!({"spec": {}}));
        assert!(!is_visible_payload(Some(&hidden), 0, "Skill"));
        assert!(is_visible_payload(Some(&visible), 0, "Skill"));
        assert!(is_visible_payload(Some(&hidden), 7, "Skill"));
        assert!(is_visible_payload(Some(&hidden), 0, "Team"));
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

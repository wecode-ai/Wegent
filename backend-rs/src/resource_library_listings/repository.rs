// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL access for `GET /api/resource-library/listings`.
//!
//! Every statement mirrors the SQL the source SQLAlchemy session renders (and
//! the recording captured as text `COM_QUERY`), so the projected columns,
//! aliases, ordering and filters stay identical. Values the source renders as
//! inline literals stay inline; `quote_literal` escapes the only
//! request-provided strings that reach a statement.

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

use brz_json::JsonProjection;

use super::models::KindPayload;

/// `db.query(Kind)` column projection with SQLAlchemy's `kinds_<column>`
/// aliases.
pub const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS \
     kinds_created_at, kinds.updated_at AS kinds_updated_at";

/// `_system_marketplace_recommendation_score_expression`: the JSON
/// recommendation score as an integer, `0` when unset.
pub const RECOMMENDATION_SCORE: &str = "CASE WHEN \
     (coalesce(json_unquote(json_extract(kinds.json, \
     '$.spec.capability.marketplace.recommendationScore')), '') = '') THEN 0 ELSE \
     CAST(coalesce(json_unquote(json_extract(kinds.json, \
     '$.spec.capability.marketplace.recommendationScore')), '') AS SIGNED INTEGER) END";

/// `FEATURED_RECOMMENDATION_SCORE`.
pub const FEATURED_RECOMMENDATION_SCORE: i64 = 80;

/// `resource_members` column projection with SQLAlchemy's aliases.
pub const RESOURCE_MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
     resource_members.resource_type AS resource_members_resource_type, \
     resource_members.resource_id AS resource_members_resource_id, \
     resource_members.entity_type AS resource_members_entity_type, \
     resource_members.entity_id AS resource_members_entity_id, \
     resource_members.entity_display_name AS resource_members_entity_display_name, \
     resource_members.user_id AS resource_members_user_id, resource_members.`role` AS \
     resource_members_role, resource_members.status AS resource_members_status, \
     resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
     resource_members.share_link_id AS resource_members_share_link_id, \
     resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
     resource_members.reviewed_at AS resource_members_reviewed_at, \
     resource_members.copied_resource_id AS resource_members_copied_resource_id, \
     resource_members.requested_at AS resource_members_requested_at, \
     resource_members.created_at AS resource_members_created_at, \
     resource_members.updated_at AS resource_members_updated_at";

/// `MarketplaceResource` column projection with SQLAlchemy's
/// `marketplace_resources_<column>` aliases.
pub const MARKETPLACE_RESOURCE_COLUMNS: &str = "marketplace_resources.kind_id AS \
     marketplace_resources_kind_id, marketplace_resources.owner_user_id AS \
     marketplace_resources_owner_user_id, marketplace_resources.resource_type AS \
     marketplace_resources_resource_type, marketplace_resources.recommendation_score AS \
     marketplace_resources_recommendation_score, marketplace_resources.install_count AS \
     marketplace_resources_install_count, marketplace_resources.published_at AS \
     marketplace_resources_published_at, marketplace_resources.updated_at AS \
     marketplace_resources_updated_at";

/// One `kinds` row read through [`KIND_COLUMNS`]. The binding probes only
/// read the identity, namespace and JSON members.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code, reason = "selected to match the source column list")]
pub struct KindRow {
    pub kinds_id: i64,
    pub kinds_user_id: i64,
    pub kinds_kind: String,
    pub kinds_name: String,
    pub kinds_namespace: String,
    pub(super) kinds_json: Option<Json<JsonProjection<KindPayload>>>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub kinds_is_active: i8,
    pub kinds_created_at: NaiveDateTime,
    pub kinds_updated_at: NaiveDateTime,
}

/// One discovery row: the `kinds` columns plus the query's sort key,
/// install count and recommendation score.
#[derive(Debug, FromMysqlRow)]
pub struct ListingRow {
    pub kinds_id: i64,
    pub kinds_user_id: i64,
    pub kinds_kind: String,
    pub kinds_name: String,
    pub kinds_namespace: String,
    kinds_json: Option<Json<JsonProjection<KindPayload>>>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub kinds_is_active: i8,
    pub kinds_created_at: NaiveDateTime,
    pub kinds_updated_at: NaiveDateTime,
    pub sort_time: NaiveDateTime,
    pub install_count: i64,
    pub recommendation_score: i64,
}

/// A row that carries a projected `kinds.json` payload.
pub trait KindPayloadRow {
    /// The projected payload, absent when the stored JSON has another shape.
    fn payload(&self) -> Option<&KindPayload>;
}

impl KindPayloadRow for KindRow {
    fn payload(&self) -> Option<&KindPayload> {
        self.kinds_json
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
    }
}

impl KindPayloadRow for ListingRow {
    fn payload(&self) -> Option<&KindPayload> {
        self.kinds_json
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
    }
}

/// One approved `resource_members` row (`_agent_group_names`).
#[derive(Debug, FromMysqlRow)]
pub struct ResourceMemberRow {
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_resource_type: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_resource_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_entity_type: String,
    pub resource_members_entity_id: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_entity_display_name: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_user_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_role: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_status: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_invited_by_user_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_share_link_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_reviewed_by_user_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_reviewed_at: Option<NaiveDateTime>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_copied_resource_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_requested_at: Option<NaiveDateTime>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_created_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_members_updated_at: NaiveDateTime,
}

/// One active `namespace` row.
#[derive(Debug, FromMysqlRow)]
pub struct NamespaceRow {
    #[allow(dead_code, reason = "selected for the source column list")]
    pub namespace_id: i64,
    pub namespace_name: String,
}

/// One `users` entity row read through the bare `Session.get` projection
/// SQLAlchemy renders for `db.get(User, id)`; only `user_name` is projected
/// into the listing body.
#[derive(Debug, FromMysqlRow)]
pub struct UserNameRow {
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub id: i64,
    pub user_name: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub password_hash: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub email: Option<String>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub git_info: brz_mysql::Json<brz_json::OpaqueJson>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub is_active: i8,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub role: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub auth_source: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub preferences: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub updated_at: chrono::NaiveDateTime,
}

/// One `resource_members.id` presence row.
#[derive(Debug, FromMysqlRow)]
pub struct PresenceRow {
    #[allow(dead_code, reason = "presence only; the id value is unused")]
    pub resource_members_id: i64,
}

/// One `marketplace_resources` publication row read through
/// [`MARKETPLACE_RESOURCE_COLUMNS`]. `list_published` reads the publication's
/// `kind_id` and `install_count`; the remaining selected columns stay in the
/// statement to match the recorded exchange.
#[derive(Debug, FromMysqlRow)]
pub struct PublishedRow {
    pub marketplace_resources_kind_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub marketplace_resources_owner_user_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub marketplace_resources_resource_type: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub marketplace_resources_recommendation_score: i64,
    pub marketplace_resources_install_count: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub marketplace_resources_published_at: Option<NaiveDateTime>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub marketplace_resources_updated_at: NaiveDateTime,
}

/// The `count(*)` row of `query.count()`.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    count_1: i64,
}

/// A decoded discovery cursor position
/// (`_decode_discovery_cursor`).
#[derive(Debug, Clone)]
pub struct CursorPosition {
    pub recommendation_score: Option<i64>,
    pub updated_at: NaiveDateTime,
    pub kind_id: i64,
}

/// The discovery query's variable inputs.
pub struct QueryParts<'a> {
    pub kinds: &'a [&'a str],
    pub published: bool,
    pub resource_type: Option<&'a str>,
    pub score_floor: bool,
    pub installed_skill_ids: &'a [i64],
    pub keyword: Option<&'a str>,
    pub tags: &'a [String],
    pub cursor: Option<&'a CursorPosition>,
    pub batch_size: i64,
}

/// Build one discovery statement. The system and published queries share the
/// same filter chain; only their projection, score/sort expressions and joins
/// differ.
#[must_use]
pub fn build_discovery_query(parts: &QueryParts<'_>) -> String {
    let score_expr = if parts.published {
        "marketplace_resources.recommendation_score"
    } else {
        RECOMMENDATION_SCORE
    };
    let sort_expr = if parts.published {
        "marketplace_resources.updated_at"
    } else {
        "kinds.updated_at"
    };
    let mut sql = if parts.published {
        format!(
            "SELECT {KIND_COLUMNS}, marketplace_resources.updated_at AS sort_time, \
             marketplace_resources.install_count AS install_count, \
             marketplace_resources.recommendation_score AS recommendation_score \n\
             FROM marketplace_resources INNER JOIN kinds ON kinds.id = \
             marketplace_resources.kind_id \n\
             WHERE kinds.user_id != 0 AND kinds.kind IN ({}) AND kinds.is_active = true",
            quote_list(parts.kinds)
        )
    } else {
        format!(
            "SELECT {KIND_COLUMNS}, kinds.updated_at AS sort_time, 0 AS install_count, \
             {RECOMMENDATION_SCORE} AS recommendation_score \nFROM kinds \n\
             WHERE kinds.user_id = 0 AND kinds.kind IN ({}) AND kinds.is_active = true",
            quote_list(parts.kinds)
        )
    };
    if parts.published
        && let Some(resource_type) = parts.resource_type
    {
        sql.push_str(&format!(
            " AND marketplace_resources.resource_type = {}",
            quote_literal(resource_type)
        ));
    }
    if parts.score_floor {
        sql.push_str(&format!(
            " AND {score_expr} >= {FEATURED_RECOMMENDATION_SCORE}"
        ));
    }
    if let Some(filter) = installed_skill_filter(parts.installed_skill_ids) {
        sql.push_str(&format!(" AND {filter}"));
    }
    if let Some(keyword) = parts.keyword.filter(|value| !value.is_empty()) {
        sql.push_str(&format!(" AND {}", keyword_filter(keyword)));
    }
    for tag in parts.tags {
        sql.push_str(&format!(" AND {}", tag_filter(tag)));
    }
    if let Some(cursor) = parts.cursor {
        sql.push_str(&format!(
            " AND {}",
            cursor_predicate(cursor, score_expr, sort_expr)
        ));
    }
    sql.push_str(&format!(
        " ORDER BY {score_expr} DESC, {sort_expr} DESC, kinds.id DESC \n LIMIT {}",
        parts.batch_size
    ));
    sql
}

/// `or_(Kind.kind != 'Skill', Kind.id.notin_(installed_skill_ids))`. The ids
/// are already in the source's `set[int]` iteration order.
#[must_use]
pub fn installed_skill_filter(installed_skill_ids: &[i64]) -> Option<String> {
    if installed_skill_ids.is_empty() {
        return None;
    }
    Some(format!(
        "(kinds.kind != 'Skill' OR (kinds.id NOT IN ({})))",
        installed_skill_ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// The `keyword` filter over the source's eight searchable fields.
fn keyword_filter(normalized_keyword: &str) -> String {
    let pattern = format!("%{}%", escape_sql_like(normalized_keyword));
    let fields = [
        "lower(kinds.name)".to_owned(),
        lower_json_text("$.spec.capability.displayName"),
        lower_json_text("$.spec.displayName"),
        lower_json_text("$.metadata.displayName"),
        // Source: `func.lower(case((Kind.kind != "Skill", ...), else_=""))`.
        "lower(CASE WHEN (kinds.kind != 'Skill') THEN coalesce(json_unquote(json_extract(kinds.json, '$.spec.capability.description')), '') ELSE '' END)".to_owned(),
        lower_json_text("$.spec.description"),
        lower_json_text("$.spec.capability.tags"),
        lower_json_text("$.spec.tags"),
    ];
    let conditions = fields
        .iter()
        .map(|field| format!("{field} LIKE {} ESCAPE '\\\\'", quote_literal(&pattern)))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!("({conditions})")
}

/// One tag filter: the lowercased JSON-encoded tag inside the capability or
/// spec tag arrays.
fn tag_filter(tag: &str) -> String {
    let encoded_tag = json_escape(&tag.trim().to_lowercase());
    let pattern = format!("%\"{}\"%", escape_sql_like(&encoded_tag));
    let capability = lower_json_text("$.spec.capability.tags");
    format!(
        "{capability} LIKE {} ESCAPE '\\\\'",
        quote_literal(&pattern)
    )
}

/// `_resource_json_text`: `coalesce(json_unquote(json_extract(...)), '')`,
/// wrapped in `lower(...)` for a case-insensitive comparison.
fn lower_json_text(path: &str) -> String {
    format!(
        "lower(coalesce(json_unquote(json_extract(kinds.json, {})), ''))",
        quote_literal(path)
    )
}

/// The cursor continuation predicate for the selected score and sort
/// expressions. `_decode_discovery_cursor` without a score keeps the legacy
/// `(updated_at, id)` ordering.
///
/// The rendered text mirrors the SQLAlchemy compound expression exactly: the
/// source nests `or_` inside an `and_` inside the outer `and_` filter chain, so
/// only the outer `or_` needs parentheses. MySQL `AND` binds tighter than `OR`,
/// and SQLAlchemy emits no redundant group around either child, so the recorded
/// statement is `... AND (score < S OR score = S AND (time < T OR time = T AND
/// id < I))`. Replay matches this statement against the recorded exchange, so
/// the grouping must stay identical.
fn cursor_predicate(cursor: &CursorPosition, score_expr: &str, sort_expr: &str) -> String {
    let time = quote_literal(&sql_datetime_literal(cursor.updated_at));
    let id = cursor.kind_id;
    match cursor.recommendation_score {
        None => format!("({sort_expr} < {time} OR {sort_expr} = {time} AND kinds.id < {id})"),
        Some(score) => format!(
            "({score_expr} < {score} OR {score_expr} = {score} AND ({sort_expr} < {time} OR \
             {sort_expr} = {time} AND kinds.id < {id}))"
        ),
    }
}

/// One `kinds.updated_at` style value as the source's inline MySQL literal.
/// pymysql escapes a bound `datetime` as `datetime.isoformat(" ")`, which omits
/// the fractional part when the microseconds are zero and otherwise keeps six
/// digits; SQLAlchemy's inline literal rendering of the cursor bound follows the
/// same rule.
fn sql_datetime_literal(value: NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%d %H:%M:%S").to_string();
    let micros = value.and_utc().timestamp_subsec_micros();
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

/// `_escape_sql_like`.
#[must_use]
pub fn escape_sql_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// `json.dumps(value, ensure_ascii=False)[1:-1]`: the JSON string body used
/// to match one tag inside a stored JSON array.
fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            other if other < '\u{20}' => {
                out.push_str(&format!("\\u{:04x}", u32::from(other)));
            }
            other => out.push(other),
        }
    }
    out
}

/// `quote_literal`: MySQL single-quoted string escaping for the request
/// strings that the source renders inline (keyword and tag LIKE patterns).
///
/// Escapes by character, not byte: SQLAlchemy renders a `str` literal through
/// pymysql, which escapes the special characters and keeps every other
/// character (including multi-byte UTF-8) intact. Iterating bytes and pushing
/// `char::from(byte)` would re-encode each UTF-8 byte as a separate Latin-1
/// character, so a keyword like `微博` would reach MySQL as `å¾®å`.
#[must_use]
pub fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for character in value.chars() {
        match character {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{1a}' => out.push_str("\\Z"),
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

/// `list_user_default_bindings`: the user's active SkillBinding rows.
pub async fn fetch_user_default_bindings<M>(mysql: &M, user_id: i64) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = {user_id} \
                 AND kinds.kind = 'SkillBinding' AND kinds.namespace = 'default' \
                 AND kinds.is_active = true ORDER BY kinds.created_at DESC"
            ),
            (),
        )
        .await
}

/// `_get_active_skill`.
pub async fn fetch_active_skill<M>(mysql: &M, skill_id: i64) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = {skill_id} \
                 AND kinds.kind = 'Skill' AND kinds.is_active = true \n LIMIT 1"
            ),
            (),
        )
        .await
}

/// One discovery page query.
pub async fn fetch_discovery_rows<M>(mysql: &M, sql: &str) -> MysqlResult<Vec<ListingRow>>
where
    M: Mysql,
{
    mysql.fetch_all(sql, ()).await
}

/// `_agent_group_names`: approved `namespace` entity grants for one Team.
pub async fn fetch_team_group_members<M>(
    mysql: &M,
    resource_id: i64,
) -> MysqlResult<Vec<ResourceMemberRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            format!(
                "SELECT {RESOURCE_MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type = 'Team' AND \
                 resource_members.resource_id = {resource_id} AND \
                 resource_members.entity_type = 'namespace' AND \
                 resource_members.status = 'approved'"
            ),
            (),
        )
        .await
}

/// The active namespaces behind the given ids, ordered by id.
pub async fn fetch_namespaces<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<NamespaceRow>>
where
    M: Mysql,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    mysql
        .fetch_all(
            format!(
                "SELECT namespace.id AS namespace_id, namespace.name AS namespace_name \n\
                 FROM namespace \nWHERE namespace.id IN ({}) AND namespace.is_active IS true \
                 ORDER BY namespace.id",
                ids.iter()
                    .map(i64::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            (),
        )
        .await
}

/// `db.get(User, id)` for the resolved publisher: the unlabeled entity
/// projection SQLAlchemy renders for a `Session.get` lookup, with the id
/// bound as a statement parameter like the source driver.
pub async fn fetch_user_name<M>(mysql: &M, user_id: i64) -> MysqlResult<Option<UserNameRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT users.id, users.user_name, users.password_hash, users.email, \
             users.git_info, users.is_active, users.`role`, users.auth_source, \
             users.preferences, users.created_at, users.updated_at \
             \nFROM users \nWHERE users.id = ?",
            (user_id,),
        )
        .await
}

/// `list_published`'s publication filter: `owner_user_id == current_user.id`
/// plus the optional `resource_type` equality. A resource type is an
/// endpoint-pattern value, rendered as an inline literal like the source.
fn published_filter(owner_user_id: i64, resource_type: Option<&str>) -> String {
    match resource_type {
        Some(value) => format!(
            "marketplace_resources.owner_user_id = {owner_user_id} AND \
             marketplace_resources.resource_type = {}",
            quote_literal(value)
        ),
        None => format!("marketplace_resources.owner_user_id = {owner_user_id}"),
    }
}

/// `publication_query.order_by(None).count()`: the source wraps the filtered
/// `MarketplaceResource` projection in `SELECT count(*) AS count_1 ... AS anon_1`.
#[must_use]
pub fn published_count_sql(owner_user_id: i64, resource_type: Option<&str>) -> String {
    format!(
        "SELECT count(*) AS count_1 \nFROM (SELECT {MARKETPLACE_RESOURCE_COLUMNS} \n\
         FROM marketplace_resources \nWHERE {}) AS anon_1",
        published_filter(owner_user_id, resource_type)
    )
}

/// `publication_query.order_by(updated_at.desc(), kind_id.desc())
/// .offset((page - 1) * limit).limit(limit)`. SQLAlchemy renders the offset
/// and limit as inline literals; both are validated integers, so inlining is
/// injection-safe.
#[must_use]
pub fn published_page_sql(
    owner_user_id: i64,
    resource_type: Option<&str>,
    offset: i64,
    limit: i64,
) -> String {
    format!(
        "SELECT {MARKETPLACE_RESOURCE_COLUMNS} \nFROM marketplace_resources \n\
         WHERE {} ORDER BY marketplace_resources.updated_at DESC, \
         marketplace_resources.kind_id DESC \n LIMIT {offset}, {limit}",
        published_filter(owner_user_id, resource_type)
    )
}

/// `list_published`'s `order_by(None).count()`.
pub async fn fetch_published_count<M>(
    mysql: &M,
    owner_user_id: i64,
    resource_type: Option<&str>,
) -> MysqlResult<i64>
where
    M: Mysql,
{
    let row: Option<CountRow> = mysql
        .fetch_optional(published_count_sql(owner_user_id, resource_type), ())
        .await?;
    Ok(row.map_or(0, |row| row.count_1))
}

/// `list_published`'s page query.
pub async fn fetch_published_page<M>(
    mysql: &M,
    owner_user_id: i64,
    resource_type: Option<&str>,
    offset: i64,
    limit: i64,
) -> MysqlResult<Vec<PublishedRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            published_page_sql(owner_user_id, resource_type, offset, limit),
            (),
        )
        .await
}

/// `list_published`'s batch `db.query(Kind).filter(Kind.id.in_(kind_ids),
/// Kind.is_active == True).all()`. `None` when `kind_ids` is empty, which is
/// the source's `resources = [...] if kind_ids else []` skip. The `IN` list
/// follows the publication order the source's list comprehension keeps.
#[must_use]
pub fn published_kinds_sql(ids: &[i64]) -> Option<String> {
    if ids.is_empty() {
        return None;
    }
    Some(format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id IN ({}) AND \
         kinds.is_active = true",
        ids.iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// `list_published`'s batch Kind lookup.
pub async fn fetch_kinds_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    let Some(sql) = published_kinds_sql(ids) else {
        return Ok(Vec::new());
    };
    mysql.fetch_all(sql, ()).await
}

/// `has_personal_capability_reference`.
pub async fn has_resource_reference<M>(
    mysql: &M,
    resource_type: &str,
    resource_id: i64,
    user_id: i64,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    let row: Option<PresenceRow> = mysql
        .fetch_optional(
            format!(
                "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n\
                 WHERE resource_members.resource_type = {} AND resource_members.resource_id = \
                 {resource_id} AND resource_members.entity_type = 'user' AND \
                 resource_members.entity_id = {} AND resource_members.status = 'approved' \n \
                 LIMIT 1",
                quote_literal(resource_type),
                quote_literal(&user_id.to_string())
            ),
            (),
        )
        .await?;
    Ok(row.is_some())
}

/// `_is_personally_installed`'s Team membership probe.
pub async fn has_team_member<M>(mysql: &M, resource_id: i64, user_id: i64) -> MysqlResult<bool>
where
    M: Mysql,
{
    let row: Option<PresenceRow> = mysql
        .fetch_optional(
            format!(
                "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n\
                 WHERE resource_members.resource_type = 'Team' AND resource_members.resource_id \
                 = {resource_id} AND resource_members.entity_type = 'user' AND \
                 resource_members.entity_id = {} AND resource_members.status = 'approved' \n \
                 LIMIT 1",
                quote_literal(&user_id.to_string())
            ),
            (),
        )
        .await?;
    Ok(row.is_some())
}

/// Render a literal `IN` list of Kind names.
fn quote_list(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| quote_literal(value))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
#[path = "repository_tests.rs"]
mod tests;

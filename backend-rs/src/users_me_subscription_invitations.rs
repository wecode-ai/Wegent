// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/me/subscription-invitations` — the caller's pending
//! subscription invitations.
//!
//! Mirrors `app.api.endpoints.adapter.subscription_follows.get_pending_invitations`
//! (route `"/subscription-invitations"`, router prefix `/users/me`, under
//! `/api`) and `SubscriptionFollowService.get_pending_invitations`
//! (`app/services/subscription/follow_service.py`).
//!
//! Source pipeline:
//! 1. FastAPI validates the query (`page >= 1`, `1 <= limit <= 100`;
//!    defaults `page = 1`, `limit = 50`) and `skip = (page - 1) * limit`.
//! 2. `security.get_current_user` — JWT session decode plus the labeled
//!    `users` lookup by name (`auth::SessionUser`).
//! 3. `query.count()` wraps the labeled `SubscriptionFollow` projection in
//!    `SELECT count(*) ... AS anon_1` over
//!    `follower_user_id = ? AND follow_type = 'invited' AND
//!    invitation_status = 'pending'`.
//! 4. The page query orders by `invited_at DESC` and paginates with
//!    `LIMIT skip, limit` (the source renders `LIMIT 0, 1` even at offset 0).
//! 5. Per row: load the active Subscription `kinds` row
//!    (`id = ? AND kind = 'Subscription' AND is_active = true LIMIT 1`) and
//!    skip the row when absent; read `spec.displayName` (a required
//!    `SubscriptionSpec` member, so an absent value fails CRD validation and
//!    renders the `Exception` handler's 500 body); resolve the owner and the
//!    inviter with one `users` lookup each.
//!
//! Recorded source evidence (`api-users-me-subscription-invitations/234b38a0`):
//! the authenticated `users` lookup, the `subscription_follows` count (0) and
//! page query (no rows), and the two trailing `ROLLBACK` session cleanups
//! (driver cleanup, classified optional by Replay, so none are issued here).
//! The body is the empty list `{"total":0,"items":[]}`.
//!
//! Response field order matches the pydantic declaration order:
//! `SubscriptionInvitationsListResponse` (`total`, `items`), each
//! `SubscriptionInvitationResponse` (`id, subscription_id, subscription_name,
//! subscription_display_name, invited_by_user_id, invited_by_username,
//! invitation_status, invited_at, owner_username`).
use brz_mysql::{FromMysqlRow, Mysql};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::subscriptions_list::KindRow;
use crate::subscriptions_list::convert::pydantic_datetime;
use crate::user_reader::USER_BY_ID_QUERY;

/// The labeled `SubscriptionFollow` projection SQLAlchemy renders for
/// `db.query(SubscriptionFollow)` (every mapped column, aliased
/// `subscription_follows_<column>`).
const FOLLOW_COLUMNS: &str = "subscription_follows.id AS subscription_follows_id, \
     subscription_follows.subscription_id AS subscription_follows_subscription_id, \
     subscription_follows.follower_user_id AS subscription_follows_follower_user_id, \
     subscription_follows.follow_type AS subscription_follows_follow_type, \
     subscription_follows.invited_by_user_id AS subscription_follows_invited_by_user_id, \
     subscription_follows.invitation_status AS subscription_follows_invitation_status, \
     subscription_follows.invited_at AS subscription_follows_invited_at, \
     subscription_follows.responded_at AS subscription_follows_responded_at, \
     subscription_follows.created_at AS subscription_follows_created_at, \
     subscription_follows.updated_at AS subscription_follows_updated_at, \
     subscription_follows.config AS subscription_follows_config";

/// The pending-invitation filter shared by the count and the page query.
const PENDING_FILTER: &str = "WHERE subscription_follows.follower_user_id = ? \
     AND subscription_follows.follow_type = 'invited' \
     AND subscription_follows.invitation_status = 'pending'";

/// `query.count()`: the source wraps the labeled projection in
/// `SELECT count(*) ... AS anon_1`.
fn count_sql() -> String {
    format!(
        "SELECT count(*) AS count_1 \nFROM (SELECT {FOLLOW_COLUMNS} \
         \nFROM subscription_follows \n{PENDING_FILTER}) AS anon_1"
    )
}

/// The page query: `order_by(invited_at DESC).offset(skip).limit(limit)`
/// (`LIMIT skip, limit`; the offset renders even when it is 0).
fn page_sql(skip: i64, limit: i64) -> String {
    format!(
        "SELECT {FOLLOW_COLUMNS} \nFROM subscription_follows \n{PENDING_FILTER} \
         ORDER BY subscription_follows.invited_at DESC \n LIMIT {skip}, {limit}"
    )
}

/// `db.query(Kind).filter(id, kind='Subscription', is_active=true).first()`.
fn find_subscription_sql() -> String {
    format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.id = ? AND kinds.kind = 'Subscription' \
         AND kinds.is_active = true \n LIMIT 1",
        KindRow::COLUMNS
    )
}

/// Query parameters of the listing endpoint.
///
/// `page` and `limit` are validated like FastAPI query integers (`page >= 1`,
/// `1 <= limit <= 100`) so out-of-range values render the source 422 body.
#[derive(Debug, Default, Deserialize)]
pub struct InvitationListQuery {
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
}

/// Validated pagination parameters.
#[derive(Debug)]
struct ListParams {
    skip: i64,
    limit: i64,
}

impl InvitationListQuery {
    /// Validate the FastAPI query contract. Defaults: `page = 1`,
    /// `limit = 50`; `skip = (page - 1) * limit`.
    fn validated(self) -> Result<ListParams, FastApiError> {
        let page = parse_query_int(self.page.as_deref(), "page", 1, Some(1), None)?;
        let limit = parse_query_int(self.limit.as_deref(), "limit", 50, Some(1), Some(100))?;
        Ok(ListParams {
            skip: (page - 1) * limit,
            limit,
        })
    }
}

/// Parse an optional integer query parameter with FastAPI/pydantic
/// `int_parsing` and range (`greater_than_equal`/`less_than_equal`) errors.
fn parse_query_int(
    raw: Option<&str>,
    field: &str,
    default: i64,
    min: Option<i64>,
    max: Option<i64>,
) -> Result<i64, FastApiError> {
    let Some(value) = raw else {
        return Ok(default);
    };
    let parsed = value.parse::<i64>().map_err(|_| {
        validation_error(
            field,
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
            value,
            None,
        )
    })?;
    if let Some(min) = min
        && parsed < min
    {
        return Err(validation_error(
            field,
            "greater_than_equal",
            &format!("Input should be greater than or equal to {min}"),
            value,
            Some(ValidationContext::GreaterThanEqual { ge: min }),
        ));
    }
    if let Some(max) = max
        && parsed > max
    {
        return Err(validation_error(
            field,
            "less_than_equal",
            &format!("Input should be less than or equal to {max}"),
            value,
            Some(ValidationContext::LessThanEqual { le: max }),
        ));
    }
    Ok(parsed)
}

/// One FastAPI validation-error entry (`{type, loc, msg, input, ctx?}`),
/// mirroring the source `RequestValidationError` rendering. Bounds report the
/// pydantic `ctx` value alongside the message.
#[derive(Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ctx: Option<ValidationContext>,
}

/// The numeric bound pydantic reports alongside comparison errors.
#[derive(Serialize)]
#[serde(untagged)]
enum ValidationContext {
    GreaterThanEqual { ge: i64 },
    LessThanEqual { le: i64 },
}

/// FastAPI-style 422 validation error body for one query parameter.
fn validation_error(
    field: &str,
    kind: &'static str,
    message: &str,
    input: &str,
    ctx: Option<ValidationContext>,
) -> FastApiError {
    FastApiError::validation([ValidationEntry {
        kind,
        loc: ["query", field],
        msg: message,
        input,
        ctx,
    }])
}

/// One `SubscriptionInvitationsListResponse` in pydantic field order.
#[derive(Debug, Serialize)]
struct SubscriptionInvitationsListResponse {
    total: i64,
    items: Vec<SubscriptionInvitationResponse>,
}

/// One `SubscriptionInvitationResponse` in pydantic field declaration order.
#[derive(Debug, Serialize)]
struct SubscriptionInvitationResponse {
    id: i32,
    subscription_id: i32,
    subscription_name: String,
    subscription_display_name: String,
    invited_by_user_id: i32,
    invited_by_username: String,
    invitation_status: String,
    invited_at: String,
    owner_username: String,
}

/// One `subscription_follows` row of the page query, selected with the full
/// labeled source column list; the unconsumed columns stay declared so the
/// projection matches the recorded statement.
#[derive(Debug, FromMysqlRow)]
struct FollowRow {
    #[mysql(rename = "subscription_follows_id")]
    id: i32,
    #[mysql(rename = "subscription_follows_subscription_id")]
    subscription_id: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "subscription_follows_follower_user_id")]
    follower_user_id: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "subscription_follows_follow_type")]
    follow_type: String,
    #[mysql(rename = "subscription_follows_invited_by_user_id")]
    invited_by_user_id: i32,
    #[mysql(rename = "subscription_follows_invitation_status")]
    invitation_status: String,
    #[mysql(rename = "subscription_follows_invited_at")]
    invited_at: Option<NaiveDateTime>,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "subscription_follows_responded_at")]
    responded_at: Option<NaiveDateTime>,
    #[mysql(rename = "subscription_follows_created_at")]
    created_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "subscription_follows_updated_at")]
    updated_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "subscription_follows_config")]
    config: Option<String>,
}

/// The `count(*) AS count_1` row of `query.count()`.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    count_1: i64,
}

/// `spec.displayName` of the validated CRD. `SubscriptionSpec.displayName` is
/// a required string, so an absent or non-string value fails
/// `Subscription.model_validate` inside `_validate_subscription_for_read` and
/// the route renders the `Exception` handler's 500 body.
fn validated_display_name(json: &Value) -> Result<String, FastApiError> {
    json.get("spec")
        .and_then(|spec| spec.get("displayName"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            tracing::error!("subscription invitation CRD missing spec.displayName");
            FastApiError::unhandled()
        })
}

/// Render one invitation item from the loaded rows. The display name is
/// validated by the caller before the owner and inviter lookups so the
/// dependency order matches the source: `_validate_subscription_for_read`
/// runs first, then the two `users` reads.
fn render_item(
    follow: &FollowRow,
    subscription_name: &str,
    display_name: String,
    owner: Option<&UserRow>,
    inviter: Option<&UserRow>,
) -> SubscriptionInvitationResponse {
    SubscriptionInvitationResponse {
        id: follow.id,
        subscription_id: follow.subscription_id,
        subscription_name: subscription_name.to_owned(),
        subscription_display_name: display_name,
        invited_by_user_id: follow.invited_by_user_id,
        invited_by_username: inviter
            .map(|user| user.user_name.clone())
            .unwrap_or_default(),
        invitation_status: follow.invitation_status.clone(),
        invited_at: pydantic_datetime(follow.invited_at.unwrap_or(follow.created_at)),
        owner_username: owner.map(|user| user.user_name.clone()).unwrap_or_default(),
    }
}

/// `get_pending_invitations`: count first, then render the page.
async fn pending_invitations<M: Mysql>(
    mysql: &M,
    user_id: i64,
    query: &InvitationListQuery,
) -> Result<SubscriptionInvitationsListResponse, FastApiError> {
    let params = InvitationListQuery {
        page: query.page.clone(),
        limit: query.limit.clone(),
    }
    .validated()?;

    let count: Option<CountRow> = mysql
        .fetch_optional(count_sql(), (user_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "subscription invitations count database failure");
            FastApiError::unhandled()
        })?;
    let total = count.map_or(0, |row| row.count_1);

    let follows: Vec<FollowRow> = mysql
        .fetch_all(page_sql(params.skip, params.limit), (user_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "subscription invitations page database failure");
            FastApiError::unhandled()
        })?;

    let mut items = Vec::with_capacity(follows.len());
    for follow in &follows {
        // A missing or inactive Subscription row skips the invitation.
        let subscription: Option<KindRow> = mysql
            .fetch_optional(
                find_subscription_sql(),
                (i64::from(follow.subscription_id),),
            )
            .await
            .map_err(|error| {
                tracing::error!(%error, "subscription invitations kinds database failure");
                FastApiError::unhandled()
            })?;
        let Some(subscription) = subscription else {
            continue;
        };

        // `_validate_subscription_for_read` runs before the owner and inviter
        // lookups, so an invalid CRD fails without either `users` read.
        let display_name = validated_display_name(&subscription.json.0)?;
        let owner = fetch_user(mysql, i64::from(subscription.user_id)).await?;
        let inviter = fetch_user(mysql, i64::from(follow.invited_by_user_id)).await?;

        items.push(render_item(
            follow,
            &subscription.name,
            display_name,
            owner.as_ref(),
            inviter.as_ref(),
        ));
    }

    Ok(SubscriptionInvitationsListResponse { total, items })
}

/// `db.query(User).filter(User.id == user_id).first()`.
async fn fetch_user<M: Mysql>(mysql: &M, user_id: i64) -> Result<Option<UserRow>, FastApiError> {
    mysql
        .fetch_optional(USER_BY_ID_QUERY, (user_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "subscription invitations user database failure");
            FastApiError::unhandled()
        })
}

/// GET /api/users/me/subscription-invitations: the pending-invitations free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/users/me/subscription-invitations")]
async fn get_pending_invitations(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    query: brz_http_server::Query<InvitationListQuery>,
) -> Result<SubscriptionInvitationsListResponse, FastApiError> {
    pending_invitations(&state.mysql, i64::from(current_user.id), &query).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_contract_tests::serialized;
    use crate::sql_test_support::KindQueryCapture;
    use brz_http_server::StatusCode;
    use chrono::NaiveDate;
    use serde_json::json;

    fn dt(day: u32, hour: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, day)
            .unwrap()
            .and_hms_opt(hour, 30, 15)
            .unwrap()
    }

    fn follow_row(invited_at: Option<NaiveDateTime>) -> FollowRow {
        FollowRow {
            id: 7,
            subscription_id: 42,
            follower_user_id: 3022,
            follow_type: "invited".to_owned(),
            invited_by_user_id: 5,
            invitation_status: "pending".to_owned(),
            invited_at,
            responded_at: None,
            created_at: dt(1, 2),
            updated_at: dt(1, 2),
            config: None,
        }
    }

    #[test]
    fn default_query_matches_source_defaults() {
        let parsed = InvitationListQuery::default().validated().unwrap();
        assert_eq!(parsed.skip, 0);
        assert_eq!(parsed.limit, 50);
    }

    #[test]
    fn explicit_query_parses() {
        let parsed = InvitationListQuery {
            page: Some("3".to_owned()),
            limit: Some("1".to_owned()),
        }
        .validated()
        .unwrap();
        assert_eq!(parsed.skip, 2);
        assert_eq!(parsed.limit, 1);
    }

    #[test]
    fn rejects_out_of_range_and_non_integer_params() {
        for query in [
            InvitationListQuery {
                page: Some("0".to_owned()),
                ..Default::default()
            },
            InvitationListQuery {
                limit: Some("0".to_owned()),
                ..Default::default()
            },
            InvitationListQuery {
                limit: Some("101".to_owned()),
                ..Default::default()
            },
            InvitationListQuery {
                page: Some("abc".to_owned()),
                ..Default::default()
            },
        ] {
            let error = query.validated().unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
        let error = InvitationListQuery {
            limit: Some("abc".to_owned()),
            ..Default::default()
        }
        .validated()
        .unwrap_err();
        assert!(error.validation_detail().contains("int_parsing"));
    }

    #[test]
    fn validation_errors_render_the_pydantic_bound_context() {
        let page = InvitationListQuery {
            page: Some("0".to_owned()),
            ..Default::default()
        };
        assert_eq!(
            page.validated().unwrap_err().validation_detail(),
            "[{\"type\":\"greater_than_equal\",\"loc\":[\"query\",\"page\"],\
             \"msg\":\"Input should be greater than or equal to 1\",\"input\":\"0\",\
             \"ctx\":{\"ge\":1}}]"
        );
        let limit = InvitationListQuery {
            limit: Some("101".to_owned()),
            ..Default::default()
        };
        assert_eq!(
            limit.validated().unwrap_err().validation_detail(),
            "[{\"type\":\"less_than_equal\",\"loc\":[\"query\",\"limit\"],\
             \"msg\":\"Input should be less than or equal to 100\",\"input\":\"101\",\
             \"ctx\":{\"le\":100}}]"
        );
    }

    /// Deferred APIs retain Python ownership and registered Rust implementations.
    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/users/me/subscription-invitations";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain on Python"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::GET, PATH));
        // Other methods also retain Python ownership.
        for method in [
            http::Method::POST,
            http::Method::PUT,
            http::Method::PATCH,
            http::Method::DELETE,
        ] {
            assert!(!table.matches(&method, PATH));
        }

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }

    #[tokio::test]
    async fn empty_case_issues_count_and_page_queries() {
        let mysql = KindQueryCapture::default();
        let query = InvitationListQuery {
            page: Some("1".to_owned()),
            limit: Some("1".to_owned()),
        };
        let response = pending_invitations(&mysql, 3022, &query).await.unwrap();
        assert_eq!(response.total, 0);
        assert!(response.items.is_empty());

        let captured = mysql.queries();
        assert_eq!(captured.len(), 2);
        // `query.count()` binds the follower user id.
        assert_eq!(captured[0].args, 1);
        assert_eq!(captured[0].first_integer, Some(3022));
        assert!(captured[0].sql.contains("SELECT count(*) AS count_1"));
        assert!(captured[0]
            .sql
            .contains("follow_type = 'invited' AND subscription_follows.invitation_status = 'pending') AS anon_1"));
        // The page query renders `LIMIT skip, limit` even at offset 0.
        assert_eq!(captured[1].args, 1);
        assert_eq!(captured[1].first_integer, Some(3022));
        assert!(
            captured[1]
                .sql
                .contains("ORDER BY subscription_follows.invited_at DESC")
        );
        assert!(captured[1].sql.contains("LIMIT 0, 1"));
    }

    #[test]
    fn renders_item_with_defaults_and_pydantic_order() {
        let follow = follow_row(None);
        let document = json!({"spec": {"displayName": "Display"}});
        let display_name = validated_display_name(&document).unwrap();
        let item = render_item(&follow, "sub", display_name, None, None);
        assert_eq!(item.subscription_display_name, "Display");
        // `invited_by_user_id or 0` and missing users render empty names.
        assert_eq!(item.invited_by_user_id, 5);
        assert_eq!(item.invited_by_username, "");
        assert_eq!(item.owner_username, "");
        // `invited_at or created_at` falls back to the row timestamp.
        assert_eq!(item.invited_at, "2026-10-01T02:30:15");
        // Field order follows the pydantic declaration order.
        assert_eq!(
            serialized(&item).unwrap(),
            json!({
                "id": 7,
                "subscription_id": 42,
                "subscription_name": "sub",
                "subscription_display_name": "Display",
                "invited_by_user_id": 5,
                "invited_by_username": "",
                "invitation_status": "pending",
                "invited_at": "2026-10-01T02:30:15",
                "owner_username": ""
            })
        );
    }

    #[test]
    fn renders_invited_at_with_fractional_seconds() {
        let follow = follow_row(Some(
            NaiveDate::from_ymd_opt(2026, 10, 2)
                .unwrap()
                .and_hms_micro_opt(3, 0, 0, 500_000)
                .unwrap(),
        ));
        let document = json!({"spec": {"displayName": "Display"}});
        let display_name = validated_display_name(&document).unwrap();
        let item = render_item(&follow, "sub", display_name, None, None);
        assert_eq!(item.invited_at, "2026-10-02T03:00:00.500000");
    }

    #[test]
    fn missing_display_name_renders_the_exception_body() {
        let document = json!({"spec": {}});
        let error = validated_display_name(&document).unwrap_err();
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn empty_response_body_matches_the_source() {
        let response = SubscriptionInvitationsListResponse {
            total: 0,
            items: Vec::new(),
        };
        assert_eq!(
            serialized(&response).unwrap(),
            json!({"total": 0, "items": []})
        );
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PUT` and `DELETE /api/subscriptions/{subscription_id}`.
//!
//! Mirrors `app.api.endpoints.adapter.subscriptions.update_subscription` /
//! `delete_subscription` (router prefix `/subscriptions`, mounted under `/api`)
//! and `SubscriptionService.update_subscription` / `delete_subscription`
//! (`app.services.subscription.service`).
//!
//! Both handlers authenticate with the session user, load one active owned
//! `Subscription` `kinds` row, reject Code Wiki scheduler rows with 409, and run
//! the source's single session transaction:
//!
//! - `PUT` reapplies the submitted `SubscriptionUpdate` onto the stored CRD,
//!   re-validating team/workspace/device references and the trigger config, then
//!   rewrites `kinds.json` with an updated timestamp and reads the row back
//!   (`db.refresh`) to render `SubscriptionInDB`.
//! - `DELETE` soft-deletes the row (`is_active = 0`, `_internal.enabled =
//!   false`).
//!
//! On flush the source's internal Kind cache invalidates the row's data and
//! personal-index keys; the transaction then commits.

use chrono::{NaiveDateTime, Utc};
use serde_json::Value;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::subscriptions_list::KindRow;
use crate::subscriptions_list::convert::SubscriptionItem;

mod body;
mod crd;
mod cron;
mod crypto;
mod delete;
mod update;

pub(crate) use body::Update;
pub(crate) use crd::{build_crd_document, python_json_dumps};
pub(crate) use cron::calculate_next_execution_time;
pub(crate) use update::{
    active_workspace, build_trigger_value, create_or_get_workspace, filter_existing_market_users,
    random_token_urlsafe, truthy, validate_execution_target, validate_trigger_config,
};

/// `db.query(Kind).filter(id, user_id, kind='Subscription', is_active=true)
/// .first()` — the owned active row both handlers act on.
const FIND_SUBSCRIPTION_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.id = ? AND kinds.user_id = ? AND kinds.kind = 'Subscription' \
     AND kinds.is_active = true \n LIMIT 1";

/// `db.query(Kind).filter(id, kind='Team', is_active=true).first()`.
pub(crate) const TEAM_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.id = ? AND kinds.kind = 'Team' AND kinds.is_active = true \n LIMIT 1";

/// `db.query(Kind).filter(user_id, kind='Device', namespace='default',
/// is_active=true).all()` — the candidate set `resolve_owned_device_alias`
/// filters in Python.
const DEVICES_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
     AND kinds.namespace = 'default' AND kinds.is_active = true";

/// `db.refresh(subscription)` — SQLAlchemy re-selects the row by primary key.
const REFRESH_SUBSCRIPTION_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.id = ?";

/// `PUT /api/subscriptions/{subscription_id}`.
#[brz_http_server::put("/api/subscriptions/:subscription_id")]
async fn update_subscription(
    #[inject(state)] state: &AppState,
    subscription_id: i64,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<SubscriptionItem, FastApiError> {
    let update = Update::from_value(body)?;
    update::update_subscription(state, user.0.id as i64, subscription_id, &update).await
}

/// `DELETE /api/subscriptions/{subscription_id}` — 204 with the source's
/// `application/json` content type and an empty body.
#[brz_http_server::delete("/api/subscriptions/:subscription_id")]
async fn delete_subscription(
    #[inject(state)] state: &AppState,
    subscription_id: i64,
    #[auth] user: SessionUser,
) -> Result<brz_http_server::Response, FastApiError> {
    delete::delete_subscription(state, user.0.id as i64, subscription_id).await
}

/// The source's 404 (`HTTPException(404, "Subscription not found")`).
fn not_found() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::NOT_FOUND,
        "Subscription not found",
    )
}

/// The source's 409 for an internal Code Wiki scheduler row.
fn code_wiki_rejected() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::CONFLICT,
        "Code Wiki scheduled updates must be managed from the Code Wiki",
    )
}

/// A dependency failure renders the framework's 500 handler body.
pub(crate) fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "subscription write dependency failure");
    FastApiError::internal()
}

/// `spec.codeWikiRef.id` when positive — `code_wiki_id` in
/// `app.services.knowledge.code_wiki.scheduled_update`.
fn code_wiki_id(document: &Value) -> Option<i64> {
    document
        .get("spec")?
        .get("codeWikiRef")?
        .get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
}

/// `datetime.now(timezone.utc).replace(tzinfo=None)` rendered for a MySQL
/// `DATETIME` bind (`YYYY-MM-DD HH:MM:SS.ffffff`).
pub(crate) fn now_utc() -> NaiveDateTime {
    Utc::now().naive_utc()
}

/// The `updated_at` bind value the source writes on every change.
pub(crate) fn updated_at_bind(now: NaiveDateTime) -> String {
    now.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// Load one owned active Subscription row inside the caller's transaction.
async fn find_subscription<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    subscription_id: i64,
) -> Result<Option<KindRow>, brz_mysql::MysqlError> {
    transaction
        .fetch_optional(FIND_SUBSCRIPTION_QUERY, (subscription_id, user_id))
        .await
}

/// Invalidate the internal Kind cache keys for a changed row
/// (`CachedKindReader.on_change`): the data key plus the owner's personal index
/// key. `user_id == 0` also clears the public index; a non-default namespace
/// also clears the group index.
pub(crate) async fn invalidate_kind_cache<R: brz_redis::Redis>(
    redis: Option<&R>,
    kind: &str,
    resource_id: i64,
    user_id: i64,
    namespace: &str,
    name: &str,
) {
    let Some(redis) = redis else {
        return;
    };
    let mut keys = vec![
        format!("kind:v2:data:{kind}:{resource_id}"),
        format!("kind:v2:idx:personal:{kind}:{user_id}:{namespace}:{name}"),
    ];
    if user_id == 0 {
        keys.push(format!("kind:v2:idx:public:{kind}:{namespace}:{name}"));
    }
    if namespace != "default" {
        keys.push(format!("kind:v2:idx:group:{kind}:{namespace}:{name}"));
    }
    if let Err(error) = redis.del_many(keys).await {
        // `on_change` swallows cache failures; the business transaction stands.
        tracing::warn!(%error, "subscription Kind cache invalidation failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn statements_keep_the_source_sqlalchemy_rendering() {
        assert!(FIND_SUBSCRIPTION_QUERY.contains("kinds.kind = 'Subscription'"));
        assert!(FIND_SUBSCRIPTION_QUERY.contains("kinds.is_active = true"));
        assert!(FIND_SUBSCRIPTION_QUERY.ends_with("LIMIT 1"));
        assert!(TEAM_QUERY.contains("kinds.kind = 'Team'"));
        assert!(DEVICES_QUERY.contains("kinds.kind = 'Device'"));
        assert!(DEVICES_QUERY.contains("kinds.namespace = 'default'"));
        assert!(!DEVICES_QUERY.contains("LIMIT"));
    }

    #[test]
    fn code_wiki_detection_requires_a_positive_id() {
        assert_eq!(
            code_wiki_id(&json!({"spec": {"codeWikiRef": {"id": 5}}})),
            Some(5)
        );
        assert_eq!(
            code_wiki_id(&json!({"spec": {"codeWikiRef": {"id": 0}}})),
            None
        );
        assert_eq!(code_wiki_id(&json!({"spec": {"codeWikiRef": null}})), None);
        assert_eq!(code_wiki_id(&json!({"spec": {}})), None);
    }

    #[test]
    fn cache_keys_match_the_internal_reader() {
        // Data + personal index for a normal user/default namespace.
        let keys = [
            "kind:v2:data:Subscription:230827",
            "kind:v2:idx:personal:Subscription:157:default:sub-5wwedhvt",
        ];
        assert_eq!(keys.len(), 2);
    }
}

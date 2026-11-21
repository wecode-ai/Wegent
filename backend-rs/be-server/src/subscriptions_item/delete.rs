// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `DELETE /api/subscriptions/{subscription_id}`
//! (`SubscriptionService.delete_subscription`).

use brz_http_server::{Response, StatusCode};
use brz_mysql::MysqlTransaction;
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::{
    code_wiki_id, code_wiki_rejected, find_subscription, internal_error, invalidate_kind_cache,
    not_found, now_utc, updated_at_bind,
};

/// `db.commit()`'s flush of the soft delete: the rewritten JSON, the
/// `is_active` flag, and the `updated_at` `onupdate`.
const DELETE_SUBSCRIPTION_QUERY: &str =
    "UPDATE kinds SET json=?, is_active=0, updated_at=? WHERE kinds.id = ?";

/// The observable outcomes of the delete transaction.
enum DeleteOutcome {
    /// `is_active = False; _internal.enabled = False; db.commit()`.
    Deleted,
    /// `db.query(Kind)...first()` found no owned active row.
    NotFound,
    /// A Code Wiki scheduler row cannot be managed here (409).
    Rejected,
}

/// `delete_subscription`: soft-delete one owned active Subscription.
pub(super) async fn delete_subscription(
    state: &AppState,
    user_id: i64,
    subscription_id: i64,
) -> Result<Response, FastApiError> {
    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            let Some(row) = find_subscription(transaction, user_id, subscription_id).await? else {
                return Ok(DeleteOutcome::NotFound);
            };
            if code_wiki_id(&row.json.0).is_some() {
                return Ok(DeleteOutcome::Rejected);
            }

            let mut document = row.json.0.clone();
            set_internal_bool(&mut document, "enabled", false);
            let json = super::crd::python_json_dumps(&document);
            let updated_at = updated_at_bind(now_utc());
            transaction
                .execute(
                    DELETE_SUBSCRIPTION_QUERY,
                    (json, updated_at, subscription_id),
                )
                .await?;

            // The Kind `after_update` cache event fires during flush.
            invalidate_kind_cache(
                state.redis.as_ref(),
                "Subscription",
                i64::from(row.id),
                user_id,
                &row.namespace,
                &row.name,
            )
            .await;
            Ok(DeleteOutcome::Deleted)
        })
        .await
        .map_err(internal_error)?;

    match outcome {
        DeleteOutcome::Deleted => Ok(no_content()),
        DeleteOutcome::NotFound => Err(not_found()),
        DeleteOutcome::Rejected => Err(code_wiki_rejected()),
    }
}

/// The source's 204: no body, but the FastAPI default `application/json`
/// media type.
fn no_content() -> Response {
    Response::empty(StatusCode::NO_CONTENT).content_type("application/json")
}

/// `internal = subscription.json.get("_internal", {}); internal[key] = false;
/// subscription.json["_internal"] = internal` — creating `_internal` when it is
/// absent, unlike a plain in-place edit.
fn set_internal_bool(document: &mut Value, key: &str, value: bool) {
    let internal = document.as_object_mut().map(|object| {
        object
            .entry("_internal")
            .or_insert_with(|| Value::Object(Default::default()))
    });
    if let Some(internal) = internal
        && let Some(object) = internal.as_object_mut()
    {
        object.insert(key.to_string(), Value::Bool(value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn soft_delete_sets_internal_enabled_and_preserves_order() {
        let mut document = json!({
            "kind": "Subscription",
            "spec": {"enabled": false},
            "_internal": {"enabled": true, "team_id": 7},
            "apiVersion": "agent.wecode.io/v1"
        });
        set_internal_bool(&mut document, "enabled", false);
        let keys: Vec<&str> = document
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["kind", "spec", "_internal", "apiVersion"]);
        assert_eq!(document["_internal"]["enabled"], json!(false));
        assert_eq!(document["_internal"]["team_id"], json!(7));
        // `spec.enabled` is untouched: the source only flips the internal flag.
        assert_eq!(document["spec"]["enabled"], json!(false));
    }

    #[test]
    fn internal_object_is_created_when_absent() {
        let mut document = json!({"kind": "Subscription"});
        set_internal_bool(&mut document, "enabled", false);
        assert_eq!(document["_internal"]["enabled"], json!(false));
    }

    #[test]
    fn delete_statement_matches_the_recorded_rendering() {
        assert_eq!(
            DELETE_SUBSCRIPTION_QUERY,
            "UPDATE kinds SET json=?, is_active=0, updated_at=? WHERE kinds.id = ?"
        );
    }
}

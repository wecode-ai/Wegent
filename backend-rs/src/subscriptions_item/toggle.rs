// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/subscriptions/{subscription_id}/toggle`
//! (`SubscriptionService.toggle_subscription`).
//!
//! Mirrors `app.api.endpoints.adapter.subscriptions.toggle_subscription` (router
//! prefix `/subscriptions`, mounted under `/api`) and
//! `SubscriptionService.toggle_subscription` (`app.services.subscription.service`).
//!
//! The handler authenticates with the session user, loads one active owned
//! `Subscription` `kinds` row, rejects Code Wiki scheduler rows with 409, flips
//! the `enabled` flag on both the CRD `spec` and `_internal`, and recomputes the
//! internal `next_execution_time` when enabling. It then rewrites `kinds.json`
//! with an updated timestamp, reads the row back (`db.refresh`), and renders
//! `SubscriptionInDB`.
//!
//! Both the written `updated_at` and the recomputed `_internal.next_execution_time`
//! are request-time naive-UTC values (`datetime.now(timezone.utc).replace(
//! tzinfo=None)` and `calculate_next_execution_time` in the source), so Replay
//! must normalize them through the matching mysql time rule rather than pin them
//! to the recorded request.

use brz_mysql::MysqlTransaction;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::subscriptions_list::convert::{SubscriptionItem, pydantic_datetime};

use super::{
    calculate_next_execution_time, code_wiki_id, code_wiki_rejected, crd, find_subscription,
    internal_error, invalidate_kind_cache, not_found, now_utc, updated_at_bind,
};

/// `db.commit()`'s flush of the rewritten `enabled` flag.
const TOGGLE_SUBSCRIPTION_QUERY: &str = "UPDATE kinds SET json=?, updated_at=? WHERE kinds.id = ?";

/// Query parameters of `POST /api/subscriptions/{subscription_id}/toggle`.
///
/// The source declares `enabled: bool = Query(...)` (a required query
/// parameter), so a missing value renders a FastAPI 422 before any dependency
/// traffic, and a non-boolean value renders the `bool_parsing` error.
#[derive(Debug, Default, Deserialize)]
pub(super) struct ToggleQuery {
    #[serde(default)]
    pub(super) enabled: Option<String>,
}

impl ToggleQuery {
    /// Validate the FastAPI query contract and return the coerced flag.
    pub(super) fn enabled(&self) -> Result<bool, FastApiError> {
        match self.enabled.as_deref() {
            None => Err(FastApiError::validation(json!([
                {
                    "type": "missing",
                    "loc": ["query", "enabled"],
                    "msg": "Field required",
                    "input": Value::Null,
                }
            ]))),
            Some(raw) => parse_bool(raw),
        }
    }
}

/// Parse a boolean query parameter, matching FastAPI's `bool` query parsing.
fn parse_bool(raw: &str) -> Result<bool, FastApiError> {
    match raw.to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => Ok(true),
        "false" | "0" | "off" | "no" | "" => Ok(false),
        _ => Err(FastApiError::validation(json!([
            {
                "type": "bool_parsing",
                "loc": ["query", "enabled"],
                "msg": "Input should be a valid boolean, unable to interpret input as boolean",
                "input": raw,
            }
        ]))),
    }
}

/// The observable outcomes of the toggle transaction.
enum ToggleOutcome {
    /// `db.commit()` succeeded.
    Saved,
    /// No owned active Subscription row.
    NotFound,
    /// A Code Wiki scheduler row cannot be updated here (409).
    Rejected,
}

/// `toggle_subscription`: enable or disable one owned active Subscription.
pub(super) async fn toggle_subscription(
    state: &AppState,
    user_id: i64,
    subscription_id: i64,
    enabled: bool,
) -> Result<SubscriptionItem, FastApiError> {
    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            apply_toggle(transaction, state, user_id, subscription_id, enabled).await
        })
        .await
        .map_err(internal_error)?;

    match outcome {
        ToggleOutcome::Saved => super::update::refresh(state, subscription_id).await,
        ToggleOutcome::NotFound => Err(not_found()),
        ToggleOutcome::Rejected => Err(code_wiki_rejected()),
    }
}

/// The transaction body of `toggle_subscription`.
async fn apply_toggle<T: MysqlTransaction>(
    transaction: &mut T,
    state: &AppState,
    user_id: i64,
    subscription_id: i64,
    enabled: bool,
) -> Result<ToggleOutcome, brz_mysql::MysqlError> {
    let Some(row) = find_subscription(transaction, user_id, subscription_id).await? else {
        return Ok(ToggleOutcome::NotFound);
    };
    let stored = row.json.0.clone();
    if code_wiki_id(&stored).is_some() {
        return Ok(ToggleOutcome::Rejected);
    }

    // `validate_subscription_for_read(subscription.json)` re-dumps the CRD in
    // model declaration order, then the flag is applied to `spec.enabled`.
    let mut document = crd::build_crd_document(&stored);
    let mut spec = crd::build_spec(stored.get("spec").unwrap_or(&Value::Null));
    let mut internal = stored
        .get("_internal")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    set(&mut spec, "enabled", json!(enabled));
    set(&mut internal, "enabled", json!(enabled));

    // Recalculate the next execution time when enabling; clearing it when
    // disabling.
    if enabled {
        let trigger_type = internal
            .get("trigger_type")
            .and_then(Value::as_str)
            .unwrap_or("cron")
            .to_string();
        let config = super::update::extract_trigger_config(spec.get("trigger"));
        let next_value = calculate_next_execution_time(&trigger_type, &config, now_utc())
            .map(pydantic_datetime)
            .map(|value| json!(value))
            .unwrap_or(Value::Null);
        set(&mut internal, "next_execution_time", next_value);
    } else {
        set(&mut internal, "next_execution_time", Value::Null);
    }

    document.insert("spec".to_string(), spec);
    document.insert("_internal".to_string(), internal);

    let json = crd::python_json_dumps(&Value::Object(document));
    let updated_at = updated_at_bind(now_utc());
    transaction
        .execute(
            TOGGLE_SUBSCRIPTION_QUERY,
            (json, updated_at, subscription_id),
        )
        .await?;

    invalidate_kind_cache(
        state.redis.as_ref(),
        "Subscription",
        i64::from(row.id),
        user_id,
        &row.namespace,
        &row.name,
    )
    .await;
    Ok(ToggleOutcome::Saved)
}

/// Set a key on a JSON object.
fn set(object: &mut Value, key: &str, value: Value) {
    if let Some(object) = object.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_flag_is_required_and_coerced() {
        assert!(ToggleQuery::default().enabled().is_err());
        assert!(
            ToggleQuery {
                enabled: Some("true".to_string())
            }
            .enabled()
            .unwrap()
        );
        assert!(
            !ToggleQuery {
                enabled: Some("FALSE".to_string())
            }
            .enabled()
            .unwrap()
        );
        assert!(
            ToggleQuery {
                enabled: Some("maybe".to_string())
            }
            .enabled()
            .is_err()
        );
    }

    #[test]
    fn toggle_statement_matches_the_source_render() {
        assert_eq!(
            TOGGLE_SUBSCRIPTION_QUERY,
            "UPDATE kinds SET json=?, updated_at=? WHERE kinds.id = ?"
        );
    }
}

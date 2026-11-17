//! Corrupt durable state is rejected before a cursor, lease or receipt can change.
use serde_json::Value;
use wegent_protocol::connection_events::validate_filter;

fn string(value: &Value) -> bool {
    value.as_str().is_some_and(|value| !value.is_empty())
}
fn counter(value: &Value) -> bool {
    value.as_u64().is_some_and(|value| value < i64::MAX as u64)
}
fn lease(value: &Value) -> bool {
    value.is_null()
        || (value.is_object()
            && string(&value["id"])
            && value["expiresAt"].as_i64().is_some_and(|expiry| expiry > 0))
}

pub(super) fn validate(state: &Value) -> Result<(), &'static str> {
    let valid = matches!(state["version"].as_u64(), Some(1 | 2))
        && ["observations", "subscriptions", "deliveries"]
            .iter()
            .all(|key| state[key].is_object());
    if !valid {
        return Err("observation_storage_conflict");
    }
    super::observers::validate(state)?;
    for (id, row) in state["observations"].as_object().unwrap() {
        let collector =
            super::collector::stored(state, row).map_err(|_| "observation_storage_conflict")?;
        let events = row["events"]
            .as_array()
            .ok_or("observation_storage_conflict")?;
        if row["id"] != id.as_str()
            || collector.observation_id(&row["source"]) != *id
            || !row["source"].is_object()
            || !row["checkpoint"].is_object()
            || !counter(&row["sequence"])
            || !counter(&row["forceVersion"])
            || !counter(&row["nextPollAt"])
            || !lease(&row["lease"])
            || !row["idle"].is_boolean()
            || !row["suspended"].is_boolean()
            || !counter(&row["failureCount"])
            || !counter(&row["collectedForceVersion"])
            || (!row["lease"].is_null() && !counter(&row["lease"]["forceVersion"]))
            || events.len() > 1000
        {
            return Err("observation_storage_conflict");
        }
        let mut previous = 0;
        for entry in events {
            let sequence = entry["sequence"]
                .as_u64()
                .ok_or("observation_storage_conflict")?;
            if !string(&entry["key"])
                || !entry["event"].is_object()
                || sequence <= previous
                || sequence > row["sequence"].as_u64().unwrap()
            {
                return Err("observation_storage_conflict");
            }
            previous = sequence;
        }
    }
    for (id, row) in state["subscriptions"].as_object().unwrap() {
        let target = super::target::Target::parse(&row["intent"]["target"])
            .map_err(|_| "observation_storage_conflict")?;
        let observation = row["observationId"]
            .as_str()
            .and_then(|id| state["observations"].get(id))
            .ok_or("observation_storage_conflict")?;
        if row["id"] != id.as_str()
            || !row["intent"].is_object()
            || !super::state::valid_activation(&row["activation"])
            || !counter(&row["afterSequence"])
            || row["afterSequence"].as_u64().unwrap() > observation["sequence"].as_u64().unwrap()
            || validate_filter(&row["intent"]["match"]).is_err()
            || row.get("subscriptionKey").is_some_and(|value| {
                !string(value)
                    || value.as_str().is_some_and(|key| key.len() > 16_384)
                    || target.subscription_id(value) != *id
            })
            || row
                .get("waitForEvent")
                .is_some_and(|value| !value.is_boolean())
            || row.get("requestIntent").is_some_and(|request| {
                !wegent_protocol::connection_events::matches_subscription_request(
                    request,
                    &row["intent"],
                    &row["waitForEvent"],
                )
            })
            || row
                .get("terminalSynced")
                .is_some_and(|value| !value.is_boolean())
            || !matches!(
                row["status"].as_str(),
                Some("armed" | "pending" | "delivered" | "cancelled")
            )
        {
            return Err("observation_storage_conflict");
        }
        if matches!(row["status"].as_str(), Some("pending" | "delivered")) {
            let delivery = row["deliveryId"]
                .as_str()
                .and_then(|key| state["deliveries"].get(key))
                .ok_or("observation_storage_conflict")?;
            if delivery["subscriptionId"] != id.as_str() {
                return Err("observation_storage_conflict");
            }
        }
    }
    for (id, row) in state["deliveries"].as_object().unwrap() {
        let events = row["events"]
            .as_array()
            .ok_or("observation_storage_conflict")?;
        let keys = row["eventKeys"]
            .as_array()
            .ok_or("observation_storage_conflict")?;
        if row["id"] != id.as_str()
            || !row["subscriptionId"]
                .as_str()
                .is_some_and(|id| state["subscriptions"][id].is_object())
            || row["intent"]
                != state["subscriptions"][row["subscriptionId"].as_str().unwrap()]["intent"]
            || events.len() != keys.len()
            || !keys.iter().all(string)
            || !lease(&row["lease"])
            || (!row["admission"].is_null()
                && (!row["admission"].is_object()
                    || !string(&row["admission"]["operationId"])
                    || row["admission"]["at"].as_i64().is_none()))
            || !matches!(
                row["status"].as_str(),
                Some("pending" | "accepted" | "cancelled")
            )
        {
            return Err("observation_storage_conflict");
        }
    }
    Ok(())
}

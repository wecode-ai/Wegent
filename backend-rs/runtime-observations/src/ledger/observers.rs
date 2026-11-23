//! Leased read-only consumers keep collection alive without creating model deliveries.
use super::state::{
    ensure_observation, hash, observation_projection, revoke_idle_leases, text, validate_source,
};
use serde_json::{Value, json};

const OBSERVER_TTL_MS: i64 = 90_000;
type Result<T> = std::result::Result<T, &'static str>;

fn projection(state: &Value, id: &str) -> Result<Value> {
    let row = state["observers"]
        .get(id)
        .ok_or("observation_observer_unavailable")?;
    let observation = &state["observations"][row["observationId"]
        .as_str()
        .ok_or("observation_storage_conflict")?];
    Ok(json!({"observer":row,"observation":observation_projection(observation)}))
}

pub(super) fn observe(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let observer = &input["observer"];
    let device = text(observer, "deviceId")?;
    let consumer = text(observer, "consumerKey")?;
    let generation = text(observer, "generation")?;
    validate_source(&observer["source"])?;
    // Each activation owns its row so all retired generations remain fenced.
    let id = hash(&json!(["observer", device, consumer, generation]));
    let source_id = hash(&wegent_protocol::connection_events::observation_identity(
        &observer["source"],
    ));
    if let Some(previous) = state["observers"].get(&id) {
        if previous["deviceId"] != device
            || previous["consumerKey"] != consumer
            || previous["observationId"] != source_id
        {
            return Err("observation_observer_conflict");
        }
        let active =
            previous["stopped"] != true && previous["expiresAt"].as_i64().unwrap_or_default() > now;
        if previous["generation"] == generation && !active {
            return Err("observation_observer_lease_lost");
        }
    }
    let expires_at = now
        .checked_add(OBSERVER_TTL_MS)
        .filter(|value| *value > 0)
        .ok_or("invalid_observation_input")?;
    let observation = ensure_observation(
        state,
        &observer["source"],
        &super::collector::Collector::Device {
            device_id: device.into(),
        },
        &input["initialCheckpoint"],
        now,
    )?;
    state["observers"][&id] = json!({"id":id,"deviceId":device,"consumerKey":consumer,"generation":generation,"stopped":false,"source":observer["source"],"observationId":observation,"expiresAt":expires_at});
    projection(state, &id)
}

pub(super) fn renew(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let id = text(input, "observerId")?;
    let device = text(input, "deviceId")?;
    let generation = text(input, "generation")?;
    let row = state
        .get_mut("observers")
        .and_then(|rows| rows.get_mut(id))
        .ok_or("observation_observer_unavailable")?;
    if row["deviceId"] != device
        || row["generation"] != generation
        || row["stopped"] == true
        || row["expiresAt"].as_i64().unwrap_or_default() <= now
    {
        return Err("observation_observer_lease_lost");
    }
    row["expiresAt"] = json!(
        now.checked_add(OBSERVER_TTL_MS)
            .ok_or("invalid_observation_input")?
    );
    projection(state, id)
}

pub(super) fn stop(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let id = text(input, "observerId")?;
    let generation = text(input, "generation")?;
    if state["observers"].get(id).is_none() && input["observer"].is_object() {
        let observer = &input["observer"];
        if observer["generation"] != generation
            || hash(&json!([
                "observer",
                observer["deviceId"],
                observer["consumerKey"],
                observer["generation"]
            ])) != id
        {
            return Err("observation_observer_conflict");
        }
        observe(state, input, now)?;
    }
    if let Some(row) = state.get_mut("observers").and_then(|rows| rows.get_mut(id)) {
        if row["generation"] != generation {
            return Err("observation_observer_lease_lost");
        }
        if row["stopped"] != true && row["expiresAt"].as_i64().unwrap_or_default() <= now {
            return Err("observation_observer_lease_lost");
        }
        row["stopped"] = json!(true);
    }
    revoke_idle_leases(state, now);
    Ok(json!({"stopped":true}))
}

pub(super) fn validate(state: &Value) -> Result<()> {
    let Some(rows) = state.get("observers") else {
        return Ok(());
    };
    let rows = rows.as_object().ok_or("observation_storage_conflict")?;
    for (id, row) in rows {
        let observation = row["observationId"]
            .as_str()
            .and_then(|id| state["observations"].get(id))
            .ok_or("observation_storage_conflict")?;
        if row["id"] != id.as_str()
            || text(row, "deviceId").is_err()
            || text(row, "consumerKey").is_err()
            || text(row, "generation").is_err()
            || !row["stopped"].is_boolean()
            || hash(&json!([
                "observer",
                row["deviceId"],
                row["consumerKey"],
                row["generation"]
            ])) != *id
            || row["expiresAt"].as_i64().is_none_or(|value| value <= 0)
            || validate_source(&row["source"]).is_err()
            || row["observationId"]
                != hash(&wegent_protocol::connection_events::observation_identity(
                    &row["source"],
                ))
            || wegent_protocol::connection_events::observation_identity(&row["source"])
                != wegent_protocol::connection_events::observation_identity(&observation["source"])
        {
            return Err("observation_storage_conflict");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

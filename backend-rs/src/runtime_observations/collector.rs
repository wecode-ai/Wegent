//! Collection location never doubles as a Task execution identity.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Collector {
    Device {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
}

impl Collector {
    pub(crate) fn parse(value: &Value) -> Result<Self, &'static str> {
        let route: Self =
            serde_json::from_value(value.clone()).map_err(|_| "invalid_observation_collector")?;
        if matches!(&route, Self::Device { device_id } if device_id.trim().is_empty() || device_id.len() > 16384)
        {
            return Err("invalid_observation_collector");
        }
        Ok(route)
    }

    pub(super) fn value(&self) -> Value {
        serde_json::to_value(self).expect("Typed collector routes serialize")
    }

    pub(super) fn observation_id(&self, source: &Value) -> String {
        let source = wegent_protocol::connection_events::observation_identity(source);
        // Tasks observing the same account source share its collection cursor.
        super::state::hash(&match self {
            Self::Device { .. } => source,
        })
    }
}

pub(super) fn stored(state: &Value, row: &Value) -> Result<Collector, &'static str> {
    match state["version"].as_u64() {
        Some(1) if row.get("collector").is_none() => {
            Collector::parse(&json!({"kind":"device","deviceId":row["collectorDeviceId"]}))
        }
        Some(2) if row.get("collectorDeviceId").is_none() => Collector::parse(&row["collector"]),
        _ => Err("invalid_observation_collector"),
    }
}

pub(super) fn upgrade_validated(state: &mut Value) {
    if state["version"] != 1 {
        return;
    }
    for row in state["observations"].as_object_mut().unwrap().values_mut() {
        let row = row.as_object_mut().unwrap();
        let device = row.remove("collectorDeviceId").unwrap();
        row.insert(
            "collector".into(),
            json!({"kind":"device","deviceId":device}),
        );
    }
    state["version"] = json!(2);
}

#[cfg(test)]
mod tests;

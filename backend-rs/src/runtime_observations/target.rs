//! Bind delivery to one device, Task and exact native conversation.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Target {
    device_id: String,
    task_id: String,
    session: NativeSession,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NativeSession {
    engine: Engine,
    id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
enum Engine {
    Codex,
    ClaudeCode,
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 16_384
}

impl Target {
    pub(super) fn parse(value: &Value) -> Result<Self> {
        let target: Self =
            serde_json::from_value(value.clone()).map_err(|_| "invalid_observation_target")?;
        if !valid_text(&target.device_id)
            || !valid_text(&target.task_id)
            || !valid_text(&target.session.id)
        {
            return Err("invalid_observation_target");
        }
        Ok(target)
    }

    pub(super) fn value(&self) -> Value {
        serde_json::to_value(self).expect("Typed observation targets serialize")
    }

    pub(super) fn subscription_id(&self, key: &Value) -> String {
        super::state::subscription_identity(&json!(self.device_id), &json!(self.task_id), key)
    }

    pub(super) fn registration(
        subscription: &Value,
    ) -> Result<(Self, super::collector::Collector)> {
        if subscription.get("collector_device_id").is_some()
            || subscription.get("collector").is_some()
            || subscription.get("target").is_some()
            || subscription.get("preparation").is_some()
        {
            return Err("invalid_observation_target");
        }
        let target = Self::parse(&json!({
            "deviceId":subscription["device_id"],
            "taskId":subscription["task_id"],
            "session":subscription["session"]
        }))?;
        let collector = super::collector::Collector::parse(
            &json!({"kind":"device","deviceId":subscription["device_id"]}),
        )?;
        Ok((target, collector))
    }
}

#[cfg(test)]
mod tests;

//! Durable publication markers stay separate from user-editable assistant profiles.
use super::*;

fn backend_key(backend: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(backend.trim_end_matches('/')))
}

fn sync_key(user: i64, backend: &str) -> String {
    format!("assistant-share-sync:{user}:{}", backend_key(backend))
}

pub(super) fn share_configuration_changed(previous: &Value, next: &Value) -> bool {
    use std::collections::BTreeMap;
    fn profiles(settings: &Value) -> BTreeMap<&str, (&Value, &Value)> {
        settings["roles"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|role| {
                (role["executionDeviceId"] == settings["executionDeviceId"]).then_some(())?;
                Some((role["id"].as_str()?, (&role["name"], &role["prompt"])))
            })
            .collect()
    }
    fn teams(settings: &Value) -> BTreeMap<&str, (&Value, &Value, &Value, &Value)> {
        settings["teams"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|team| {
                Some((
                    team["id"].as_str()?,
                    (
                        &team["name"],
                        &team["leadId"],
                        &team["members"],
                        &team["memberRoutes"],
                    ),
                ))
            })
            .collect()
    }
    previous["primary"]["prompt"] != next["primary"]["prompt"]
        || profiles(previous) != profiles(next)
        || teams(previous) != teams(next)
}

pub(super) fn queue_assistant_share_sync(
    connection: &Connection,
    user: i64,
    backend: &str,
    settings: &Value,
) -> Result<(), TaskRuntimeError> {
    let roles: Vec<_> = settings["roles"].as_array().into_iter().flatten().map(|role| json!({
        "id":role["id"], "executionDeviceId":role["executionDeviceId"], "name":role["name"], "prompt":role["prompt"]
    })).collect();
    let primary = settings["primary"].is_object().then(|| {
        json!({
            "name":settings["primary"]["name"], "prompt":settings["primary"]["prompt"]
        })
    });
    let snapshot = json!({
        "version":settings["version"], "executionDeviceId":settings["executionDeviceId"],
        "roles":roles, "primary":primary, "teams":settings["teams"]
    });
    connection.execute(
        "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at) VALUES (?1,'assistant_share_sync',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",
        params![sync_key(user, backend), snapshot.to_string(), now()],
    )?;
    Ok(())
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct AssistantShareCopyReceipt {
    pub owner: i32,
    pub kind: String,
    pub source: String,
    pub revision: u64,
}

impl AssistantShareCopyReceipt {
    fn key(&self, user: i64, backend: &str) -> String {
        format!(
            "assistant-share-receipt:{user}:{}:{}:{}:{}",
            backend_key(backend),
            self.kind,
            self.owner,
            self.source
        )
    }
}

pub(super) fn queue_assistant_share_copy_receipt(
    connection: &Connection,
    user: i64,
    backend: &str,
    owner: i32,
    kind: &str,
    source: &str,
    revision: u64,
) -> Result<(), TaskRuntimeError> {
    let receipt = AssistantShareCopyReceipt {
        owner,
        kind: kind.to_owned(),
        source: source.to_owned(),
        revision,
    };
    connection.execute(
        "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at) VALUES (?1,'assistant_share_copy_receipt',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at WHERE json_extract(metadata,'$.revision')<json_extract(excluded.metadata,'$.revision')",
        params![receipt.key(user, backend), json!(receipt).to_string(), now()],
    )?;
    Ok(())
}

impl LocalTaskStore {
    pub fn pending_assistant_share_sync(
        &self,
        user: i64,
        backend: &str,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        let raw: Option<String> = self.connection()?.query_row(
            "SELECT metadata FROM loop_items WHERE id=?1 AND resource_type='assistant_share_sync'",
            [sync_key(user, backend)],
            |row| row.get(0),
        ).optional()?;
        raw.map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .transpose()
    }

    pub fn acknowledge_assistant_share_sync(
        &self,
        user: i64,
        backend: &str,
        version: u64,
    ) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "DELETE FROM loop_items WHERE id=?1 AND resource_type='assistant_share_sync' AND json_extract(metadata,'$.version')=?2",
            params![sync_key(user, backend),version],
        )?;
        Ok(())
    }

    pub fn pending_assistant_share_copy_receipts(
        &self,
        user: i64,
        backend: &str,
    ) -> Result<Vec<AssistantShareCopyReceipt>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT metadata FROM loop_items WHERE id>=?1 AND id<?2 AND resource_type='assistant_share_copy_receipt' ORDER BY id LIMIT 100",
        )?;
        let rows = statement.query_map(
            [
                format!("assistant-share-receipt:{user}:{}:", backend_key(backend)),
                format!("assistant-share-receipt:{user}:{};", backend_key(backend)),
            ],
            |row| row.get::<_, String>(0),
        )?;
        rows.map(|row| {
            serde_json::from_str(&row?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect()
    }

    pub fn acknowledge_assistant_share_copy_receipt(
        &self,
        user: i64,
        backend: &str,
        receipt: &AssistantShareCopyReceipt,
    ) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "DELETE FROM loop_items WHERE id=?1 AND resource_type='assistant_share_copy_receipt' AND json_extract(metadata,'$.revision')=?2",
            params![receipt.key(user, backend),receipt.revision],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_completed_sync_cannot_acknowledge_a_newer_settings_save() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut initial = store.read_personal_stand_in(7, "device").unwrap();
        initial["primary"] = json!({"enabled":true,"prompt":"First","preferences":""});
        let saved = store
            .save_personal_stand_in_for_backend(7, "device", Some("https://one.example"), initial)
            .unwrap();
        let first = saved["version"].as_u64().unwrap();
        assert_eq!(
            store
                .pending_assistant_share_sync(7, "https://one.example")
                .unwrap()
                .and_then(|row| row["version"].as_u64()),
            Some(first)
        );

        let mut draft = saved;
        draft["primary"]["prompt"] = json!("Second");
        let newer = store
            .save_personal_stand_in_for_backend(7, "device", Some("https://one.example"), draft)
            .unwrap();
        let second = newer["version"].as_u64().unwrap();
        store
            .acknowledge_assistant_share_sync(7, "https://one.example", first)
            .unwrap();
        assert_eq!(
            store
                .pending_assistant_share_sync(7, "https://one.example")
                .unwrap()
                .and_then(|row| row["version"].as_u64()),
            Some(second)
        );
        assert_eq!(
            store
                .pending_assistant_share_sync(7, "https://other.example")
                .unwrap(),
            None
        );

        store
            .acknowledge_assistant_share_sync(7, "https://one.example", second)
            .unwrap();
        assert_eq!(
            store
                .pending_assistant_share_sync(7, "https://one.example")
                .unwrap(),
            None
        );
    }
}

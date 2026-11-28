//! Import shared definitions into the recipient's existing account document.
use super::*;
use crate::protocol::assistant_share::{
    AssistantDefinition, AssistantShareDefinition, AssistantShareSnapshot,
};
use std::collections::BTreeMap;

impl LocalTaskStore {
    pub fn copy_assistant_share(
        &self,
        user: i64,
        device: &str,
        backend: &str,
        snapshot: &AssistantShareSnapshot,
        update: bool,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let transaction = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (mut settings, _) = personal_snapshot(&transaction, user, device)?;
        if apply_share_copy(&mut settings, backend, snapshot, update)? {
            settings = self.save_personal_stand_in_on(
                &transaction,
                user,
                device,
                settings,
                super::personal_stand_in::StandInSaveOptions {
                    workspace_owner: false,
                    backend: Some(backend),
                },
            )?;
        }
        for entry in std::iter::once(&snapshot.root).chain(&snapshot.assistants) {
            let (kind, source) = entry.definition.key();
            if let Some(revision) = assistant_share_copy_revision(
                &settings,
                backend,
                snapshot.owner_user_id,
                kind,
                source,
            ) {
                super::share_sync::queue_assistant_share_copy_receipt(
                    &transaction,
                    user,
                    backend,
                    snapshot.owner_user_id,
                    kind,
                    source,
                    revision,
                )?;
            }
        }
        transaction.commit()?;
        Ok(settings)
    }
}

pub fn assistant_share_copy_revision(
    settings: &Value,
    backend: &str,
    owner: i32,
    kind: &str,
    source: &str,
) -> Option<u64> {
    let id = copy_id(backend, owner, kind, source);
    let rows = match kind {
        "assistant" => &settings["roles"],
        "team" => &settings["teams"],
        _ => return None,
    };
    rows.as_array()?
        .iter()
        .find(|row| row["id"] == id)
        .and_then(|row| row["shareCopyRevision"].as_u64())
}

/// A copy kept on the same device is reused even after the recipient renames it.
fn copy_id(backend: &str, owner: i32, kind: &str, source: &str) -> String {
    let digest =
        Sha256::digest(json!([backend.trim_end_matches('/'), owner, kind, source]).to_string());
    let mut id = [0_u8; 16];
    id.copy_from_slice(&digest[..16]);
    uuid::Uuid::from_bytes(id).to_string()
}

fn import_assistant(
    settings: &mut Value,
    backend: &str,
    owner: i32,
    definition: &AssistantDefinition,
    revision: u64,
    update: bool,
) -> Result<bool, TaskRuntimeError> {
    let id = copy_id(backend, owner, "assistant", &definition.id);
    let device = settings["executionDeviceId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let roles = settings["roles"].as_array_mut().ok_or_else(invalid_copy)?;
    if let Some(role) = roles.iter_mut().find(|role| role["id"] == id) {
        if !update
            || role["shareCopyRevision"]
                .as_u64()
                .is_some_and(|current| current >= revision)
        {
            return Ok(false);
        }
        role["prompt"] = json!(definition.prompt);
        role["shareCopyRevision"] = json!(revision);
        return Ok(true);
    }
    let mut role = empty_role(&id, &device);
    role["name"] = json!(definition.name);
    role["shareCopyRevision"] = json!(revision);
    role["prompt"] = json!(definition.prompt);
    // Manual role delegation uses enabled identities; there are no active intake sources.
    role["enabled"] = json!(true);
    role["collaboration"]["allProjects"] = json!(false);
    roles.push(role);
    Ok(true)
}

fn apply_share_copy(
    settings: &mut Value,
    backend: &str,
    snapshot: &AssistantShareSnapshot,
    update: bool,
) -> Result<bool, TaskRuntimeError> {
    let owner = snapshot.owner_user_id;
    match &snapshot.root.definition {
        AssistantShareDefinition::Assistant(definition) => import_assistant(
            settings,
            backend,
            owner,
            definition,
            snapshot.root.revision,
            update,
        ),
        AssistantShareDefinition::Team(team) => {
            let id = copy_id(backend, owner, "team", &team.id);
            let existing = settings["teams"]
                .as_array()
                .and_then(|teams| teams.iter().position(|team| team["id"] == id));
            if let Some(index) = existing {
                if !update
                    || settings["teams"][index]["shareCopyRevision"]
                        .as_u64()
                        .is_some_and(|revision| revision >= snapshot.root.revision)
                {
                    return Ok(false);
                }
            }
            let mut members = BTreeMap::new();
            for versioned in &snapshot.assistants {
                let AssistantShareDefinition::Assistant(assistant) = &versioned.definition else {
                    return Err(invalid_copy());
                };
                let duty = team.members.get(&assistant.id).ok_or_else(invalid_copy)?;
                import_assistant(
                    settings,
                    backend,
                    owner,
                    assistant,
                    versioned.revision,
                    false,
                )?;
                members.insert(copy_id(backend, owner, "assistant", &assistant.id), duty);
            }
            let lead_id = copy_id(backend, owner, "assistant", &team.lead_id);
            if !members.contains_key(&lead_id) || members.len() != team.members.len() {
                return Err(invalid_copy());
            }
            if settings["teams"].is_null() {
                settings["teams"] = json!([]);
            }
            let teams = settings["teams"].as_array_mut().ok_or_else(invalid_copy)?;
            if let Some(index) = existing {
                teams[index]["members"] = json!(members);
                teams[index]["leadId"] = json!(lead_id);
                teams[index]["shareCopyRevision"] = json!(snapshot.root.revision);
                if let Some(routes) = teams[index]
                    .get_mut("memberRoutes")
                    .and_then(Value::as_object_mut)
                {
                    routes.retain(|id, _| id != &lead_id && members.contains_key(id));
                }
            } else {
                teams.push(json!({"id":id,"name":team.name,"leadId":lead_id,"members":members,"shareCopyRevision":snapshot.root.revision}));
            }
            Ok(true)
        }
    }
}

fn invalid_copy() -> TaskRuntimeError {
    TaskRuntimeError::Invalid("invalid assistant share copy".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_teams_reuse_a_renamed_copy_and_only_update_their_own_duties() {
        let snapshot = |id: &str, duty: &str, prompt: &str| {
            serde_json::from_value::<AssistantShareSnapshot>(json!({
                "owner_user_id":9,
                "root":{"revision":if duty == "Audit" {2} else {1},"definition":{"kind":"team","definition":{
                    "id":id,"name":id,"leadId":"data","members":{"data":duty}
                }}},
                "assistants":[{"revision":1,"definition":{"kind":"assistant","definition":{
                    "id":"data","name":"Data","prompt":prompt
                }}}]
            }))
            .unwrap()
        };
        let mut settings = empty_personal(7, "recipient-device");
        assert!(apply_share_copy(
            &mut settings,
            "https://example.test",
            &snapshot("weekly", "Summarize", "First"),
            false
        )
        .unwrap());
        settings["roles"][0]["name"] = json!("My metrics");
        settings["roles"][0]["prompt"] = json!("My prompt");
        assert!(apply_share_copy(
            &mut settings,
            "https://example.test",
            &snapshot("release", "Validate", "New"),
            false
        )
        .unwrap());
        assert_eq!(settings["roles"].as_array().unwrap().len(), 1);
        assert_eq!(settings["roles"][0]["name"], "My metrics");
        assert_eq!(settings["roles"][0]["prompt"], "My prompt");
        assert_eq!(
            settings["roles"][0]["executionDeviceId"],
            "recipient-device"
        );
        assert!(settings["roles"][0].get("connections").is_none());
        assert!(apply_share_copy(
            &mut settings,
            "https://example.test",
            &snapshot("weekly", "Audit", "New"),
            true
        )
        .unwrap());
        super::super::teams::validate_teams(&settings).unwrap();
        let member = settings["roles"][0]["id"].as_str().unwrap();
        assert_eq!(settings["teams"][0]["members"][member], "Audit");
        assert_eq!(settings["teams"][1]["members"][member], "Validate");
        assert_eq!(settings["roles"][0]["prompt"], "My prompt");
    }
}

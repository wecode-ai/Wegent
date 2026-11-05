//! Conversation-generated settings remain drafts until an explicit host confirmation.
use super::personal_stand_in::read_personal;
use super::*;

fn proposal_key(user: i64, role: Option<&str>) -> String {
    format!(
        "stand-in-proposal:{user}:{}",
        role.map(|id| format!("role:{id}"))
            .unwrap_or_else(|| "primary".into())
    )
}

impl LocalTaskStore {
    pub fn stand_in_proposal(
        &self,
        user: i64,
        role: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut proposal =
            get_item_from(&connection, &proposal_key(user, role), "stand_in_proposal")?
                .map(|row| row.metadata)
                .filter(|value| value["status"] == "pending")
                .unwrap_or(Value::Null);
        if proposal.is_object() {
            super::personal_stand_in::migrate_connections(&mut proposal["settings"])?;
        }
        Ok(proposal)
    }

    pub fn propose_stand_in_settings(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        summary: &str,
        mut settings: Value,
    ) -> Result<Value, TaskRuntimeError> {
        super::personal_stand_in::migrate_connections(&mut settings)?;
        if summary.trim().is_empty() || summary.len() > 4000 {
            return Err(TaskRuntimeError::Invalid(
                "proposal summary is required".into(),
            ));
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_personal(&connection, user, device)?;
        if let Some(role) = role {
            let other_roles = |settings: &Value| {
                settings["roles"].as_array().map(|rows| {
                    rows.iter()
                        .filter(|row| row["id"] != role)
                        .cloned()
                        .collect::<Vec<_>>()
                })
            };
            if previous["primary"] != settings["primary"]
                || previous["processing"] != settings["processing"]
                || other_roles(&previous) != other_roles(&settings)
            {
                return Err(TaskRuntimeError::Invalid(
                    "A role can only propose changes to itself".into(),
                ));
            }
        }
        // Validate with the same writer, then roll back its savepoint. Nothing is enabled.
        connection.execute_batch("SAVEPOINT validate_stand_in_proposal")?;
        self.save_personal_stand_in_on(&connection, user, device, settings.clone())?;
        connection.execute_batch(
            "ROLLBACK TO validate_stand_in_proposal; RELEASE validate_stand_in_proposal",
        )?;
        let proposal = json!({"id":Uuid::new_v4().to_string(),"userId":user,"roleId":role,"summary":summary,"settings":settings,"status":"pending"});
        connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_proposal',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at", params![proposal_key(user,role),proposal.to_string(),now()])?;
        connection.commit()?;
        Ok(proposal)
    }

    pub fn resolve_stand_in_proposal(
        &self,
        user: i64,
        device: &str,
        id: &str,
        accept: bool,
        prepared: Option<Value>,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = connection.prepare("SELECT id,metadata FROM loop_items WHERE resource_type='stand_in_proposal' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.id')=?2")?;
        let (key, raw): (String, String) =
            statement.query_row(params![user, id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        drop(statement);
        let mut proposal: Value = serde_json::from_str(&raw)
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        if proposal["status"] != "pending" {
            return Err(TaskRuntimeError::Invalid(
                "Proposal is no longer pending".into(),
            ));
        }
        let saved = if accept {
            self.save_personal_stand_in_on(
                &connection,
                user,
                device,
                prepared.unwrap_or_else(|| proposal["settings"].clone()),
            )?
        } else {
            read_personal(&connection, user, device)?
        };
        proposal["status"] = json!(if accept { "accepted" } else { "rejected" });
        connection.execute(
            "UPDATE loop_items SET metadata=?1,updated_at=?2 WHERE id=?3",
            params![proposal.to_string(), now(), key],
        )?;
        connection.commit()?;
        Ok(saved)
    }

    pub fn stand_in_proposal_settings(
        &self,
        user: i64,
        id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let raw: String = connection.query_row(
            "SELECT metadata FROM loop_items WHERE resource_type='stand_in_proposal' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.id')=?2",
            params![user, id], |row| row.get(0),
        )?;
        let proposal: Value = serde_json::from_str(&raw)
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        Ok(proposal["settings"].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_role_proposal_preserves_existing_settings_until_explicit_confirmation() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let previous = store.personal_stand_in(7, "mac").unwrap();
        let mut settings = previous.clone();
        let mut role = settings["roles"][0].clone();
        role["id"] = json!("atlas-followup");
        role["name"] = json!("Atlas follow-up");
        role["enabled"] = json!(true);
        role["collaboration"] = json!({"enabled":true,"allProjects":false,
            "projects":[{"id":"atlas","store":"local"}],"excludedProjects":[],"tags":[],
            "policy":{"automatic":true,"askBeforeAct":true,"immediate":true}});
        settings["roles"].as_array_mut().unwrap().push(role);
        let mut missing_device = settings.clone();
        missing_device
            .as_object_mut()
            .unwrap()
            .remove("executionDeviceId");
        let error = store
            .propose_stand_in_settings(7, "mac", None, "Add Atlas role", missing_device)
            .unwrap_err();
        assert!(error.to_string().contains("settings.executionDeviceId"));
        let proposal = store
            .propose_stand_in_settings(7, "mac", None, "Add Atlas role", settings.clone())
            .unwrap();
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), previous);
        let saved = store
            .resolve_stand_in_proposal(7, "mac", proposal["id"].as_str().unwrap(), true, None)
            .unwrap();
        assert_eq!(saved["roles"].as_array().unwrap().len(), 2);
        assert_eq!(
            saved["roles"][0]["collaboration"],
            previous["roles"][0]["collaboration"]
        );
        assert_eq!(
            saved["roles"][1]["collaboration"],
            settings["roles"][1]["collaboration"]
        );
    }

    #[test]
    fn git_removal_preserves_each_generation_for_shared_receivers() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        let source = json!({"providerId":"@wegent/dsh-connection-git/github","profile":"account","id":"42","kind":"repository","name":"org/repo","subscriptionId":"receiver","generation":"old-generation","policy":{"automatic":true,"askBeforeAct":true}});
        settings["roles"][0]["connections"] = json!([source.clone()]);
        let mut current = source;
        current["generation"] = json!("current-generation");
        settings["primary"] =
            json!({"enabled":false,"prompt":"","preferences":"","connections":[current]});
        let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        settings["roles"][0]["connections"] = json!([]);
        settings["primary"]["connections"] = json!([]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let pending = store.pending_git_disconnects(7).unwrap();
        assert_eq!(pending.len(), 2);
        assert!(pending
            .iter()
            .any(|row| row["generation"] == "current-generation"));
        assert!(pending
            .iter()
            .any(|row| row["generation"] == "old-generation"));
        assert!(pending
            .iter()
            .all(|row| row["subscriptionId"] == "receiver"));
    }

    #[test]
    fn git_proposals_revoke_only_the_last_binding_after_acceptance() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        let source = json!({"providerId":"@wegent/dsh-connection-git/github","profile":"account","id":"42","kind":"repository","name":"org/repo","subscriptionId":"receiver","generation":"old-device-generation","policy":{"automatic":true,"askBeforeAct":true}});
        settings["roles"][0]["connections"] = json!([source.clone()]);
        settings["primary"] =
            json!({"enabled":false,"prompt":"","preferences":"","connections":[source]});
        let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        settings["roles"][0]["connections"] = json!([]);
        let proposal = store
            .propose_stand_in_settings(7, "mac", None, "Remove role source", settings)
            .unwrap();
        let mut saved = store
            .resolve_stand_in_proposal(7, "mac", proposal["id"].as_str().unwrap(), true, None)
            .unwrap();
        assert!(store.pending_git_disconnects(7).unwrap().is_empty());
        saved["primary"]["connections"] = json!([]);
        store
            .validate_personal_stand_in_settings(7, "mac", saved.clone())
            .unwrap();
        assert!(store.pending_git_disconnects(7).unwrap().is_empty());
        let proposal = store
            .propose_stand_in_settings(7, "mac", None, "Remove final source", saved.clone())
            .unwrap();
        assert!(store.pending_git_disconnects(7).unwrap().is_empty());
        store
            .resolve_stand_in_proposal(7, "mac", proposal["id"].as_str().unwrap(), false, None)
            .unwrap();
        assert!(store.pending_git_disconnects(7).unwrap().is_empty());
        let proposal = store
            .propose_stand_in_settings(7, "mac", None, "Remove final source", saved)
            .unwrap();
        let result = store
            .resolve_stand_in_proposal(7, "mac", proposal["id"].as_str().unwrap(), true, None)
            .unwrap();
        assert_eq!(result["primary"]["connections"], json!([]));
        let pending = store.pending_git_disconnects(7).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["subscriptionId"], "receiver");
        assert_eq!(pending[0]["generation"], "old-device-generation");
        assert!(store.pending_git_disconnects(8).unwrap().is_empty());
    }

    #[test]
    fn role_proposals_cannot_change_primary_preferences() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let settings = store.personal_stand_in(7, "mac").unwrap();
        let previous = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let mut settings = previous.clone();
        settings["primary"] =
            json!({"enabled":true,"prompt":"","preferences":"Changed primary preferences"});
        let error = store
            .propose_stand_in_settings(
                7,
                "mac",
                Some("default"),
                "Change main preferences",
                settings.clone(),
            )
            .unwrap_err();
        assert!(error.to_string().contains("only propose changes to itself"));
        assert!(store
            .stand_in_proposal(7, Some("default"))
            .unwrap()
            .is_null());
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), previous);
        assert!(store
            .propose_stand_in_settings(7, "mac", None, "Change main preferences", settings)
            .is_ok());
    }
}

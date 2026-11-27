use super::stand_in_inbox::stand_in_record_key;
use super::*;

impl LocalTaskStore {
    /// The background stamp contains no historical message or cohort counts. An on-demand
    /// read can show its timestamp only if the currently authorized report still matches.
    pub fn verified_stand_in_rework_report(
        &self,
        user: i64,
        device: &str,
        role: &str,
        role_device: &str,
        completed_run: Option<&str>,
        authorized_sources: &HashSet<String>,
    ) -> Result<Value, TaskRuntimeError> {
        let mut report =
            self.stand_in_rework_report(user, device, role, role_device, authorized_sources)?;
        let signature = Self::coordination_event_version(&report);
        let key = stand_in_record_key(
            "rework-verification",
            &json!([user, device, role, role_device]),
        );
        let connection = self.connection()?;
        if let Some(run) = completed_run {
            let metadata = json!({"userId":user,"run":run,"signature":signature});
            connection.execute(
                "INSERT INTO loop_items (id,user_id,resource_type,metadata,created_at,updated_at)
                 VALUES (?1,?2,'stand_in_rework_verification',?3,?4,?4)
                 ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at
                 WHERE loop_items.metadata<>excluded.metadata",
                params![key, user, metadata.to_string(), now()],
            )?;
        }
        let stamp = get_item_from(&connection, &key, "stand_in_rework_verification")?;
        report["lastBackgroundVerifiedAt"] = json!(stamp
            .filter(|stamp| stamp.metadata["signature"] == signature)
            .map(|stamp| stamp.updated_at));
        Ok(report)
    }
}

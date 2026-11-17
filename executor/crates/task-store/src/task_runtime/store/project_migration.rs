use super::*;
use sha2::{Digest, Sha256};

#[derive(serde::Serialize)]
pub struct ProjectMigrationSnapshot {
    pub version: i64,
    pub fingerprint: String,
    pub archived: bool,
    pub migration_target: Option<String>,
    pub migration_fingerprint: Option<String>,
}

fn fingerprint(connection: &Connection, project: &str) -> Result<String, TaskRuntimeError> {
    let mut hash = Sha256::new();
    for sql in [
        "SELECT json_object('id',id,'kind',resource_type,'parent',parent_id,'name',name,'title',title,'description',description,'status',status,'priority',priority,'sequence',sequence_number,'sort',sort_order,'due',due_at,'metadata',json_remove(metadata,'$.read_revisions','$.activity_read_sequences'),'version',version,'updated',updated_at,'deleted',deleted_at,'assignee',assignee_user_id,'agent',assignee_agent_id,'sha256',sha256,'object_key',object_key) FROM loop_items WHERE id=?1 OR cloud_project_id=?1 ORDER BY id",
        "SELECT json_object('id',message_id,'task',task_id,'sender_type',sender_type,'sender_id',sender_id,'sender_name',sender_name,'type',message_type,'content',content,'metadata',metadata,'reply',reply_to_message_id,'root',thread_root_message_id,'status',status,'updated',updated_at,'deleted',deleted_at) FROM loop_item_comments WHERE project_id=?1 ORDER BY message_id",
    ] {
        let mut statement = connection.prepare(sql)?;
        for value in statement.query_map([project], |row| row.get::<_, String>(0))? {
            let value = value?;
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value.as_bytes());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn snapshot(
    connection: &Connection,
    project: &str,
) -> Result<ProjectMigrationSnapshot, TaskRuntimeError> {
    let (version, deleted, metadata): (i64, Option<String>, Option<String>) = connection.query_row(
        "SELECT version,deleted_at,metadata FROM loop_items WHERE id=?1 AND resource_type='project'",[project],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    )?;
    let metadata: Value = metadata
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| TaskRuntimeError::Invalid("Invalid project metadata".into()))?
        .unwrap_or_default();
    Ok(ProjectMigrationSnapshot {
        version,
        fingerprint: fingerprint(connection, project)?,
        archived: deleted.is_some(),
        migration_target: metadata["local_migration"]["target"]
            .as_str()
            .map(str::to_owned),
        migration_fingerprint: metadata["local_migration"]["fingerprint"]
            .as_str()
            .map(str::to_owned),
    })
}

impl LocalTaskStore {
    pub fn project_migration_snapshot(
        &self,
        project: &str,
    ) -> Result<ProjectMigrationSnapshot, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let result = snapshot(&transaction, project)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Compare shared content and archive under the same write lock. Private Runtime rows are untouched.
    pub fn archive_migrated_project(
        &self,
        project: &str,
        version: i64,
        expected: &str,
        target: &str,
    ) -> Result<(), TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = snapshot(&transaction, project)?;
        if current.archived || current.version != version || current.fingerprint != expected {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let metadata: Option<String> = transaction.query_row(
            "SELECT metadata FROM loop_items WHERE id=?1",
            [project],
            |row| row.get(0),
        )?;
        let mut metadata: Value = metadata
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| TaskRuntimeError::Invalid("Invalid project metadata".into()))?
            .unwrap_or_else(|| json!({}));
        metadata
            .as_object_mut()
            .ok_or_else(|| TaskRuntimeError::Invalid("Invalid project metadata".into()))?
            .insert(
                "local_migration".into(),
                json!({"target":target,"fingerprint":expected}),
            );
        transaction.execute("UPDATE loop_items SET deleted_at=?1,updated_at=?1,version=version+1,metadata=?2 WHERE id=?3",params![now(),metadata.to_string(),project])?;
        transaction.commit()?;
        Ok(())
    }
}

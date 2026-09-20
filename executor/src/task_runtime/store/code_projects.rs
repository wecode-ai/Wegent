// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use sha2::{Digest, Sha256};

use super::*;

impl LocalTaskStore {
    pub(crate) fn ensure_code_project(
        &self,
        key: &str,
        name: &str,
        roots: &[String],
        bound_local_id: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let id = format!("local-code-{:x}", Sha256::digest(key.as_bytes()));
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Archived projects remain tombstones; refreshing must not resurrect them.
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_items
             WHERE resource_type = 'project' AND (id = ?1 OR id = ?2))",
            params![
                id,
                bound_local_id.filter(|id| *id != DEFAULT_WORK_ITEM_PROJECT_ID)
            ],
            |row| row.get(0),
        )?;
        if !exists {
            let project_key = unused_project_key(&transaction)?;
            let mut metadata = local_project_metadata(TaskProviderKind::Local, json!({}));
            metadata["code_project_key"] = json!(key);
            metadata["workspace_roots"] = json!(roots);
            let timestamp = now();
            transaction.execute(
                "INSERT INTO loop_items (
                    id, resource_type, project_space, public_id, project_key, name,
                    storage_prefix, next_item_number, status, sort_order,
                    metadata, version, created_at, updated_at
                 ) VALUES (?1, 'project', 'default', ?1, ?2, ?3, ?4, 1, 'active',
                           0, ?5, 1, ?6, ?6)",
                params![
                    id,
                    project_key,
                    name,
                    format!("projects/{id}"),
                    metadata.to_string(),
                    timestamp
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
}

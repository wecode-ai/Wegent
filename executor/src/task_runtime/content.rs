// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use base64::{engine::general_purpose, Engine as _};
use rusqlite::{params, OptionalExtension, Row};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    store::{now, numeric_id},
    BinaryInput, Delivery, DeliveryAsset, DeliveryCreate, DeliveryDetail, LocalTaskStore,
    ProjectFile, TaskAttachment, TaskRuntimeError,
};

impl LocalTaskStore {
    pub fn list_project_files(
        &self,
        project_id: &str,
    ) -> Result<Vec<ProjectFile>, TaskRuntimeError> {
        self.get_project(project_id)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, cloud_project_id, path, kind, content_type, size_bytes, sha256,
                    description, version, created_at, updated_at
             FROM loop_items
             WHERE resource_type = 'file' AND cloud_project_id = ?1 AND deleted_at IS NULL
             ORDER BY path",
        )?;
        let rows = statement.query_map([project_id], map_project_file)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(TaskRuntimeError::from)
    }

    pub fn create_project_folder(
        &self,
        project_id: &str,
        path: &str,
    ) -> Result<ProjectFile, TaskRuntimeError> {
        let path = normalize_relative_path(path)?;
        self.get_project(project_id)?;
        self.ensure_parent_folders(project_id, &path)?;
        if self.project_file_id(project_id, &path)?.is_some() {
            return Err(TaskRuntimeError::Invalid(
                "project file path already exists".to_owned(),
            ));
        }
        let id = numeric_id();
        let timestamp = now();
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, path, name, kind,
                status, version, created_at, updated_at
             ) VALUES (?1, 'file', 'default', ?2, ?3, ?4, 'folder', 'active', 1, ?5, ?5)",
            params![id, project_id, path, file_name(&path), timestamp],
        )?;
        drop(connection);
        self.get_project_file(project_id, &id)
    }

    pub fn upload_project_file(
        &self,
        project_id: &str,
        path: Option<&str>,
        input: BinaryInput,
    ) -> Result<ProjectFile, TaskRuntimeError> {
        let path = normalize_relative_path(path.unwrap_or(&input.display_name))?;
        self.get_project(project_id)?;
        self.ensure_parent_folders(project_id, &path)?;
        if self.project_file_id(project_id, &path)?.is_some() {
            return Err(TaskRuntimeError::Invalid(
                "project file path already exists".to_owned(),
            ));
        }
        let bytes = decode_binary(&input)?;
        let id = numeric_id();
        let object_key = format!("files/{id}/{}", sanitize_file_name(&input.display_name));
        let object_path = self.resolve_object_key(Path::new(&object_key))?;
        write_binary(&object_path, &bytes)?;
        let timestamp = now();
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, path, name, kind,
                display_name, object_key, content_type, size_bytes, sha256, status,
                version, created_at, updated_at
             ) VALUES (?1, 'file', 'default', ?2, ?3, ?4, 'file', ?5, ?6, ?7,
                       ?8, ?9, 'active', 1, ?10, ?10)",
            params![
                id,
                project_id,
                path,
                file_name(&path),
                input.display_name,
                object_key,
                input.content_type,
                bytes.len() as i64,
                sha256_hex(&bytes),
                timestamp,
            ],
        )?;
        drop(connection);
        self.get_project_file(project_id, &id)
    }

    pub fn move_project_file(
        &self,
        file_id: &str,
        path: &str,
        version: i64,
    ) -> Result<ProjectFile, TaskRuntimeError> {
        let path = normalize_relative_path(path)?;
        let connection = self.connection()?;
        let (project_id, old_path, current_version): (String, String, i64) = connection.query_row(
            "SELECT cloud_project_id, path, version FROM loop_items
                 WHERE id = ?1 AND resource_type = 'file' AND deleted_at IS NULL",
            [file_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if current_version != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        drop(connection);
        self.ensure_parent_folders(&project_id, &path)?;
        if self.project_file_id(&project_id, &path)?.is_some() {
            return Err(TaskRuntimeError::Invalid(
                "project file path already exists".to_owned(),
            ));
        }
        let connection = self.connection()?;
        let timestamp = now();
        connection.execute(
            "UPDATE loop_items SET path = ?1, name = ?2, version = version + 1,
                    updated_at = ?3 WHERE id = ?4",
            params![path, file_name(&path), timestamp, file_id],
        )?;
        connection.execute(
            "UPDATE loop_items SET path = ?1 || substr(path, ?2),
                    version = version + 1, updated_at = ?3
             WHERE resource_type = 'file' AND cloud_project_id = ?4
               AND path LIKE ?5 AND deleted_at IS NULL",
            params![
                path,
                old_path.len() as i64 + 1,
                timestamp,
                project_id,
                format!("{old_path}/%"),
            ],
        )?;
        drop(connection);
        self.get_project_file(&project_id, file_id)
    }

    pub fn delete_project_file(
        &self,
        file_id: &str,
        recursive: bool,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let (project_id, path, kind): (String, String, String) = connection.query_row(
            "SELECT cloud_project_id, path, kind FROM loop_items
             WHERE id = ?1 AND resource_type = 'file' AND deleted_at IS NULL",
            [file_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let descendants: i64 = connection.query_row(
            "SELECT COUNT(*) FROM loop_items WHERE resource_type = 'file'
             AND cloud_project_id = ?1 AND path LIKE ?2 AND deleted_at IS NULL",
            params![project_id, format!("{path}/%")],
            |row| row.get(0),
        )?;
        if kind == "folder" && descendants > 0 && !recursive {
            return Err(TaskRuntimeError::Invalid(
                "folder contains files".to_owned(),
            ));
        }
        let timestamp = now();
        connection.execute(
            "UPDATE loop_items SET deleted_at = ?1, updated_at = ?1
             WHERE resource_type = 'file' AND cloud_project_id = ?2
               AND (id = ?3 OR (?4 AND path LIKE ?5))",
            params![
                timestamp,
                project_id,
                file_id,
                recursive,
                format!("{path}/%"),
            ],
        )?;
        Ok(())
    }

    pub fn project_file_path(&self, file_id: &str) -> Result<PathBuf, TaskRuntimeError> {
        self.object_path(file_id, "file")
    }

    fn project_file_id(
        &self,
        project_id: &str,
        path: &str,
    ) -> Result<Option<String>, TaskRuntimeError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id FROM loop_items WHERE resource_type = 'file'
                 AND cloud_project_id = ?1 AND path = ?2 AND deleted_at IS NULL",
                params![project_id, path],
                |row| row.get(0),
            )
            .optional()
            .map_err(TaskRuntimeError::from)
    }

    fn get_project_file(
        &self,
        project_id: &str,
        file_id: &str,
    ) -> Result<ProjectFile, TaskRuntimeError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, cloud_project_id, path, kind, content_type, size_bytes, sha256,
                        description, version, created_at, updated_at
                 FROM loop_items
                 WHERE id = ?1 AND cloud_project_id = ?2 AND resource_type = 'file'
                   AND deleted_at IS NULL",
                params![file_id, project_id],
                map_project_file,
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    fn ensure_parent_folders(&self, project_id: &str, path: &str) -> Result<(), TaskRuntimeError> {
        let parts = path.split('/').collect::<Vec<_>>();
        for index in 1..parts.len() {
            let parent_path = parts[..index].join("/");
            if self.project_file_id(project_id, &parent_path)?.is_some() {
                continue;
            }
            let id = numeric_id();
            let timestamp = now();
            let connection = self.connection()?;
            connection.execute(
                "INSERT INTO loop_items (
                    id, resource_type, project_space, cloud_project_id, path, name,
                    kind, status, version, created_at, updated_at
                 ) VALUES (?1, 'file', 'default', ?2, ?3, ?4, 'folder', 'active',
                           1, ?5, ?5)",
                params![
                    id,
                    project_id,
                    parent_path,
                    file_name(&parent_path),
                    timestamp
                ],
            )?;
        }
        Ok(())
    }
}

fn map_delivery(row: &Row<'_>) -> rusqlite::Result<Delivery> {
    let snapshot = row
        .get::<_, Option<String>>(3)?
        .and_then(|value| serde_json::from_str(&value).ok());
    Ok(Delivery {
        id: row.get(0)?,
        loop_item_id: row.get(1)?,
        created_by_user_id: 0,
        source_task_binding_id: row.get(2)?,
        source_task_snapshot: snapshot,
        status: row.get(4)?,
        created_at: row.get(5)?,
        delivered_at: row.get(6)?,
        assets: vec![],
    })
}

fn map_delivery_asset(row: &Row<'_>) -> rusqlite::Result<DeliveryAsset> {
    Ok(DeliveryAsset {
        id: row.get(0)?,
        kind: row
            .get::<_, Option<String>>(1)?
            .unwrap_or_else(|| "file".to_owned()),
        display_name: row.get(2)?,
        relative_path: row.get(3)?,
        content_type: row.get(4)?,
        size_bytes: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
        sha256: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
    })
}

impl LocalTaskStore {
    fn binary_root(&self) -> Result<PathBuf, TaskRuntimeError> {
        let parent = self
            .path()
            .parent()
            .ok_or_else(|| TaskRuntimeError::Invalid("task database path is invalid".to_owned()))?;
        let root = parent.join("objects");
        fs::create_dir_all(&root).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        Ok(root)
    }

    fn object_path(&self, item_id: &str, resource_type: &str) -> Result<PathBuf, TaskRuntimeError> {
        let connection = self.connection()?;
        let path = connection
            .query_row(
                "SELECT object_key FROM loop_items
                 WHERE id = ?1 AND resource_type = ?2 AND deleted_at IS NULL",
                params![item_id, resource_type],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        self.resolve_object_key(Path::new(&path))
    }

    fn resolve_object_key(&self, object_key: &Path) -> Result<PathBuf, TaskRuntimeError> {
        if object_key.is_absolute()
            || object_key
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(TaskRuntimeError::Invalid(
                "stored object key must be a safe relative path".to_owned(),
            ));
        }
        Ok(self.binary_root()?.join(object_key))
    }
}

fn decode_binary(input: &BinaryInput) -> Result<Vec<u8>, TaskRuntimeError> {
    general_purpose::STANDARD
        .decode(input.base64.as_bytes())
        .map_err(|error| TaskRuntimeError::Invalid(format!("invalid base64 content: {error}")))
}

fn write_binary(path: &Path, bytes: &[u8]) -> Result<(), TaskRuntimeError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
    }
    fs::write(path, bytes).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
}

fn normalize_relative_path(value: &str) -> Result<String, TaskRuntimeError> {
    let value = value.trim().replace('\\', "/");
    if value.is_empty() {
        return Err(TaskRuntimeError::Invalid(
            "file path is required".to_owned(),
        ));
    }
    let path = Path::new(&value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(TaskRuntimeError::Invalid(
            "file path must be a safe relative path".to_owned(),
        ));
    }
    Ok(path
        .components()
        .filter_map(|part| match part {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/"))
}

fn sanitize_file_name(value: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("file")
        .to_owned()
}

fn file_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_owned()
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn map_project_file(row: &Row<'_>) -> rusqlite::Result<ProjectFile> {
    let path: String = row.get(2)?;
    Ok(ProjectFile {
        id: row.get(0)?,
        cloud_project_id: row.get(1)?,
        name: file_name(&path),
        path,
        kind: row.get(3)?,
        content_type: row.get(4)?,
        size_bytes: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
        sha256: row.get(6)?,
        description: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        created_by_user_id: 0,
        updated_by_user_id: 0,
        version: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

impl LocalTaskStore {
    pub fn add_task_attachment(
        &self,
        project_id: &str,
        item_id: &str,
        persisted_task: bool,
        input: BinaryInput,
    ) -> Result<TaskAttachment, TaskRuntimeError> {
        self.get_project(project_id)?;
        if persisted_task {
            self.get_item(item_id, "task")?;
        }
        let bytes = decode_binary(&input)?;
        let id = numeric_id();
        let object_key = format!(
            "attachments/{id}/{}",
            sanitize_file_name(&input.display_name)
        );
        let object_path = self.resolve_object_key(Path::new(&object_key))?;
        write_binary(&object_path, &bytes)?;
        let timestamp = now();
        let loop_item_id = persisted_task.then_some(item_id);
        let metadata = json!({
            "external_item_id": (!persisted_task).then_some(item_id),
        });
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, loop_item_id,
                display_name, object_key, content_type, size_bytes, sha256, metadata,
                status, version, created_at, updated_at
             ) VALUES (?1, 'attachment', 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                       ?9, 'active', 1, ?10, ?10)",
            params![
                id,
                project_id,
                loop_item_id,
                input.display_name,
                object_key,
                input.content_type,
                bytes.len() as i64,
                sha256_hex(&bytes),
                metadata.to_string(),
                timestamp,
            ],
        )?;
        drop(connection);
        self.get_task_attachment(&id)
    }

    pub fn list_task_attachments(
        &self,
        item_id: &str,
    ) -> Result<Vec<TaskAttachment>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                    display_name, content_type, size_bytes, sha256,
                    created_at
             FROM loop_items
             WHERE resource_type = 'attachment'
               AND (loop_item_id = ?1 OR json_extract(metadata, '$.external_item_id') = ?1)
               AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([item_id], map_task_attachment)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(TaskRuntimeError::from)
    }

    pub fn task_attachment_path(&self, attachment_id: &str) -> Result<PathBuf, TaskRuntimeError> {
        self.object_path(attachment_id, "attachment")
    }

    pub fn delete_task_attachment(&self, attachment_id: &str) -> Result<(), TaskRuntimeError> {
        let path = self.task_attachment_path(attachment_id)?;
        let connection = self.connection()?;
        connection.execute(
            "UPDATE loop_items SET deleted_at = ?1, updated_at = ?1
             WHERE id = ?2 AND resource_type = 'attachment'",
            params![now(), attachment_id],
        )?;
        let _ = fs::remove_file(path);
        Ok(())
    }

    fn get_task_attachment(&self, attachment_id: &str) -> Result<TaskAttachment, TaskRuntimeError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                        display_name, content_type, size_bytes, sha256,
                        created_at
                 FROM loop_items
                 WHERE id = ?1 AND resource_type = 'attachment' AND deleted_at IS NULL",
                [attachment_id],
                map_task_attachment,
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }
}

fn map_task_attachment(row: &Row<'_>) -> rusqlite::Result<TaskAttachment> {
    Ok(TaskAttachment {
        id: row.get(0)?,
        loop_item_id: row.get(1)?,
        display_name: row.get(2)?,
        content_type: row.get(3)?,
        size_bytes: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
        sha256: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        created_by_user_id: 0,
        created_at: row.get(6)?,
    })
}

impl LocalTaskStore {
    pub fn create_delivery(
        &self,
        project_id: &str,
        item_id: &str,
        persisted_task: bool,
        input: DeliveryCreate,
    ) -> Result<Delivery, TaskRuntimeError> {
        self.get_project(project_id)?;
        if persisted_task {
            self.get_item(item_id, "task")?;
        }
        let id = numeric_id();
        let base_key = format!("deliveries/{id}");
        let markdown_key = format!("{base_key}/markdown.md");
        let markdown_path = self.resolve_object_key(Path::new(&markdown_key))?;
        write_binary(&markdown_path, input.markdown.as_bytes())?;
        let chat_key = input
            .chat
            .as_ref()
            .map(|chat| {
                let key = format!("{base_key}/chat.json");
                let path = self.resolve_object_key(Path::new(&key))?;
                let bytes = serde_json::to_vec_pretty(chat)
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
                write_binary(&path, &bytes)?;
                Ok::<_, TaskRuntimeError>(key)
            })
            .transpose()?;
        let source_binding_id = input
            .source_task
            .as_ref()
            .map(|task| self.find_task_binding(&task.device_id, &task.task_id))
            .transpose()?
            .map(|binding| binding.id);
        let source_snapshot = input
            .source_task
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        let timestamp = now();
        let loop_item_id = persisted_task.then_some(item_id);
        let metadata = json!({
            "external_item_id": (!persisted_task).then_some(item_id),
        });
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, loop_item_id,
                source_task_binding_id, source_task_snapshot, markdown_object_key,
                chat_object_key, metadata, status, version, created_at, updated_at
             ) VALUES (?1, 'delivery', 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                       'draft', 1, ?9, ?9)",
            params![
                id,
                project_id,
                loop_item_id,
                source_binding_id,
                source_snapshot.map(|value| value.to_string()),
                markdown_key,
                chat_key,
                metadata.to_string(),
                timestamp,
            ],
        )?;
        drop(connection);
        self.get_delivery(item_id, &id)
    }

    pub fn add_delivery_asset(
        &self,
        delivery_id: &str,
        relative_path: &str,
        input: BinaryInput,
    ) -> Result<DeliveryAsset, TaskRuntimeError> {
        let (project_id, loop_item_id, external_item_id, status): (
            String,
            Option<String>,
            Option<String>,
            String,
        ) = {
            let connection = self.connection()?;
            connection.query_row(
                "SELECT cloud_project_id, loop_item_id,
                        json_extract(metadata, '$.external_item_id'), status
                 FROM loop_items
                 WHERE id = ?1 AND resource_type = 'delivery' AND deleted_at IS NULL",
                [delivery_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?
        };
        if status != "draft" {
            return Err(TaskRuntimeError::Invalid(
                "delivery is already delivered".to_owned(),
            ));
        }
        let relative_path = normalize_relative_path(relative_path)?;
        let bytes = decode_binary(&input)?;
        let id = numeric_id();
        let object_key = format!("deliveries/{delivery_id}/{relative_path}");
        let object_path = self.resolve_object_key(Path::new(&object_key))?;
        write_binary(&object_path, &bytes)?;
        let timestamp = now();
        let metadata = json!({"external_item_id": external_item_id});
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, loop_item_id,
                delivery_id, kind, display_name, relative_path, object_key,
                content_type, size_bytes, sha256, metadata, status, version, created_at, updated_at
             ) VALUES (?1, 'delivery_asset', 'default', ?2, ?3, ?4, 'file', ?5, ?6,
                       ?7, ?8, ?9, ?10, ?11, 'draft', 1, ?12, ?12)",
            params![
                id,
                project_id,
                loop_item_id,
                delivery_id,
                input.display_name,
                relative_path,
                object_key,
                input.content_type,
                bytes.len() as i64,
                sha256_hex(&bytes),
                metadata.to_string(),
                timestamp,
            ],
        )?;
        drop(connection);
        self.get_delivery_asset(&id)
    }

    pub fn finalize_delivery(
        &self,
        item_id: &str,
        delivery_id: &str,
    ) -> Result<Delivery, TaskRuntimeError> {
        self.get_delivery(item_id, delivery_id)?;
        let timestamp = now();
        let connection = self.connection()?;
        connection.execute(
            "UPDATE loop_items SET status = 'delivered', delivered_at = ?1, updated_at = ?1
             WHERE id = ?2 AND resource_type = 'delivery'",
            params![timestamp, delivery_id],
        )?;
        connection.execute(
            "UPDATE loop_items SET status = 'delivered', updated_at = ?1
             WHERE delivery_id = ?2 AND resource_type = 'delivery_asset'",
            params![timestamp, delivery_id],
        )?;
        connection.execute(
            "UPDATE loop_items SET current_delivery_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![delivery_id, timestamp, item_id],
        )?;
        drop(connection);
        self.get_delivery(item_id, delivery_id)
    }

    pub fn discard_delivery(&self, delivery_id: &str) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE loop_items SET deleted_at = ?1, updated_at = ?1
             WHERE (id = ?2 AND resource_type = 'delivery')
                OR (delivery_id = ?2 AND resource_type = 'delivery_asset')",
            params![now(), delivery_id],
        )?;
        let _ = fs::remove_dir_all(self.binary_root()?.join("deliveries").join(delivery_id));
        Ok(())
    }

    pub fn list_deliveries(&self, item_id: &str) -> Result<Vec<Delivery>, TaskRuntimeError> {
        let connection = self.connection()?;
        let ids = {
            let mut statement = connection.prepare(
                "SELECT id FROM loop_items
                 WHERE resource_type = 'delivery'
                   AND (loop_item_id = ?1 OR json_extract(metadata, '$.external_item_id') = ?1)
                   AND deleted_at IS NULL ORDER BY created_at DESC",
            )?;
            let ids = statement
                .query_map([item_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        drop(connection);
        ids.into_iter()
            .map(|id| self.get_delivery(item_id, &id))
            .collect()
    }

    pub fn delivery_detail(&self, delivery_id: &str) -> Result<DeliveryDetail, TaskRuntimeError> {
        let (item_id, markdown_path, chat_path): (String, String, Option<String>) = {
            let connection = self.connection()?;
            connection.query_row(
                "SELECT COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                        markdown_object_key, chat_object_key
                 FROM loop_items WHERE id = ?1 AND resource_type = 'delivery'
                   AND deleted_at IS NULL",
                [delivery_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?
        };
        let delivery = self.get_delivery(&item_id, delivery_id)?;
        let markdown = fs::read_to_string(self.resolve_object_key(Path::new(&markdown_path))?)
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        let chat = chat_path
            .map(|path| self.resolve_object_key(Path::new(&path)))
            .transpose()?
            .map(fs::read_to_string)
            .transpose()
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?
            .map(|content| serde_json::from_str(&content))
            .transpose()
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        Ok(DeliveryDetail {
            delivery,
            markdown,
            chat,
        })
    }

    pub fn delivery_asset_path(&self, asset_id: &str) -> Result<PathBuf, TaskRuntimeError> {
        self.object_path(asset_id, "delivery_asset")
    }

    fn get_delivery(&self, item_id: &str, delivery_id: &str) -> Result<Delivery, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut delivery = connection
            .query_row(
                "SELECT id,
                        COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                        source_task_binding_id, source_task_snapshot,
                        status, created_at, delivered_at
                 FROM loop_items
                 WHERE id = ?1 AND resource_type = 'delivery'
                   AND (loop_item_id = ?2 OR json_extract(metadata, '$.external_item_id') = ?2)
                   AND deleted_at IS NULL",
                params![delivery_id, item_id],
                map_delivery,
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let mut statement = connection.prepare(
            "SELECT id, kind, display_name, relative_path, content_type, size_bytes, sha256
             FROM loop_items WHERE resource_type = 'delivery_asset' AND delivery_id = ?1
               AND deleted_at IS NULL ORDER BY relative_path",
        )?;
        delivery.assets = statement
            .query_map([delivery_id], map_delivery_asset)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(delivery)
    }

    fn get_delivery_asset(&self, asset_id: &str) -> Result<DeliveryAsset, TaskRuntimeError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, kind, display_name, relative_path, content_type, size_bytes, sha256
                 FROM loop_items WHERE id = ?1 AND resource_type = 'delivery_asset'
                   AND deleted_at IS NULL",
                [asset_id],
                map_delivery_asset,
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }
}

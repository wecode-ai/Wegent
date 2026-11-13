// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, TransactionBehavior};
use serde_json::{json, Value};
use thiserror::Error;
use uuid::Uuid;

mod assignment_receipts;
mod code_projects;
pub mod execution_workspace;
mod human_requests;
mod stand_in_dispatches;
pub use human_requests::IssueHumanRequestScope;
mod issue_badges;
pub mod milestones;
mod my_work;
mod ordering;
#[path = "project_coordination.rs"]
mod project_coordination;
#[path = "project_coordination_commands.rs"]
mod project_coordination_commands;
mod project_coordinator;
#[path = "project_router_store.rs"]
pub mod project_router_store;
mod project_status;
mod project_tags;

use super::credentials::{encrypt_provider_config, update_provider_config};
use super::model::{
    ArchivedLoopItem, ArchivedLoopItemPage, ChatAgent, ChatAgentCreate, ChatAgentUpdate,
    LocalComment, LocalCommentCreate, LocalExecution, LocalExecutionClaim,
    LocalRuntimeCommentStart, LoopItem, ProjectCreate, ProjectDescriptor, ProjectStoreKind,
    ProjectUpdate, RuntimeTaskAddress, TaskBinding, TaskCreate, TaskProviderKind, TaskReorder,
    TaskUpdate,
};

#[path = "local_automation.rs"]
mod local_automation;
pub(super) use local_automation::on_status_changed;
pub(super) use project_status::runtime_transition_status;

#[path = "runner_dispatch.rs"]
mod runner_dispatch;

#[cfg(test)]
#[path = "runner_routing_tests.rs"]
mod runner_routing_tests;

#[cfg(test)]
#[path = "local_automation_tests.rs"]
mod local_automation_tests;

#[cfg(test)]
#[path = "local_assignment_status_tests.rs"]
mod local_assignment_status_tests;

#[path = "local_execution_activity.rs"]
mod local_execution_activity;
use local_execution_activity::{
    create_execution_comment, create_local_execution, ensure_execution_binding, insert_task_binding,
};

#[path = "collaboration_dispatch.rs"]
mod collaboration_dispatch;

#[path = "stand_in.rs"]
mod stand_in;

#[path = "personal_stand_in.rs"]
pub mod personal_stand_in;
#[path = "stand_in_lifecycle.rs"]
mod stand_in_lifecycle;

#[path = "stand_in_proposals.rs"]
mod stand_in_proposals;

#[path = "stand_in_memories.rs"]
mod stand_in_memories;
#[path = "stand_in_memory_progress.rs"]
mod stand_in_memory_progress;

#[path = "stand_in_inbox.rs"]
mod stand_in_inbox;

#[path = "stand_in_processing.rs"]
mod stand_in_processing;

#[path = "coordination_store.rs"]
mod coordination_store;

#[path = "coordination_arrangements.rs"]
mod coordination_arrangements;

#[path = "stand_in_telemetry.rs"]
pub mod stand_in_telemetry;

const LOCAL_SCHEMA_VERSION: i64 = 11;
const DEFAULT_WORK_ITEM_PROJECT_ID: &str = "default-work-items";
const DEFAULT_WORK_ITEM_PROJECT_KEY: &str = "WORK";
const RUNTIME_PROJECTION_METADATA_KEY: &str = "runtime_projection";
static LOCAL_TASK_STORE_INITIALIZATION: Mutex<()> = Mutex::new(());

#[derive(Debug, Error)]
pub enum TaskRuntimeError {
    #[error("local task database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("invalid task data: {0}")]
    Invalid(String),
    #[error("project not found")]
    ProjectNotFound,
    #[error("task not found")]
    TaskNotFound,
    #[error("task changed")]
    VersionConflict,
    #[error("This fact or its evidence was forgotten or corrected; do not reconstruct it")]
    MemorySuppressed,
    #[error("task provider '{0}' is not implemented yet")]
    UnsupportedProvider(String),
    #[error("task provider request failed: {0}")]
    ProviderRequest(String),
    #[error("local task database is unavailable")]
    LockPoisoned,
}

#[derive(Clone)]
pub struct LocalTaskStore {
    connection: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl LocalTaskStore {
    pub fn default_path() -> PathBuf {
        local_database_path()
    }

    pub fn from_env() -> Result<Self, TaskRuntimeError> {
        Self::open(Self::default_path())
    }

    pub fn from_env_if_exists() -> Result<Option<Self>, TaskRuntimeError> {
        let path = Self::default_path();
        if !path.exists() {
            return Ok(None);
        }
        Self::open(path).map(Some)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, TaskRuntimeError> {
        let _initialization = LOCAL_TASK_STORE_INITIALIZATION
            .lock()
            .map_err(|_| TaskRuntimeError::LockPoisoned)?;
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        }
        let connection = Connection::open(&path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn get_project(&self, project_id: &str) -> Result<LoopItem, TaskRuntimeError> {
        let connection = self.connection()?;
        if let Some(project) = get_item_from(&connection, project_id, "project")? {
            return Ok(project);
        }
        external_project_from_catalog(&connection, project_id)?
            .ok_or(TaskRuntimeError::ProjectNotFound)
    }

    pub(crate) fn get_item(
        &self,
        id: &str,
        resource_type: &str,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let connection = self.connection()?;
        get_item_from(&connection, id, resource_type)?.ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub(crate) fn connection(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Connection>, TaskRuntimeError> {
        self.connection
            .lock()
            .map_err(|_| TaskRuntimeError::LockPoisoned)
    }
}

/// Columns shared by every query that materializes a [`TaskBinding`]. The
/// dispatch columns keep the personal task linked to the collaboration round
/// assignment a manager created for it.
const TASK_BINDING_COLUMNS: &str = "
            id, COALESCE(cloud_project_id, json_extract(metadata, '$.project_id')),
            COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
            task_user_id, device_id,
            task_id, task_title, backend_task_id,
            json_extract(metadata, '$.workflow_node_id'),
            json_extract(metadata, '$.workflow_stage_input'),
            CASE
                WHEN COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                     = 'default-work-items'
                THEN 'system'
                ELSE 'user'
            END,
            linked_at,
            json_extract(metadata, '$.model_selection'),
            json_extract(metadata, '$.execution_context'),
            json_extract(metadata, '$.human_assignment_id'),
            json_extract(metadata, '$.dispatch_id'),
            json_extract(metadata, '$.dispatch_round_id'),
            json_extract(metadata, '$.assignment_id'),
            json_extract(metadata, '$.stand_in_pending')
";

struct RuntimeProjectionTask {
    title: Option<String>,
    description: String,
    priority: Option<String>,
    parent_id: Option<String>,
    current_delivery_id: Option<String>,
    assignee_agent_id: Option<String>,
    metadata: Value,
}

fn local_database_path() -> PathBuf {
    crate::config::paths::executor_home().join("data/tasks.sqlite")
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
}

pub(crate) fn numeric_id() -> String {
    let prefix = &Uuid::new_v4().simple().to_string()[..13];
    u64::from_str_radix(prefix, 16)
        .expect("UUID prefix should be hexadecimal")
        .to_string()
}

struct CollaborationGroupExecutionInput<'a> {
    item_id: &'a str,
    project_id: &'a str,
    group: &'a Value,
    issue_title: &'a str,
    issue_description: &'a str,
    issue_status: Option<&'a str>,
    prompt: Option<&'a str>,
    priority: &'a str,
    payload: Value,
}

const COLLABORATION_MANAGER_SYSTEM_INSTRUCTIONS: &str =
    "You are the manager for one project Issue. Coordinate the collaboration \
group through the project-space management tools. Assign one concurrent batch \
of concrete tasks at a time. Each task must identify its assignee and, when \
configured, its workflow stage. Do not execute member work yourself. After \
every batch finishes, evaluate the evidence and either assign the next batch \
or explicitly update the Issue status. When updating the Issue status, use the \
optional comment field when collaborators need an explanation. The Executor \
already records manager and member runs in the Issue activity.";

fn priority_weight(priority: &str) -> i64 {
    match priority {
        "low" => 10,
        "medium" => 20,
        "high" => 30,
        "urgent" => 40,
        _ => 0,
    }
}

fn lease_expiry(now: &str, lease_seconds: u64) -> String {
    let parsed = chrono::DateTime::parse_from_rfc3339(now)
        .unwrap_or_else(|_| chrono::Utc::now().fixed_offset())
        .naive_utc();
    (parsed + chrono::Duration::seconds(lease_seconds as i64))
        .and_utc()
        .to_rfc3339()
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        value.to_owned()
    } else {
        value.chars().take(max).collect()
    }
}

#[cfg(test)]
#[path = "store_archive_tests.rs"]
mod archive_tests;

#[cfg(test)]
#[path = "store/tests/mod.rs"]
mod tests;

mod project_records;

mod task_records;

mod agent_records;

mod comment_records;

mod execution_transitions;

mod execution_claims;

mod execution_completion;

mod task_archive;

mod task_bindings;

mod binding_rows;

mod schema;

mod projections;

mod providers;

mod validation;

mod record_rows;

mod collaboration;

mod execution_payload;
use binding_rows::get_binding_by_kind;
use binding_rows::get_effective_binding;
use binding_rows::insert_chat_agent;
use binding_rows::local_workflow_stage_snapshot;
use binding_rows::map_task_binding;
use binding_rows::validate_local_workflow_task_binding;
use collaboration::collaboration_agent;
use collaboration::collaboration_group;
use collaboration::dispatch_collaboration_group_assignment;
use collaboration::record_assignment_change;
use execution_payload::cancel_active_executions;
use execution_payload::local_execution_runtime_payload;
use execution_payload::update_agent_comment;
use projections::attach_execution;
use projections::collect_items;
pub(super) use projections::get_item_from;
use projections::latest_execution;
use projections::latest_executions_for_project;
use projections::map_loop_item;
pub(super) use projections::refresh_runtime_projection_additional_context;
pub use projections::task_provider;
use providers::descriptor_loop_item;
use providers::external_project_from_catalog;
use providers::list_external_projects;
use providers::local_project_metadata;
use providers::project_key_for_create;
use providers::project_store_key;
use providers::provider_credential_config;
use providers::require_parent;
use providers::task_provider_key;
pub use providers::validate_provider;
use record_rows::comment_row;
use record_rows::execution_row;
use record_rows::insert_comment;
use record_rows::local_execution_display_state;
use record_rows::map_chat_agent;
use record_rows::map_comment;
use record_rows::map_execution;
use record_rows::move_runtime_comment_task_to_in_progress;
use schema::migrate;
use schema::unused_project_key;
use validation::validate_chat_agent_runtime;
use validation::validate_mcp_servers;
use validation::validate_name;
use validation::validate_priority;
use validation::validate_schedule_range;
use validation::validate_workspace_policy;

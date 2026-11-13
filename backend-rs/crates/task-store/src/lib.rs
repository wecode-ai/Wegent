//! Task persistence, transactional lifecycle, and stable task documents.

#![forbid(unsafe_code)]

#[cfg(test)]
use wegent_backend_persistence::connection::connect as connect_mysql;
pub use wegent_backend_persistence::{request_sql, sql_support};
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
use wegent_python_compat::json_compat;

pub mod task_creation;
pub mod task_store;
pub mod task_store_background;
pub mod task_store_cancel_statements;
pub mod task_store_create;
pub mod task_store_default;
pub mod task_store_edit;
pub mod task_store_executor_reference;
pub mod task_store_listing;
pub mod task_store_maintenance;
pub mod task_store_personal;
pub mod task_store_pipeline;
pub use task_store_pipeline::{
    clear_pending_pipeline_handoff, pending_pipeline_parent, settle_pipeline_handoff,
};
pub mod task_store_project;
pub mod task_store_project_count;
pub mod task_store_projects;
pub mod task_store_public_share;
pub mod task_store_statements;
pub mod task_store_subtask_content;
pub mod task_store_subtask_writes;
pub mod task_store_tables;
pub mod task_store_traits;

pub mod access_statements;
pub mod message_pair;
pub mod owned_statements;
pub mod projection;
pub mod prompt;

/// Maximum number of ancestors visited while resolving fork history.
pub const MAX_FORK_DEPTH: u32 = 50;

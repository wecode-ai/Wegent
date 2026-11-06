//! Workspace file operations, repository identity, and change tracking.

use wegent_runtime_logging as logging;
use wegent_subprocess as process;
pub mod native_git;
pub mod repository_identity;
pub mod turn_file_changes;
pub mod workspace_files;

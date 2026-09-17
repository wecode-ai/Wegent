// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Single source of truth for where task workspaces live.
//!
//! The agent working directory, the runtime archive and the envd file API all
//! have to agree on the workspace root. Resolving it separately in each place
//! let a code task run inside one directory while the file panel listed
//! another, which surfaced as an empty file tree.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Prefix that API callers (backend, executor manager, web UI) use for paths
/// inside the workspace.
pub(crate) const LOGICAL_WORKSPACE_ROOT: &str = "/workspace";

/// Directory that owns the per-task workspaces; a task workspace is
/// `<workspace_root()>/<task_id>`.
///
/// `WORKSPACE_ROOT` lets container deployments point the process at the
/// workspace they mounted. The remaining variables describe the wecode
/// device layout used when the executor runs next to a local checkout.
pub(crate) fn workspace_root() -> PathBuf {
    if let Some(root) =
        env_path("WORKSPACE_ROOT").or_else(|| env_path("WEGENT_EXECUTOR_PROJECTS_DIR"))
    {
        return root;
    }
    // Local and device runs keep the layout the desktop app, the session store
    // and the device config already share, so defer to the resolver that owns
    // that layout rather than answering the same question a second way.
    if crate::agents::backend_url::is_local_mode() {
        return crate::agents::runtime_capabilities::workspace_root();
    }
    if let Some(executor_home) = env_path("WEGENT_EXECUTOR_HOME") {
        return executor_home.join("workspace").join("projects");
    }
    env_path("WECODE_HOME")
        .or_else(|| dirs::home_dir().map(|home| home.join(".wecode")))
        .map(|wecode_home| {
            wecode_home
                .join("wegent-executor")
                .join("workspace")
                .join("projects")
        })
        .unwrap_or_else(|| PathBuf::from(LOGICAL_WORKSPACE_ROOT))
}

/// Workspace directory of one task.
pub(crate) fn task_workspace_dir(task_id: &str) -> PathBuf {
    workspace_root().join(task_id)
}

/// Translate a logical workspace path from an API caller into a real path.
///
/// `/workspace` maps to the workspace root and `/workspace/<rest>` to
/// `<root>/<rest>`. Any other value is returned unchanged, so callers that
/// already send real paths keep working.
pub(crate) fn resolve_logical_path(raw_path: &str) -> PathBuf {
    let path = raw_path.trim();
    let root = workspace_root();
    if path == LOGICAL_WORKSPACE_ROOT {
        return root;
    }
    match path.strip_prefix(LOGICAL_WORKSPACE_ROOT) {
        Some(rest) if rest.starts_with('/') => root.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    }
}

/// Render a real path in the logical form API callers expect.
///
/// Returns `None` when the path is outside the workspace root, which keeps
/// callers free to fall back to the real path for unrelated locations.
pub(crate) fn display_workspace_path(path: &Path) -> Option<String> {
    let root = fs::canonicalize(workspace_root()).ok()?;
    let relative = path.strip_prefix(root).ok()?;
    let suffix = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if suffix.is_empty() {
        Some(LOGICAL_WORKSPACE_ROOT.to_owned())
    } else {
        Some(format!("{LOGICAL_WORKSPACE_ROOT}/{suffix}"))
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    let value = env::var_os(key)?;
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn remove(key: &'static str) -> Self {
            let previous = env::var(key).ok();
            env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                env::set_var(self.key, previous);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    struct WorkspaceEnv {
        _lock: std::sync::MutexGuard<'static, ()>,
        _guards: Vec<EnvGuard>,
    }

    fn clear_workspace_env() -> WorkspaceEnv {
        let lock = crate::test_env::lock();
        let guards = [
            "WORKSPACE_ROOT",
            "WEGENT_WORKSPACE_ROOT",
            "WEGENT_EXECUTOR_PROJECTS_DIR",
            "WEGENT_EXECUTOR_HOME",
            "WECODE_HOME",
            "LOCAL_WORKSPACE_ROOT",
            "EXECUTOR_MODE",
        ]
        .into_iter()
        .map(EnvGuard::remove)
        .collect();
        WorkspaceEnv {
            _lock: lock,
            _guards: guards,
        }
    }

    #[test]
    fn workspace_root_keeps_the_local_device_layout() {
        let _env = clear_workspace_env();
        env::set_var("EXECUTOR_MODE", "local");
        env::set_var("WEGENT_EXECUTOR_HOME", "/home/wegent/.wegent-executor");

        assert_eq!(
            workspace_root(),
            PathBuf::from("/home/wegent/.wegent-executor/workspace")
        );
        assert_eq!(
            task_workspace_dir("42"),
            PathBuf::from("/home/wegent/.wegent-executor/workspace/42")
        );
    }

    #[test]
    fn workspace_root_honours_local_workspace_root_override() {
        let _env = clear_workspace_env();
        env::set_var("EXECUTOR_MODE", "local");
        env::set_var("LOCAL_WORKSPACE_ROOT", "/srv/local-workspace");

        assert_eq!(workspace_root(), PathBuf::from("/srv/local-workspace"));
    }

    #[test]
    fn mounted_container_root_wins_over_local_mode() {
        let _env = clear_workspace_env();
        env::set_var("EXECUTOR_MODE", "local");
        env::set_var("WORKSPACE_ROOT", "/workspace");

        assert_eq!(workspace_root(), PathBuf::from("/workspace"));
    }

    #[test]
    fn workspace_root_prefers_the_mounted_container_root() {
        let _env = clear_workspace_env();
        env::set_var("WECODE_HOME", "/home/wegent/.wecode");
        env::set_var("WORKSPACE_ROOT", "/workspace");

        assert_eq!(workspace_root(), PathBuf::from("/workspace"));
    }

    #[test]
    fn workspace_root_falls_back_to_the_wecode_home_layout() {
        let _env = clear_workspace_env();
        env::set_var("WECODE_HOME", "/home/wegent/.wecode");

        assert_eq!(
            workspace_root(),
            PathBuf::from("/home/wegent/.wecode/wegent-executor/workspace/projects")
        );
        assert_eq!(
            task_workspace_dir("42"),
            PathBuf::from("/home/wegent/.wecode/wegent-executor/workspace/projects/42")
        );
    }

    #[test]
    fn blank_workspace_root_falls_through_to_the_next_candidate() {
        let _env = clear_workspace_env();
        env::set_var("WORKSPACE_ROOT", "");
        env::set_var("WEGENT_EXECUTOR_PROJECTS_DIR", "/srv/projects");

        assert_eq!(workspace_root(), PathBuf::from("/srv/projects"));
    }

    #[test]
    fn resolve_logical_path_maps_the_workspace_prefix_onto_the_root() {
        let _env = clear_workspace_env();
        env::set_var("WORKSPACE_ROOT", "/srv/projects");

        assert_eq!(
            resolve_logical_path("/workspace"),
            PathBuf::from("/srv/projects")
        );
        assert_eq!(
            resolve_logical_path("/workspace/42/lottery"),
            PathBuf::from("/srv/projects/42/lottery")
        );
        assert_eq!(
            resolve_logical_path("/workspace42"),
            PathBuf::from("/workspace42")
        );
        assert_eq!(
            resolve_logical_path("/srv/other"),
            PathBuf::from("/srv/other")
        );
    }

    #[test]
    fn display_workspace_path_round_trips_real_paths() {
        let _env = clear_workspace_env();
        let directory =
            env::temp_dir().join(format!("wegent-workspace-paths-{}", std::process::id()));
        fs::create_dir_all(directory.join("42/lottery")).unwrap();
        // Canonicalize so the round trip also holds where the temp directory is
        // reached through a symlink.
        let root = fs::canonicalize(&directory).unwrap();
        env::set_var("WORKSPACE_ROOT", &root);

        assert_eq!(display_workspace_path(&root), Some("/workspace".to_owned()));
        assert_eq!(
            display_workspace_path(&root.join("42/lottery")),
            Some("/workspace/42/lottery".to_owned())
        );
        let _ = fs::remove_dir_all(&directory);
    }
}

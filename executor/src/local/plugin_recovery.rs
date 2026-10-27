// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::path::{Path, PathBuf};

use super::capabilities::{
    default_manifest_path, CapabilitySyncError, GlobalCapabilityStore, PluginRuntimeRecoveryReport,
};

/// Use one set of managed homes for startup recovery and backend synchronization.
pub fn default_plugin_store() -> GlobalCapabilityStore {
    let codex_home = crate::agents::wework_codex_home();
    let claude_home = std::env::var_os("WEGENT_CLAUDE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            codex_home
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("claude")
        });
    let store = plugin_store(default_manifest_path(), &codex_home, &claude_home);
    if std::env::var("WEGENT_PLUGIN_RUNTIME_TARGET").as_deref() == Ok("codex") {
        store.with_codex_only_plugins()
    } else {
        store
    }
}

fn plugin_store(
    manifest_path: PathBuf,
    codex_home: &Path,
    claude_home: &Path,
) -> GlobalCapabilityStore {
    GlobalCapabilityStore::new(manifest_path, claude_home.join("skills"))
        .with_plugins_dir(claude_home.join("plugins"))
        .with_codex_skills_dir(codex_home.join("skills"))
        .with_codex_plugins_dir(codex_home.join("plugins"))
        .with_shared_packages()
}

pub fn recover_default_plugin_runtimes() -> Result<PluginRuntimeRecoveryReport, CapabilitySyncError>
{
    default_plugin_store().reconcile_managed_plugin_runtimes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn startup_recovery_does_not_restore_plugins_from_retained_ownership() {
        let temp = tempfile::tempdir().unwrap();
        let capabilities = temp.path().join("capabilities");
        fs::create_dir_all(&capabilities).unwrap();
        let manifest_path = capabilities.join("manifest-v2.json");
        let retained = temp
            .path()
            .join("old-home/codex/plugins/cache/market/mail/1");
        let manifest = json!({
            "version": 2, "skills": {}, "plugins": {}, "mcps": {},
            "plugin_runtime_owners": {(retained.display().to_string()): "mail@market"}
        });
        fs::write(&manifest_path, manifest.to_string()).unwrap();
        let codex_home = temp.path().join("new-home/codex");
        let claude_home = temp.path().join("new-home/claude");
        let store = plugin_store(manifest_path, &codex_home, &claude_home)
            .with_workbench_root(temp.path().join("workbench"));

        let report = store.reconcile_managed_plugin_runtimes().unwrap();

        assert!(report.restored.is_empty());
        assert!(report.failed.is_empty());
        assert!(store.manifest.load().unwrap()["plugins"]
            .as_object()
            .unwrap()
            .is_empty());
        assert!(!codex_home.join("plugins/cache/market/mail").exists());
        assert!(!claude_home.join("plugins/cache/market/mail").exists());
        assert!(!retained.exists());
    }
}

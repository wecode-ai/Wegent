// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_deferred_hook_is_rebound_without_accumulating_obsolete_snapshot_paths() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        install_deferred_mcp_hook(&first);
        let mut settings: Value =
            serde_json::from_slice(&fs::read(first.join("settings.json")).unwrap()).unwrap();
        settings["hooks"]["PreToolUse"].as_array_mut().unwrap().push(json!({"matcher": "Bash", "hooks": [{"type": "command", "command": "custom-hook"}]}));
        write_json_file(&second.join("settings.json"), &settings).unwrap();
        install_deferred_mcp_hook(&second);
        let next: Value =
            serde_json::from_slice(&fs::read(second.join("settings.json")).unwrap()).unwrap();
        let hooks = next["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(hooks.len(), 2);
        assert!(hooks
            .iter()
            .any(|hook| hook["hooks"][0]["command"] == "custom-hook"));
        let managed = hooks
            .iter()
            .find(|hook| hook["matcher"] == "mcp__.*interactive_form_question.*")
            .unwrap();
        assert_eq!(
            managed["hooks"][0]["command"],
            second
                .join("defer-interactive-mcp-hook.sh")
                .display()
                .to_string()
        );
        assert!(!next.to_string().contains(first.to_str().unwrap()));
        assert!(fs::read_to_string(first.join("settings.json"))
            .unwrap()
            .contains(first.to_str().unwrap()));
    }
}

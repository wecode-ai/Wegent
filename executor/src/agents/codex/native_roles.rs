// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use sha2::{Digest, Sha256};

pub(super) fn coordinate_team(request: &ExecutionRequest) -> bool {
    wegent_execution_contracts::is_coordinate_team(request)
        && request.bot.as_array().is_some_and(|bots| bots.len() > 1)
        && !codex_collaboration_mode(request)
            .is_some_and(|mode| mode.eq_ignore_ascii_case("single"))
}

pub(super) fn coordinate_role_overrides(
    request: &ExecutionRequest,
    home: &Path,
) -> Result<Vec<String>, String> {
    crate::agents::runtime_capabilities::validate_coordinate_grant_source(request)?;
    let mut overrides = Vec::new();
    if !coordinate_team(request) {
        return Ok(overrides);
    }
    let dir = home.join("wegent-team-roles");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dir = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    for (name, role) in crate::agents::runtime_capabilities::coordinate_roles(request, "Codex")? {
        let mut layer = toml_edit::DocumentMut::new();
        if !role.prompt.trim().is_empty() {
            layer["developer_instructions"] = toml_edit::value(role.prompt);
        }
        if let Some(model) = role.model {
            layer["model"] = toml_edit::value(model);
        }
        let content = layer.to_string();
        let path = dir.join(format!("{:x}.toml", Sha256::digest(content.as_bytes())));
        if std::fs::read(&path).ok().as_deref() != Some(content.as_bytes()) {
            wegent_filesystem::atomic_file::write_atomic_file(&path, content.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        for (key, value) in [
            ("description", role.description.as_str()),
            (
                "config_file",
                path.to_str().ok_or("invalid Codex role path")?,
            ),
        ] {
            overrides.push(format!(
                "{}={}",
                toml_key_path(&["agents", &name, key]),
                toml_value(value)
            ));
        }
    }
    Ok(overrides)
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, io::ErrorKind, path::Path};
use toml_edit::DocumentMut;

/// Inspect configuration and file metadata only. Never open credential files.
pub fn check(home: &Path) -> Result<(), String> {
    if !home.is_absolute() {
        return Err("Codex migration requires an absolute Home".to_owned());
    }
    let content = match fs::read_to_string(home.join("config.toml")) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(_) => return Err("Cannot read Codex configuration for migration".to_owned()),
    };
    let config = content
        .parse::<DocumentMut>()
        .map_err(|_| "Invalid Codex configuration; migration is blocked".to_owned())?;
    check_config(&config)?;
    for name in [
        "local.age",
        "codex_auth.age",
        "mcp_oauth.age",
        "gateway_oauth.age",
    ] {
        match fs::symlink_metadata(home.join("secrets").join(name)) {
            Ok(_) => return Err("Codex encrypted storage is Home-bound; migrate its keyring identity before moving Home".to_owned()),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect Codex encrypted storage metadata".to_owned()),
        }
    }
    Ok(())
}

fn check_config(config: &DocumentMut) -> Result<(), String> {
    if let Some(value) = config.get("cli_auth_credentials_store") {
        if !matches!(value.as_str(), Some("file" | "ephemeral")) {
            return Err("Codex login keyring storage is Home-bound; verify login storage before moving Home".to_owned());
        }
    }
    let oauth_mode = match config.get("mcp_oauth_credentials_store") {
        None => "auto",
        Some(value) => match value.as_str() {
            Some(mode @ ("file" | "auto" | "keyring")) => mode,
            _ => return Err("Invalid Codex MCP credential storage mode".to_owned()),
        },
    };
    let secret_storage = match config
        .get("features")
        .and_then(|v| v.get("secret_auth_storage"))
    {
        None => cfg!(windows),
        Some(value) => value
            .as_bool()
            .ok_or("Invalid Codex encrypted storage setting")?,
    };
    if secret_storage && oauth_mode != "file" {
        return Err("Codex encrypted OAuth storage is Home-bound; verify its keyring identity before moving Home".to_owned());
    }
    // Codex 0.153.3 Direct MCP OAuth keys use server name/URL, not Home.
    // Enterprise identity keys are the exception, even in file storage mode.
    let has_enterprise_identity = config
        .get("mcp_servers")
        .and_then(|item| item.as_table_like())
        .is_some_and(|servers| servers.iter().any(|(name, _)| name.starts_with("ema-idp:")));
    if has_enterprise_identity {
        return Err("Codex enterprise OAuth identity is Home-bound; migrate that identity before moving Home".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_default_and_explicit_file_storage() {
        for config in ["cli_auth_credentials_store = 'file'", "cli_auth_credentials_store = 'ephemeral'", "mcp_oauth_credentials_store = 'file'\n[mcp_servers.test]\nurl = 'https://example.invalid/mcp'"] {
            let config = format!("{config}\n[features]\nsecret_auth_storage = false");
            assert!(check_config(&config.parse().unwrap()).is_ok());
        }
    }

    #[test]
    fn http_mcp_does_not_require_file_storage() {
        for mode in [
            "",
            "mcp_oauth_credentials_store = 'auto'",
            "mcp_oauth_credentials_store = 'keyring'",
        ] {
            let config = format!("{mode}\n[features]\nsecret_auth_storage = false\n[mcp_servers.test]\nurl = 'https://example.invalid/mcp'");
            assert!(check_config(&config.parse().unwrap()).is_ok());
        }
        assert_eq!(check_config(&"".parse().unwrap()).is_ok(), !cfg!(windows));
    }

    #[test]
    fn rejects_path_dependent_unknown_or_invalid_storage_without_exposing_values() {
        for config in [
            "cli_auth_credentials_store = 'keyring'",
            "cli_auth_credentials_store = 'auto'",
            "cli_auth_credentials_store = 42",
            "cli_auth_credentials_store = 'synthetic-sensitive-value'",
            "mcp_oauth_credentials_store = 'synthetic-sensitive-value'",
            "[features]\nsecret_auth_storage = true",
            "[features]\nsecret_auth_storage = 'synthetic-sensitive-value'",
            "mcp_oauth_credentials_store = 'file'\n[mcp_servers.'ema-idp:example']\nurl = 'https://example.invalid/mcp'",
        ] {
            let error = check_config(&config.parse().unwrap()).unwrap_err();
            assert!(!error.contains("synthetic-sensitive-value"));
        }
    }

    #[test]
    fn reads_only_configuration_and_leaves_home_untouched() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("codex");
        assert_eq!(check(&home).is_ok(), !cfg!(windows));
        assert!(!home.exists());
        fs::create_dir(&home).unwrap();
        fs::create_dir(home.join("auth.json")).unwrap();
        fs::write(
            home.join("config.toml"),
            "cli_auth_credentials_store = 'file'\n[features]\nsecret_auth_storage = false",
        )
        .unwrap();
        assert!(check(&home).is_ok());
        fs::write(home.join("config.toml"), "broken = [ secret").unwrap();
        let error = check(&home).unwrap_err();
        assert!(!error.contains("secret"));
    }

    #[test]
    fn encrypted_files_are_not_opened_or_ignored_when_storage_mode_changes() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("config.toml"),
            "mcp_oauth_credentials_store = 'file'",
        )
        .unwrap();
        fs::create_dir(root.path().join("secrets")).unwrap();
        for name in [
            "local.age",
            "codex_auth.age",
            "mcp_oauth.age",
            "gateway_oauth.age",
        ] {
            let file = root.path().join("secrets").join(name);
            fs::create_dir(&file).unwrap();
            assert!(check(root.path()).unwrap_err().contains("Home-bound"));
            fs::remove_dir(file).unwrap();
        }
    }
}

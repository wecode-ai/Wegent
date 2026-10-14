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
    // An uninitialized Home has no stored credentials or Home-bound identity.
    // Do not apply Windows credential defaults before any data exists.
    match fs::read_dir(home) {
        Ok(mut entries) => match entries.next() {
            None => return Ok(()),
            Some(Ok(_)) => {}
            Some(Err(_)) => return Err("Cannot inspect Codex Home metadata".to_owned()),
        },
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Cannot inspect Codex Home metadata".to_owned()),
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
    if let Some(value) = config.get("mcp_oauth_credentials_store") {
        if !matches!(value.as_str(), Some("file" | "auto" | "keyring")) {
            return Err("Invalid Codex MCP credential storage mode".to_owned());
        }
    }
    if let Some(value) = config
        .get("features")
        .and_then(|v| v.get("secret_auth_storage"))
    {
        if value.as_bool().is_none() {
            return Err("Invalid Codex encrypted storage setting".to_owned());
        }
    }
    // Storage settings select future writes; they do not establish that encrypted
    // credentials exist. check() rejects every existing encrypted namespace by
    // metadata, even when the current configuration selects file storage.
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
        assert!(check_config(&"".parse().unwrap()).is_ok());
    }

    #[test]
    fn rejects_path_dependent_unknown_or_invalid_storage_without_exposing_values() {
        for config in [
            "cli_auth_credentials_store = 'keyring'",
            "cli_auth_credentials_store = 'auto'",
            "cli_auth_credentials_store = 42",
            "cli_auth_credentials_store = 'synthetic-sensitive-value'",
            "mcp_oauth_credentials_store = 'synthetic-sensitive-value'",
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
        assert!(check(&home).is_ok());
        assert!(!home.exists());
        fs::create_dir(&home).unwrap();
        assert!(check(&home).is_ok());
        assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
        fs::create_dir(home.join("auth.json")).unwrap();
        assert!(check(&home).is_ok());
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
    fn accepts_populated_home_without_encrypted_credential_files() {
        let root = tempfile::tempdir().unwrap();
        // A directory in place of authentication proves the check never opens it.
        fs::create_dir(root.path().join("auth.json")).unwrap();
        fs::create_dir(root.path().join("sessions")).unwrap();
        for config in [
            "",
            "cli_auth_credentials_store = 'file'",
            "[features]\nsecret_auth_storage = true",
            "mcp_oauth_credentials_store = 'auto'\n[features]\nsecret_auth_storage = true",
            "mcp_oauth_credentials_store = 'keyring'\n[features]\nsecret_auth_storage = true",
        ] {
            fs::write(root.path().join("config.toml"), config).unwrap();
            assert!(check(root.path()).is_ok());
            assert_eq!(
                fs::read_to_string(root.path().join("config.toml")).unwrap(),
                config
            );
            assert!(root.path().join("auth.json").is_dir());
            assert!(!root.path().join("secrets").exists());
        }
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

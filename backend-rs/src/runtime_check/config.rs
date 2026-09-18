// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application configuration loaded from the source-compatible `/app/.env`
//! and process environment, mirroring the subset of
//! `Wegent/backend/app/core/config.py` used by the task runtime-check API.
//!
//! Only the variables this endpoint's dependency construction needs are
//! modeled. Values come from the environment or the mounted `.env` file at
//! the source's original absolute path.
use std::{collections::HashMap, path::Path};

use anyhow::{Context as _, Result};

#[derive(Debug, Clone)]
pub struct Config {
    /// Redis URL like `redis://:pass@host:port/0`.
    pub redis_url: String,
    /// Active JWT signing key (source `SECRET_KEY`).
    pub jwt_key: String,
    /// JWT algorithm (source `ALGORITHM`, HS256 in deployment).
    pub jwt_algorithm: String,
    /// Comma-separated legacy decode-only JWT keys.
    pub jwt_legacy_keys: String,
}

impl Config {
    /// Load configuration from the process environment, falling back to the
    /// source-compatible `.env` mount at `/app/.env`.
    pub fn load() -> Result<Self> {
        let file_values = read_env_file(Path::new("/app/.env"));
        let lookup = |name: &str| -> Option<String> {
            std::env::var(name)
                .ok()
                .or_else(|| file_values.get(name).cloned())
        };
        Ok(Self {
            redis_url: lookup("REDIS_URL").context("REDIS_URL is required")?,
            jwt_key: lookup("SECRET_KEY").context("SECRET_KEY is required")?,
            jwt_algorithm: lookup("ALGORITHM").unwrap_or_else(|| "HS256".to_string()),
            jwt_legacy_keys: lookup("JWT_LEGACY_SECRET_KEYS").unwrap_or_default(),
        })
    }

    /// Decode-only JWT keys: the active key followed by unique legacy keys,
    /// mirroring `app/core/jwt_compat.py:get_jwt_decode_secret_keys`.
    pub fn jwt_decode_keys(&self) -> Vec<String> {
        let mut keys = vec![self.jwt_key.clone()];
        for key in self.jwt_legacy_keys.split(',') {
            let key = key.trim();
            if !key.is_empty() && !keys.iter().any(|existing| existing == key) {
                keys.push(key.to_string());
            }
        }
        keys
    }

    /// Parse the deployment Redis URL into the `host:port:db` form and the
    /// password expected by `brz-redis` endpoint configuration.
    pub fn redis_endpoint(&self) -> Result<(String, Option<String>)> {
        let (credentials, host_port_db) = parse_redis_url(&self.redis_url)?;
        Ok((host_port_db, credentials))
    }
}

/// Minimal dotenv reader: `KEY=VALUE` lines, comments and blanks ignored.
fn read_env_file(path: &Path) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let Ok(content) = std::fs::read_to_string(path) else {
        return values;
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        values.insert(name.trim().to_string(), value.trim().to_string());
    }
    values
}

/// Convert `redis://[:pass@]host:port/db` to `(pass, "host:port:db")`.
fn parse_redis_url(url: &str) -> Result<(Option<String>, String)> {
    let rest = url
        .strip_prefix("redis://")
        .or_else(|| url.strip_prefix("unix://"))
        .context("unsupported Redis URL scheme in REDIS_URL")?;
    let (authority, db) = match rest.split_once('/') {
        Some((authority, path)) => {
            let db = path.split('?').next().unwrap_or("").trim();
            (
                authority,
                if db.is_empty() {
                    "0".to_string()
                } else {
                    db.to_string()
                },
            )
        }
        None => (rest, "0".to_string()),
    };
    let (host_port, password) = match authority.rsplit_once('@') {
        Some((userinfo, host_port)) => {
            let password = userinfo
                .strip_prefix(':')
                .or_else(|| userinfo.strip_prefix("default:"))
                .unwrap_or(userinfo);
            (
                host_port,
                (!password.is_empty()).then(|| password.to_string()),
            )
        }
        None => (authority, None),
    };
    Ok((password, format!("{host_port}:{db}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_redis_url_with_password_and_db() {
        let (password, endpoint) =
            parse_redis_url("redis://:secret@redis-cache.example.test:48958/0").unwrap();
        assert_eq!(password.as_deref(), Some("secret"));
        assert_eq!(endpoint, "redis-cache.example.test:48958:0");
    }

    #[test]
    fn parses_redis_url_without_credentials() {
        let (password, endpoint) = parse_redis_url("redis://127.0.0.1:6379/1").unwrap();
        assert_eq!(password, None);
        assert_eq!(endpoint, "127.0.0.1:6379:1");
    }

    #[test]
    fn legacy_keys_are_unique_and_trimmed() {
        let config = Config {
            redis_url: String::new(),
            jwt_key: "active".to_string(),
            jwt_algorithm: "HS256".to_string(),
            jwt_legacy_keys: " active, legacy ,active".to_string(),
        };
        assert_eq!(
            config.jwt_decode_keys(),
            vec!["active".to_string(), "legacy".to_string()]
        );
    }

    #[test]
    fn env_file_reader_parses_key_values() {
        let dir = std::env::temp_dir().join("wegent-be-rs-env-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".env");
        std::fs::write(&file, "# comment\nKEY=value\n\nOTHER=other\n").unwrap();
        let values = read_env_file(&file);
        assert_eq!(values.get("KEY").map(String::as_str), Some("value"));
        assert_eq!(values.get("OTHER").map(String::as_str), Some("other"));
    }
}

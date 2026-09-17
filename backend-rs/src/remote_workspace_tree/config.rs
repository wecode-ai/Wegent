// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application configuration resolved with the source precedence: process
//! environment first, then the source image's `/app/.env` values (the
//! coordinator mounts the source `.env` read-only at its original path).
//!
//! Mirrors the source `app/core/config.py` settings consumed by the
//! remote-workspace tree endpoint.
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;

/// Errors while resolving configuration.
#[derive(Debug)]
pub(crate) enum ConfigError {
    Missing(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(name) => write!(formatter, "{name} is required but not configured"),
        }
    }
}

impl std::error::Error for ConfigError {}

/// Application settings for the remote-workspace tree endpoint.
#[derive(Debug, Clone)]
pub(crate) struct Config {
    pub(crate) redis_url: String,
    pub(crate) executor_manager_url: String,
    /// Active JWT decode key first, then legacy decode-only keys
    /// (`JWT_LEGACY_SECRET_KEYS`, comma-separated).
    pub(crate) jwt_decode_keys: Vec<String>,
    pub(crate) jwt_algorithm: String,
}

const ENV_FILE: &str = "/app/.env";
const DEFAULT_ALGORITHM: &str = "HS256";
const DEFAULT_EXECUTOR_MANAGER_URL: &str = "http://localhost:8001";
const DEFAULT_REDIS_URL: &str = "redis://127.0.0.1:6379/0";

impl Config {
    /// Resolve configuration from the environment and the source `.env`.
    pub(crate) fn load() -> Result<Self, ConfigError> {
        let env_file = dotenv_map(ENV_FILE);
        let lookup = |name: &str| -> Option<String> {
            env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| env_file.get(name).cloned())
        };

        let redis_url = lookup("REDIS_URL").unwrap_or_else(|| DEFAULT_REDIS_URL.to_owned());
        let executor_manager_url = lookup("EXECUTOR_MANAGER_URL")
            .unwrap_or_else(|| DEFAULT_EXECUTOR_MANAGER_URL.to_owned())
            .trim_end_matches('/')
            .to_owned();

        let mut jwt_decode_keys = Vec::new();
        if let Some(active) = lookup("SECRET_KEY") {
            jwt_decode_keys.push(active);
        }
        for legacy in lookup("JWT_LEGACY_SECRET_KEYS")
            .unwrap_or_default()
            .split(',')
        {
            let key = legacy.trim();
            if !key.is_empty() && !jwt_decode_keys.iter().any(|existing| existing == key) {
                jwt_decode_keys.push(key.to_owned());
            }
        }
        if jwt_decode_keys.is_empty() {
            return Err(ConfigError::Missing("SECRET_KEY".to_owned()));
        }

        let jwt_algorithm = lookup("ALGORITHM").unwrap_or_else(|| DEFAULT_ALGORITHM.to_owned());

        Ok(Self {
            redis_url,
            executor_manager_url,
            jwt_decode_keys,
            jwt_algorithm,
        })
    }

    /// Redis endpoint list for `brz-redis`. The SDK's `configured_server`
    /// accepts only `host:port[:db]` (colon-separated), so the URL's `/db`
    /// path is re-encoded as a third colon segment.
    pub(crate) fn redis_endpoints(&self) -> Vec<String> {
        redis_url_to_endpoints(&self.redis_url)
    }
}

/// Parse a minimal `KEY=VALUE` dotenv file without interpolation.
fn dotenv_map(path: &str) -> HashMap<String, String> {
    let Ok(contents) = std::fs::read_to_string(PathBuf::from(path)) else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        // Match python-dotenv's handling of stripped quotes.
        let value = value.trim();
        let value = if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        map.insert(key.to_owned(), value.to_owned());
    }
    map
}

/// Extract `host:port[:db]` endpoints from a `redis://[user:pass@]host:port[/db]` URL.
///
/// The db suffix becomes a third colon-separated segment, the format
/// `brz-redis`'s `configured_server` parser accepts.
pub(crate) fn redis_url_to_endpoints(url: &str) -> Vec<String> {
    let Some(rest) = url
        .strip_prefix("redis://")
        .or_else(|| url.strip_prefix("rediss://"))
    else {
        return vec![url.to_owned()];
    };
    let host_part = match rest.rsplit_once('@') {
        Some((_credentials, host)) => host,
        None => rest,
    };
    let (authority, path) = match host_part.split_once('/') {
        Some((authority, path)) => (authority, path),
        None => (host_part, ""),
    };
    let authority = authority.trim();
    if authority.is_empty() {
        return vec![url.to_owned()];
    }
    if authority.contains(':') {
        if path.is_empty() {
            vec![authority.to_owned()]
        } else {
            vec![format!("{authority}:{path}")]
        }
    } else {
        vec![authority.to_owned()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_url_drops_credentials_and_keeps_db() {
        let endpoints =
            redis_url_to_endpoints("redis://user:pass@redis-cache.example.test:48958/0");
        assert_eq!(
            endpoints,
            vec!["redis-cache.example.test:48958:0".to_owned()]
        );
    }

    #[test]
    fn missing_env_file_is_empty() {
        assert!(dotenv_map("/nonexistent/.env").is_empty());
    }
}

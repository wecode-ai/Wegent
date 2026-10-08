// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/features` — system-level feature flags.
//!
//! Mirrors `app.api.endpoints.users.get_feature_flags`: an authenticated
//! endpoint that reports whether the long-term memory service is available
//! (`MemoryManager.is_enabled`, which reduces to `settings.MEMORY_ENABLED`),
//! rendered through the `FeatureFlags` response model.
use serde::Serialize;

use crate::auth::SessionUser;
use crate::config::env_or_dotenv;

/// GET /api/users/features: the feature-flags free function.
///
/// The source declares `response_model=FeatureFlags`, so FastAPI renders the
/// model as `application/json`; returning the serializable view keeps that
/// content type instead of the raw-bytes `application/octet-stream` default.
#[brz_http_server::get("/api/users/features")]
async fn get_feature_flags(#[auth] _current_user: SessionUser) -> FeatureFlags {
    feature_flags(memory_enabled())
}

/// `FeatureFlags` pydantic model: the single flag the source exposes.
#[derive(Serialize)]
struct FeatureFlags {
    memory_enabled: bool,
}

fn feature_flags(memory_enabled: bool) -> FeatureFlags {
    FeatureFlags { memory_enabled }
}

/// `MemoryManager.is_enabled`, which reduces to `settings.MEMORY_ENABLED`:
/// `MemoryManager` builds its client exactly when the setting is enabled, so
/// `settings.MEMORY_ENABLED and self._client is not None` always equals the
/// setting for a process whose configuration does not change.
fn memory_enabled() -> bool {
    env_or_dotenv("MEMORY_ENABLED")
        .as_deref()
        .is_some_and(parse_bool)
}

/// Pydantic boolean parsing for a settings value string.
fn parse_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "on" | "yes" | "y" | "t"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_only_the_memory_flag() {
        assert_eq!(
            serde_json::to_string(&feature_flags(true)).unwrap(),
            "{\"memory_enabled\":true}"
        );
        assert_eq!(
            serde_json::to_string(&feature_flags(false)).unwrap(),
            "{\"memory_enabled\":false}"
        );
    }

    #[test]
    fn parses_pydantic_boolean_strings() {
        for value in ["True", "true", "1", "on", "yes", "Y", " t "] {
            assert!(parse_bool(value), "{value} should parse as true");
        }
        for value in ["False", "false", "0", "off", "no", "n", "f", ""] {
            assert!(!parse_bool(value), "{value} should parse as false");
        }
    }
}

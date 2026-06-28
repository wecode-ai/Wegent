// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use wegent_executor::{
    config::device::UpdateConfig,
    services::updater::{create_version_checker_kind, VersionCheckerKind},
};

fn env(values: &[(&str, &str)]) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn factory_defaults_to_github_for_empty_config() {
    let config = UpdateConfig::default();

    assert_eq!(
        create_version_checker_kind(&config, &BTreeMap::new()).unwrap(),
        VersionCheckerKind::Github { token: None }
    );
}

#[test]
fn factory_creates_registry_checker_from_config_registry() {
    let config = UpdateConfig {
        registry: "https://example.com/ai-tool-box".to_owned(),
        registry_token: String::new(),
    };

    assert_eq!(
        create_version_checker_kind(&config, &BTreeMap::new()).unwrap(),
        VersionCheckerKind::Registry {
            registry_url: "https://example.com/ai-tool-box".to_owned(),
            auth_token: None
        }
    );
}

#[test]
fn factory_uses_registry_token_from_config() {
    let config = UpdateConfig {
        registry: "https://example.com/ai-tool-box".to_owned(),
        registry_token: "my_registry_token".to_owned(),
    };

    assert_eq!(
        create_version_checker_kind(&config, &BTreeMap::new()).unwrap(),
        VersionCheckerKind::Registry {
            registry_url: "https://example.com/ai-tool-box".to_owned(),
            auth_token: Some("my_registry_token".to_owned())
        }
    );
}

#[test]
fn factory_creates_registry_checker_from_env_registry() {
    let config = UpdateConfig::default();

    assert_eq!(
        create_version_checker_kind(&config, &env(&[("REGISTRY", "https://env.com/registry")]))
            .unwrap(),
        VersionCheckerKind::Registry {
            registry_url: "https://env.com/registry".to_owned(),
            auth_token: None
        }
    );
}

#[test]
fn factory_uses_registry_token_from_env() {
    let config = UpdateConfig {
        registry: "https://example.com/registry".to_owned(),
        registry_token: String::new(),
    };

    assert_eq!(
        create_version_checker_kind(&config, &env(&[("REGISTRY_TOKEN", "env_token")])).unwrap(),
        VersionCheckerKind::Registry {
            registry_url: "https://example.com/registry".to_owned(),
            auth_token: Some("env_token".to_owned())
        }
    );
}

#[test]
fn config_registry_takes_precedence_over_env_registry() {
    let config = UpdateConfig {
        registry: "https://config.com/registry".to_owned(),
        registry_token: String::new(),
    };

    assert_eq!(
        create_version_checker_kind(&config, &env(&[("REGISTRY", "https://env.com/registry")]))
            .unwrap(),
        VersionCheckerKind::Registry {
            registry_url: "https://config.com/registry".to_owned(),
            auth_token: None
        }
    );
}

#[test]
fn empty_token_becomes_none() {
    let config = UpdateConfig {
        registry: "https://example.com/registry".to_owned(),
        registry_token: "   ".to_owned(),
    };

    assert_eq!(
        create_version_checker_kind(&config, &env(&[("REGISTRY_TOKEN", "   ")])).unwrap(),
        VersionCheckerKind::Registry {
            registry_url: "https://example.com/registry".to_owned(),
            auth_token: None
        }
    );
}

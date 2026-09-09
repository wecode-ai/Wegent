//! Declared non-secret source configuration, never inherited interpreter settings.

use super::AuthError;
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum Setting {
    Directory {},
    Enum { values: Vec<String> },
}

fn public_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

pub(super) fn validate(settings: Option<&BTreeMap<String, Setting>>) -> Result<(), AuthError> {
    let Some(settings) = settings else {
        return Ok(());
    };
    let invalid = settings.is_empty()
        || settings.len() > 16
        || settings.iter().any(|(name, setting)| {
            let valid_name = !name.is_empty()
                && name.len() <= 64
                && name.as_bytes()[0].is_ascii_uppercase()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
            !valid_name
                || match setting {
                    Setting::Directory {} => false,
                    Setting::Enum { values } => {
                        values.is_empty()
                            || values.len() > 16
                            || values.iter().any(|value| !public_value(value))
                            || values
                                .iter()
                                .collect::<std::collections::BTreeSet<_>>()
                                .len()
                                != values.len()
                    }
                }
        });
    if invalid {
        return Err(AuthError("plugin_auth_invalid_adapter"));
    }
    Ok(())
}

pub(super) fn capture(
    settings: Option<&BTreeMap<String, Setting>>,
    operation: Option<&str>,
) -> Result<Option<String>, AuthError> {
    if !matches!(operation, Some("export" | "detach" | "authorize")) {
        return Ok(None);
    }
    let Some(settings) = settings else {
        return Ok(None);
    };
    let mut selected = BTreeMap::new();
    for (name, setting) in settings {
        let value = match std::env::var(name) {
            Ok(value) if !value.is_empty() => value,
            Ok(_) | Err(std::env::VarError::NotPresent) => continue,
            Err(_) => return Err(AuthError("plugin_auth_invalid_local_configuration")),
        };
        if !accepts(setting, &value) {
            return Err(AuthError("plugin_auth_invalid_local_configuration"));
        }
        selected.insert(name, value);
    }
    let encoded = serde_json::to_string(&selected)
        .map_err(|_| AuthError("plugin_auth_invalid_local_configuration"))?;
    if encoded.len() > 16_384 {
        return Err(AuthError("plugin_auth_invalid_local_configuration"));
    }
    Ok(Some(encoded))
}

fn accepts(setting: &Setting, value: &str) -> bool {
    match setting {
        Setting::Directory {} => {
            value.len() <= 4096 && Path::new(value).is_absolute() && Path::new(value).is_dir()
        }
        Setting::Enum { values } => values.iter().any(|allowed| value == allowed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_source_configuration_without_interpreter_inheritance() {
        let settings: BTreeMap<String, Setting> = serde_json::from_value(json!({
            "DWS_CONFIG_DIR": {"type":"directory"},
            "DWS_DISABLE_KEYCHAIN": {"type":"enum", "values":["1"]}
        }))
        .unwrap();
        validate(Some(&settings)).unwrap();
        let directory = tempfile::tempdir().unwrap();
        assert!(accepts(
            &Setting::Directory {},
            directory.path().to_str().unwrap()
        ));
        assert!(!accepts(&Setting::Directory {}, "relative/config"));
        assert!(!accepts(&Setting::Directory {}, "synthetic-secret"));
        assert!(!accepts(
            &settings["DWS_DISABLE_KEYCHAIN"],
            "synthetic-secret"
        ));
        for operation in ["run", "refresh", "revoke"] {
            assert!(capture(Some(&settings), Some(operation)).unwrap().is_none());
        }
    }

    #[test]
    fn rejects_ambiguous_or_unbounded_declarations() {
        for value in [
            json!({}),
            json!({"mixedCase":{"type":"directory"}}),
            json!({"MODE":{"type":"enum", "values":["1","1"]}}),
            json!({"MODE":{"type":"enum", "values":["arbitrary value"]}}),
            json!({"MODE":{"type":"enum", "values":[]}}),
        ] {
            let settings: BTreeMap<String, Setting> = serde_json::from_value(value).unwrap();
            assert!(validate(Some(&settings)).is_err());
        }
        assert!(serde_json::from_value::<Setting>(json!({"type":"string"})).is_err());
        assert!(
            serde_json::from_value::<Setting>(json!({"type":"directory","values":["1"]})).is_err()
        );
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! A logical provider identity must not change Codex-owned authentication.
//! These definitions match the bundled Codex provider factories; credentials
//! remain in their original Home, environment or native credential command.

use super::*;

pub(super) fn process_overrides() -> Vec<String> {
    let mut selected = defaults("openai");
    let base_url = codex_router_base_url();
    // Keep Codex's native account manager: command auth would replace it.
    // Only unscoped model discovery uses this local, non-secret credential.
    // Every inference thread replaces the complete table before it can run.
    selected.insert("base_url".into(), json!(base_url));
    selected.insert(
        "model_catalog_url".into(),
        json!(format!("{base_url}/models")),
    );
    selected.insert(
        "experimental_bearer_token".into(),
        json!(local_model_proxy::API_KEY),
    );
    let mut overrides = serialize(selected);
    // This process profile can discover only Wework's loopback catalog, not
    // an external API-key endpoint. Native thread profiles retain user policy.
    overrides.push("features.api_key_model_discovery=true".into());
    overrides
}

#[cfg(test)]
fn overrides(home: &Path, provider: &str) -> Result<Vec<String>, String> {
    with_headers(home, provider, Vec::new(), None)
}

pub(super) fn with_headers(
    home: &Path,
    provider: &str,
    headers: Vec<(String, String)>,
    cwd: Option<&str>,
) -> Result<Vec<String>, String> {
    let config = read_config(home)?;
    if !is_builtin_codex_provider(provider) && !config["model_providers"][provider].is_object() {
        return Err(format!(
            "Selected Codex provider is not configured in its native Home: {provider}"
        ));
    }
    let mut selected = defaults(provider);
    if let Some(configured) = config["model_providers"][provider].as_object() {
        // Match native built-in merging. Aliasing must not activate fields that
        // native OpenAI/OSS ignores or change a cloud provider's auth identity.
        for (key, value) in configured {
            let allowed = match provider {
                "openai" => key == "model_catalog_url",
                "ollama" | "lmstudio" => false,
                "amazon-bedrock" | "amazon-bedrock-runtime" => {
                    matches!(key.as_str(), "base_url" | "auth" | "aws" | "http_headers")
                }
                "gcp" => matches!(
                    key.as_str(),
                    "base_url"
                        | "auth"
                        | "http_headers"
                        | "project_id"
                        | "location"
                        | "credential_file"
                ),
                _ => true,
            };
            if allowed {
                if key == "http_headers" {
                    let mut merged = selected
                        .get(key)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(headers) = value.as_object() {
                        merged.extend(headers.clone());
                    }
                    selected.insert(key.clone(), Value::Object(merged));
                } else {
                    selected.insert(key.clone(), value.clone());
                }
            }
        }
    }
    if provider == "openai" {
        if let Some(base_url) = config["openai_base_url"].as_str() {
            selected.insert("base_url".into(), json!(base_url));
        }
    }
    if provider == "gcp" && !selected.contains_key("auth") {
        // Native defaults are applied to the `gcp` entry, not arbitrary aliases.
        // Preserve that command and its request-owned working directory.
        let cwd = cwd
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(env::current_dir)
            .map_err(|error| format!("Resolve native GCP auth directory: {error}"))?;
        selected.insert(
            "auth".into(),
            json!({
                "command":if cfg!(windows) {"gcloud.cmd"} else {"gcloud"},
                "args":["auth","application-default","print-access-token"],
                "timeout_ms":30_000,"refresh_interval_ms":3_000_000,"cwd":cwd
            }),
        );
    }
    selected
        .entry("name".to_owned())
        .or_insert_with(|| json!(provider));
    if !headers.is_empty() {
        let mut merged = parse_header_map(selected.get("http_headers"));
        for (key, value) in headers {
            insert_header(&mut merged, &key, &value);
        }
        selected.insert(
            "http_headers".into(),
            json!(merged.into_iter().collect::<BTreeMap<_, _>>()),
        );
    }
    let mut overrides = serialize(selected);
    if let Some(enabled) = config["features"]["api_key_model_discovery"].as_bool() {
        overrides.push(format!("features.api_key_model_discovery={enabled}"));
    }
    Ok(overrides)
}

pub(super) fn api_overrides(base_url: String, command: &str, args: Vec<String>) -> Vec<String> {
    let mut selected = defaults("wework-api");
    selected.insert("name".into(), json!("Wework model router"));
    selected.insert("base_url".into(), json!(base_url));
    selected.insert("auth".into(), json!({"command":command,"args":args}));
    serialize(selected)
}

fn serialize(selected: Map<String, Value>) -> Vec<String> {
    let router = codex_model_catalog::PROVIDER_ID;
    // One provider-table override replaces the process CLI provider atomically.
    // Overlapping parent/dotted overrides are unordered in native RPC HashMaps.
    vec![
        format!("model_provider={router}"),
        format!(
            "model_providers.{router}={}",
            toml_json_value(&Value::Object(selected))
        ),
    ]
}

fn read_config(home: &Path) -> Result<Value, String> {
    let path = home.join("config.toml");
    let content = crate::local::codex_home::read_optional_config(&path)?;
    toml_edit::de::from_str(&content)
        .map_err(|error| format!("Read native Codex provider configuration: {error}"))
}

fn defaults(provider: &str) -> Map<String, Value> {
    let mut values = json!({
        "wire_api":"responses", "requires_openai_auth":false,
        "supports_websockets":false, "supports_standalone_web_search":false,
        "include_internal_metadata":false,
        "capabilities":{"cyber_access_programs":false}
    })
    .as_object()
    .unwrap()
    .clone();
    match provider {
        "openai" => values.extend(json!({
            "name":"OpenAI", "requires_openai_auth":true,
            "supports_websockets":true, "supports_standalone_web_search":true,
            "include_internal_metadata":true,
            "capabilities":{"cyber_access_programs":true},
            "env_http_headers":{"OpenAI-Organization":"OPENAI_ORGANIZATION", "OpenAI-Project":"OPENAI_PROJECT"}
        }).as_object().unwrap().clone()),
        "amazon-bedrock" | "amazon-bedrock-runtime" => {
            values.insert("name".into(), json!(if provider == "amazon-bedrock" {"Amazon Bedrock"} else {"Amazon Bedrock Runtime"}));
            values.insert("aws".into(), json!({}));
            values.insert("http_headers".into(), json!({"x-amzn-mantle-client-agent":"codex"}));
        }
        "gcp" => { values.insert("name".into(), json!("Google Cloud Vertex AI")); }
        "ollama" | "lmstudio" => {
            let default_port = if provider == "ollama" { 11434 } else { 1234 };
            let port = env::var("CODEX_OSS_PORT").ok()
                .filter(|s| !s.trim().is_empty()).and_then(|s|s.parse::<u16>().ok()).unwrap_or(default_port);
            let base_url = env::var("CODEX_OSS_BASE_URL").ok().filter(|s|!s.trim().is_empty())
                .unwrap_or_else(||format!("http://localhost:{port}/v1"));
            values.insert("name".into(), json!("gpt-oss"));
            values.insert("base_url".into(), json!(base_url));
        }
        _ => {}
    }
    values
}

#[cfg(test)]
pub(super) fn profile_for_test(overrides: &[String]) -> Value {
    overrides
        .iter()
        .filter_map(|value| config_override_entry(value))
        .find(|(key, _)| key == &format!("model_providers.{}", codex_model_catalog::PROVIDER_ID))
        .expect("complete router profile")
        .1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_profile_keeps_native_auth_and_entitlement_without_a_router_bearer() {
        let home = tempfile::tempdir().unwrap();
        let overrides = overrides(home.path(), "openai").unwrap();
        let config = profile_for_test(&overrides);
        assert_eq!(config["name"], "OpenAI");
        assert_eq!(config["requires_openai_auth"], true);
        assert_eq!(config["capabilities"]["cyber_access_programs"], true);
        assert!(config.get("auth").is_none());
        assert!(config.get("base_url").is_none());
    }

    #[test]
    fn public_catalog_is_local_without_replacing_the_native_account_manager() {
        let _lock = crate::test_env::lock();
        let selected = profile_for_test(&process_overrides());
        assert_eq!(selected["name"], "OpenAI");
        assert_eq!(selected["requires_openai_auth"], true);
        assert!(selected.get("auth").is_none());
        assert_eq!(
            selected["experimental_bearer_token"],
            local_model_proxy::API_KEY
        );
        assert_eq!(
            selected["model_catalog_url"],
            format!("{}/models", codex_router_base_url())
        );
        let home = tempfile::tempdir().unwrap();
        let thread = profile_for_test(&overrides(home.path(), "openai").unwrap());
        assert!(thread.get("experimental_bearer_token").is_none());
        assert!(thread.get("model_catalog_url").is_none());
        assert!(thread.get("base_url").is_none());
    }

    #[test]
    fn native_threads_keep_api_key_discovery_opt_out_while_the_local_catalog_stays_enabled() {
        let _lock = crate::test_env::lock();
        let home = tempfile::tempdir().unwrap();
        fs::write(
            home.path().join("config.toml"),
            "[features]\napi_key_model_discovery=false\n",
        )
        .unwrap();
        let native = overrides(home.path(), "openai").unwrap();
        assert!(native.contains(&"features.api_key_model_discovery=false".into()));
        assert!(process_overrides().contains(&"features.api_key_model_discovery=true".into()));
        let profile = profile_for_test(&native);
        assert!(profile.get("experimental_bearer_token").is_none());
        assert!(profile.get("model_catalog_url").is_none());
    }

    #[test]
    fn alias_does_not_activate_ignored_builtin_auth_or_endpoint_overrides() {
        let _lock = crate::test_env::lock();
        let home = tempfile::tempdir().unwrap();
        fs::write(
            home.path().join("config.toml"),
            r#"
[model_providers.openai]
name="Injected gateway"
base_url="https://synthetic.invalid"
requires_openai_auth=false
auth={command="must-not-run"}
[model_providers.ollama]
base_url="https://synthetic.invalid"
auth={command="must-not-run"}
"#,
        )
        .unwrap();
        let openai = profile_for_test(&overrides(home.path(), "openai").unwrap());
        assert_eq!(openai["name"], "OpenAI");
        assert_eq!(openai["requires_openai_auth"], true);
        assert!(openai.get("base_url").is_none());
        assert!(openai.get("auth").is_none());
        let oss = profile_for_test(&overrides(home.path(), "ollama").unwrap());
        assert!(!oss["base_url"]
            .as_str()
            .unwrap()
            .contains("synthetic.invalid"));
        assert!(oss.get("auth").is_none());
    }

    #[test]
    fn command_auth_stays_native_and_does_not_read_a_different_home() {
        let home = tempfile::tempdir().unwrap();
        fs::write(
            home.path().join("config.toml"),
            r#"
[model_providers.custom]
name="Custom gateway"
base_url="https://synthetic.example/v1"
auth={command="native-credential-helper",args=["--scope","test"]}
"#,
        )
        .unwrap();
        let selected = overrides(home.path(), "custom").unwrap();
        let config = profile_for_test(&selected);
        assert_eq!(config["auth"]["command"], "native-credential-helper");
        assert_eq!(config["requires_openai_auth"], false);
        let other = tempfile::tempdir().unwrap();
        assert!(overrides(other.path(), "custom")
            .unwrap_err()
            .contains("not configured in its native Home"));
    }

    #[test]
    fn cloud_provider_profiles_keep_native_factory_identity_and_auth_kind() {
        let home = tempfile::tempdir().unwrap();
        for (id, name) in [
            ("amazon-bedrock", "Amazon Bedrock"),
            ("amazon-bedrock-runtime", "Amazon Bedrock Runtime"),
            ("gcp", "Google Cloud Vertex AI"),
        ] {
            let selected = overrides(home.path(), id).unwrap();
            let config = profile_for_test(&selected);
            assert_eq!(config["name"], name);
            assert_eq!(config["requires_openai_auth"], false);
            if id == "gcp" {
                assert_eq!(
                    config["auth"]["args"],
                    json!(["auth", "application-default", "print-access-token"])
                );
            } else {
                assert!(config.get("auth").is_none());
            }
            assert_eq!(config.get("aws").is_some(), id.starts_with("amazon-"));
        }
    }
}

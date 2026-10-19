// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/mcp-providers/{provider_key}/servers` — sync one provider's MCP
//! server catalog for the current user.
//!
//! Mirrors `app.api.endpoints.mcp_providers.get_provider_servers` together
//! with `app.services.mcp_providers.service.MCPProviderService.sync_servers`,
//! `app.services.mcp_providers.core.registry.MCPProviderRegistry`, and
//! `app.services.installed_mcp_service.InstalledMCPService.merge_catalog_state`.
//! The endpoint authenticates the session, resolves the provider through the
//! registry, gates a token provider on the stored (encrypted) API key, runs
//! the provider's fetch, and merges the user's installed-MCP state into each
//! catalog server before rendering `MCPServerListResponse`.
//!
//! The registry and the install-state merge are public; a deployment
//! registers its concrete providers through deployment-owned implementations
//! before route construction, exactly like the skill-market registry split.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use brz_http_server::StatusCode;
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde::Serialize;
use serde_json::Value;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `MCPServer`: one provider catalog server, serialized with the API field
/// names (`installState`, `installedMcpId` keep the source's camelCase).
#[derive(Debug, Clone, Serialize)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub server_type: String,
    pub base_url: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub headers: Option<HashMap<String, String>>,
    pub is_active: bool,
    pub provider: String,
    pub provider_url: Option<String>,
    pub logo_url: Option<String>,
    pub tags: Option<Vec<String>>,
    #[serde(rename = "installState")]
    pub install_state: String,
    #[serde(rename = "installedMcpId")]
    pub installed_mcp_id: Option<i64>,
    pub enabled: bool,
}

/// `MCPProviderConfig` reduced to the fields the sync path consumes.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// Stable provider key (`MCPProviderConfig.key`).
    pub key: String,
    /// `token_field`: the `MCPProviderKeys` member holding the API key.
    pub token_field: String,
    /// `requires_token`: whether the provider needs a user-configured key.
    pub requires_token: bool,
}

/// `MCPProviderPlugin.fetch_servers`: fetch and map the provider's catalog.
/// Returns the servers and the source's error identifier on failure; the
/// error strings are the registry's stable codes (`"unauthorized"`,
/// `"server_error"`, `"timeout"`, `"connect_error"`, `"proxy_error"`, or a
/// provider-specific prefix like `"error:"`/`"http_error:"`).
#[async_trait]
pub trait McpProviderPlugin: Send + Sync {
    /// The provider configuration registered under its key.
    fn config(&self) -> &ProviderConfig;
    /// Fetch the provider's servers for `user_name`, using `token` when the
    /// configuration requires one.
    async fn fetch_servers(&self, token: &str, user_name: &str) -> Result<Vec<McpServer>, String>;
}

/// `MCPProviderRegistry`: providers keyed by their stable key.
#[derive(Default)]
pub struct McpProviderRegistry {
    plugins: RwLock<Vec<Arc<dyn McpProviderPlugin>>>,
}

impl McpProviderRegistry {
    /// Register a provider plugin, replacing an existing entry with the same
    /// key (the source's `register_plugin` override semantics).
    pub fn register(&self, plugin: Arc<dyn McpProviderPlugin>) {
        let mut plugins = self
            .plugins
            .write()
            .expect("mcp provider registry lock poisoned");
        if let Some(existing) = plugins
            .iter_mut()
            .find(|candidate| candidate.config().key == plugin.config().key)
        {
            *existing = plugin;
        } else {
            plugins.push(plugin);
        }
    }

    /// `MCPProviderRegistry.get(key)`'s configuration.
    fn config(&self, key: &str) -> Option<ProviderConfig> {
        self.plugins
            .read()
            .expect("mcp provider registry lock poisoned")
            .iter()
            .find(|plugin| plugin.config().key == key)
            .map(|plugin| plugin.config().clone())
    }

    /// `MCPProviderRegistry.get_plugin(key)`.
    fn plugin(&self, key: &str) -> Option<Arc<dyn McpProviderPlugin>> {
        self.plugins
            .read()
            .expect("mcp provider registry lock poisoned")
            .iter()
            .find(|plugin| plugin.config().key == key)
            .cloned()
    }

    /// Registered keys in registration order (tests only).
    #[cfg(test)]
    fn keys(&self) -> Vec<String> {
        self.plugins
            .read()
            .expect("mcp provider registry lock poisoned")
            .iter()
            .map(|plugin| plugin.config().key.clone())
            .collect()
    }
}

/// `MCPServerListResponse`.
#[derive(Debug, Serialize)]
struct ServerListResponse {
    success: bool,
    message: String,
    servers: Vec<McpServer>,
    error_details: Option<String>,
}

/// One active installed-MCP `kinds` row (`_load_provider_installed_state`).
#[derive(Debug, FromMysqlRow)]
struct InstalledMcpRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_json")]
    json: Json<OpaqueJson>,
}

/// `_load_provider_installed_state`'s query, rendered with the labeled column
/// list and newline separators SQLAlchemy emits.
fn installed_mcp_statement(user_id: i64) -> String {
    format!(
        "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, \
         kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
         kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
         kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.user_id = {user_id} AND \
         kinds.kind = 'InstalledMCP' AND kinds.namespace = 'default' AND kinds.is_active = true"
    )
}

/// `_load_provider_installed_state`: the caller's active installed-MCP rows
/// reduced to `(provider_key, server_key) -> (row id, spec)`.
async fn load_installed_state<M>(
    mysql: &M,
    user_id: i64,
) -> MysqlResult<HashMap<(String, String), (i64, Value)>>
where
    M: Mysql,
{
    let rows: Vec<InstalledMcpRow> = mysql
        .fetch_all(installed_mcp_statement(user_id), ())
        .await?;
    let mut state = HashMap::with_capacity(rows.len());
    for row in rows {
        let payload = row.json.0.to_value();
        let Some(spec) = payload.get("spec").filter(|spec: &&Value| spec.is_object()) else {
            continue;
        };
        // `source.get("type") != "provider"` rows are not provider installs.
        let Some(source) = spec
            .get("source")
            .filter(|source: &&Value| source.is_object())
        else {
            continue;
        };
        if source.get("type").and_then(Value::as_str) != Some("provider") {
            continue;
        }
        let (Some(provider_key), Some(server_key)) = (
            source.get("providerKey").and_then(Value::as_str),
            source.get("serverKey").and_then(Value::as_str),
        ) else {
            continue;
        };
        state.insert(
            (provider_key.to_owned(), server_key.to_owned()),
            (row.id, spec.clone()),
        );
    }
    Ok(state)
}

/// `_server_key_from_id`: the id after the provider prefix.
fn server_key_from_id(server_id: &str) -> &str {
    server_id.split_once('/').map_or(server_id, |(_, key)| key)
}

/// `merge_catalog_state`: each catalog server's install state from the
/// installed rows, defaulting to `not_installed`/`None`/`false`.
fn merge_install_state(
    provider_key: &str,
    servers: Vec<McpServer>,
    installed: &HashMap<(String, String), (i64, Value)>,
) -> Vec<McpServer> {
    servers
        .into_iter()
        .map(|mut server| {
            let key = (
                provider_key.to_owned(),
                server_key_from_id(&server.id).to_owned(),
            );
            if let Some((installed_id, spec)) = installed.get(&key) {
                server.install_state = spec
                    .get("installState")
                    .and_then(Value::as_str)
                    .unwrap_or("installed")
                    .to_owned();
                server.installed_mcp_id = Some(*installed_id);
                server.enabled = spec
                    .get("enabled")
                    .is_some_and(brz_json::adapters::python_truthy);
            }
            server
        })
        .collect()
}

/// `sync_servers`: resolve the provider, gate the token, fetch, and merge the
/// install state. Every failure maps to the source's message/details pair.
async fn sync_servers(
    state: &AppState,
    provider_key: &str,
    preferences: &Value,
    user: &SessionUser,
) -> ServerListResponse {
    let Some(config) = state.mcp_providers.config(provider_key) else {
        return failure(format!("Unknown provider: {provider_key}"), None);
    };
    let token = match resolve_token(&config, preferences) {
        Ok(token) => token,
        Err((message, details)) => return failure(message, details),
    };
    let Some(plugin) = state.mcp_providers.plugin(provider_key) else {
        return failure(format!("Unknown provider: {provider_key}"), None);
    };
    let servers = match plugin.fetch_servers(&token, &user.user_name).await {
        Ok(servers) => servers,
        Err(error) => {
            return failure(
                mapped_error_message(&error).into(),
                mapped_error_details(&error),
            );
        }
    };
    let installed = load_installed_state(&state.mysql, i64::from(user.id))
        .await
        .unwrap_or_default();
    let servers = merge_install_state(provider_key, servers, &installed);
    let count = servers.len();
    ServerListResponse {
        success: true,
        message: format!("Successfully synced {count} servers"),
        servers,
        error_details: None,
    }
}

/// `sync_servers`' token gate: token providers require a stored, decryptable
/// key; non-token providers run with an empty token.
fn resolve_token(
    config: &ProviderConfig,
    preferences: &Value,
) -> Result<String, (String, Option<String>)> {
    if !config.requires_token {
        return Ok(String::new());
    }
    let raw = preferences
        .get("mcp_provider_keys")
        .and_then(|keys| keys.get(&config.token_field))
        .and_then(Value::as_str)
        .unwrap_or("");
    if raw.is_empty() {
        return Err(("API key not configured".to_owned(), None));
    }
    match crate::mcp_providers::security::decrypt_provider_key(raw) {
        Ok(token) => Ok(token),
        Err(_) => Err((
            "API key format is invalid. Please save the API key again.".to_owned(),
            Some("invalid_api_key_format".to_owned()),
        )),
    }
}

/// `sync_servers`' error-code ladder: the registry's stable codes map to the
/// source's user-facing messages.
fn mapped_error_message(error: &str) -> Box<str> {
    match error {
        "unauthorized" => "Authentication failed. Please check your API key.",
        "server_error" => "Provider server error. Please try again later.",
        "proxy_error" => "Proxy error while connecting to provider. Please check HTTP(S)_PROXY.",
        "timeout" => "Provider request timed out. Please try again later.",
        "connect_error" => {
            "Network error while connecting to provider. Please check network/proxy settings."
        }
        other => return format!("Failed to sync servers: {other}").into(),
    }
    .into()
}

/// The `error_details` for the registry's stable error codes; every other
/// provider error keeps its raw identifier.
fn mapped_error_details(error: &str) -> Option<String> {
    matches!(
        error,
        "unauthorized" | "server_error" | "proxy_error" | "timeout" | "connect_error"
    )
    .then(|| error.to_owned())
}

/// One failed sync response.
fn failure(message: String, error_details: Option<String>) -> ServerListResponse {
    ServerListResponse {
        success: false,
        message,
        servers: Vec::new(),
        error_details,
    }
}

/// `_parse_user_preferences`: the stored preferences JSON object, or an empty
/// object for absent/invalid data.
fn parse_user_preferences(preferences: &str) -> Value {
    if preferences.is_empty() {
        return Value::Object(serde_json::Map::new());
    }
    serde_json::from_str(preferences).unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
}

/// POST /api/mcp-providers/{provider_key}/servers: the endpoint free
/// function. The source declares `response_model=MCPServerListResponse`, so
/// the body answers `application/json` even for a failed sync.
#[brz_http_server::post("/api/mcp-providers/:provider_key/servers")]
async fn get_provider_servers(
    #[inject(state)] state: &AppState,
    provider_key: &str,
    #[auth] user: SessionUser,
) -> Result<ServerListResponse, FastApiError> {
    let preferences = parse_user_preferences(&user.preferences);
    Ok(sync_servers(state, provider_key, &preferences, &user).await)
}

/// The registry error the endpoint never renders directly; the 404 detail is
/// unused because the source answers a failed sync with a 200 body.
#[allow(dead_code)]
fn unknown_provider(provider_key: &str) -> FastApiError {
    FastApiError::detail(
        StatusCode::NOT_FOUND,
        format!("Unknown provider: {provider_key}"),
    )
}

/// `shared.utils.crypto` provider-key decryption, shared with the stored-key
/// gate. A non-encrypted value raises `mcp_provider_key_not_encrypted`, and a
/// decrypt failure raises `mcp_provider_key_decrypt_failed`; both surface as
/// the endpoint's `invalid_api_key_format` details.
pub(crate) mod security {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    /// `decrypt_mcp_provider_key`: `""` passes through; any other value must
    /// be a decryptable encrypted payload.
    pub(crate) fn decrypt_provider_key(value: &str) -> Result<String, ()> {
        if value.is_empty() {
            return Ok(value.to_owned());
        }
        let Some(key) = encryption_key() else {
            return Err(());
        };
        if !is_data_encrypted(value) {
            return Err(());
        }
        let decrypted = decrypt_sensitive_data(&key.key, &key.iv, value);
        if decrypted.is_empty() || decrypted == value {
            return Err(());
        }
        Ok(decrypted)
    }

    /// `shared.utils.crypto`'s `GIT_TOKEN_AES_KEY` default.
    const DEFAULT_AES_KEY: &str = "12345678901234567890123456789012";
    /// AES block size, also the PKCS#7 block size.
    const BLOCK_SIZE: usize = 16;

    /// The AES key/IV material `_get_encryption_key()` resolves.
    struct EncryptionKey {
        key: Vec<u8>,
        iv: Vec<u8>,
    }

    /// `_get_encryption_key()`: `GIT_TOKEN_AES_KEY` defaults and
    /// `GIT_TOKEN_AES_IV` is required and exactly one AES block.
    fn encryption_key() -> Option<EncryptionKey> {
        let key = crate::config::env_or_dotenv("GIT_TOKEN_AES_KEY")
            .unwrap_or_else(|| DEFAULT_AES_KEY.to_owned())
            .into_bytes();
        let iv = crate::config::env_or_dotenv("GIT_TOKEN_AES_IV")?.into_bytes();
        (iv.len() == BLOCK_SIZE).then_some(EncryptionKey { key, iv })
    }

    /// `is_data_encrypted`: a non-empty Base64 payload whose decoded length
    /// is a whole number of AES blocks.
    fn is_data_encrypted(data: &str) -> bool {
        if data.is_empty() {
            return false;
        }
        STANDARD
            .decode(data.as_bytes())
            .map(|decoded| !decoded.is_empty() && decoded.len() % BLOCK_SIZE == 0)
            .unwrap_or(false)
    }

    /// `decrypt_sensitive_data`: AES-CBC with PKCS#7 padding; any failure
    /// returns the original text.
    fn decrypt_sensitive_data(key: &[u8], iv: &[u8], text: &str) -> String {
        let Some(encrypted) = STANDARD.decode(text.as_bytes()).ok() else {
            return text.to_owned();
        };
        decrypt_cbc(key, iv, &encrypted)
            .and_then(|plain| String::from_utf8(plain).ok())
            .unwrap_or_else(|| text.to_owned())
    }

    /// AES-128/192/256-CBC decryption with PKCS#7 unpadding.
    fn decrypt_cbc(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
        match key.len() {
            16 => cbc_decrypt::<aes::Aes128>(key, iv, data),
            24 => cbc_decrypt::<aes::Aes192>(key, iv, data),
            32 => cbc_decrypt::<aes::Aes256>(key, iv, data),
            _ => None,
        }
    }

    fn cbc_decrypt<C>(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>>
    where
        C: aes::cipher::KeyInit + aes::cipher::BlockDecrypt,
    {
        if data.is_empty() || !data.len().is_multiple_of(BLOCK_SIZE) || data.len() < BLOCK_SIZE {
            return None;
        }
        let decryptor = C::new_from_slice(key).ok()?;
        let mut previous: Vec<u8> = iv.to_vec();
        let mut plain = Vec::with_capacity(data.len());
        for block in data.chunks(BLOCK_SIZE) {
            let mut decrypted = block.to_vec();
            decryptor.decrypt_block(aes::cipher::generic_array::GenericArray::from_mut_slice(
                &mut decrypted,
            ));
            for index in 0..BLOCK_SIZE {
                plain.push(decrypted[index] ^ previous[index]);
            }
            previous = block.to_vec();
        }
        let padding = *plain.last()? as usize;
        if padding == 0 || padding > BLOCK_SIZE || plain.len() < padding {
            return None;
        }
        plain.truncate(plain.len() - padding);
        Some(plain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal provider plugin for registry tests.
    struct ProbePlugin {
        config: ProviderConfig,
    }

    #[async_trait]
    impl McpProviderPlugin for ProbePlugin {
        fn config(&self) -> &ProviderConfig {
            &self.config
        }

        async fn fetch_servers(
            &self,
            _token: &str,
            _user_name: &str,
        ) -> Result<Vec<McpServer>, String> {
            Ok(Vec::new())
        }
    }

    #[test]
    fn registering_the_same_key_replaces_in_place() {
        let registry = McpProviderRegistry::default();
        registry.register(Arc::new(ProbePlugin {
            config: ProviderConfig {
                key: "probe".to_owned(),
                token_field: "probe".to_owned(),
                requires_token: true,
            },
        }));
        registry.register(Arc::new(ProbePlugin {
            config: ProviderConfig {
                key: "probe".to_owned(),
                token_field: "other".to_owned(),
                requires_token: false,
            },
        }));
        assert_eq!(registry.keys(), ["probe".to_owned()]);
        assert!(!registry.config("probe").unwrap().requires_token);
    }

    #[test]
    fn unknown_provider_answers_the_source_message() {
        let registry = McpProviderRegistry::default();
        assert!(registry.config("missing").is_none());
    }

    #[test]
    fn server_key_strips_the_provider_prefix() {
        assert_eq!(
            server_key_from_id("@example/exampleMcpServer"),
            "exampleMcpServer"
        );
        assert_eq!(server_key_from_id("bare"), "bare");
    }

    #[test]
    fn merge_defaults_to_not_installed() {
        let server = McpServer {
            id: "@example/exampleMcpServer".to_owned(),
            name: "exampleMcpServer".to_owned(),
            description: None,
            server_type: "streamable-http".to_owned(),
            base_url: None,
            command: None,
            args: None,
            env: None,
            headers: None,
            is_active: true,
            provider: "微博 MCP".to_owned(),
            provider_url: None,
            logo_url: None,
            tags: None,
            install_state: "not_installed".to_owned(),
            installed_mcp_id: None,
            enabled: false,
        };
        let merged = merge_install_state("example", vec![server], &HashMap::new());
        assert_eq!(merged[0].install_state, "not_installed");
        assert_eq!(merged[0].installed_mcp_id, None);
        assert!(!merged[0].enabled);
    }

    #[test]
    fn merge_applies_the_installed_spec() {
        let mut spec = serde_json::Map::new();
        spec.insert("installState".to_owned(), "installed".into());
        spec.insert("enabled".to_owned(), true.into());
        let mut state = HashMap::new();
        state.insert(
            ("example".to_owned(), "exampleMcpServer".to_owned()),
            (42, Value::Object(spec)),
        );
        let server = McpServer {
            id: "@example/exampleMcpServer".to_owned(),
            name: "exampleMcpServer".to_owned(),
            description: None,
            server_type: "streamable-http".to_owned(),
            base_url: None,
            command: None,
            args: None,
            env: None,
            headers: None,
            is_active: true,
            provider: "微博 MCP".to_owned(),
            provider_url: None,
            logo_url: None,
            tags: None,
            install_state: "not_installed".to_owned(),
            installed_mcp_id: None,
            enabled: false,
        };
        let merged = merge_install_state("example", vec![server], &state);
        assert_eq!(merged[0].install_state, "installed");
        assert_eq!(merged[0].installed_mcp_id, Some(42));
        assert!(merged[0].enabled);
    }

    #[test]
    fn installed_mcp_statement_matches_the_recorded_query() {
        let sql = installed_mcp_statement(314);
        assert!(sql.starts_with("SELECT kinds.id AS kinds_id"));
        assert!(sql.contains(
            "\nFROM kinds \nWHERE kinds.user_id = 314 AND kinds.kind = 'InstalledMCP' AND \
             kinds.namespace = 'default' AND kinds.is_active = true"
        ));
    }

    #[test]
    fn token_gate_requires_a_key_for_token_providers() {
        let config = ProviderConfig {
            key: "probe".to_owned(),
            token_field: "probe".to_owned(),
            requires_token: true,
        };
        let empty = Value::Object(serde_json::Map::new());
        let error = resolve_token(&config, &empty).unwrap_err();
        assert_eq!(error.0, "API key not configured");
        assert!(error.1.is_none());
    }

    #[test]
    fn non_token_providers_run_with_an_empty_token() {
        let config = ProviderConfig {
            key: "example".to_owned(),
            token_field: "example_mcp".to_owned(),
            requires_token: false,
        };
        let empty = Value::Object(serde_json::Map::new());
        assert_eq!(resolve_token(&config, &empty).unwrap(), "");
    }

    #[test]
    fn invalid_preferences_fall_back_to_an_empty_object() {
        assert!(parse_user_preferences("").is_object());
        assert!(parse_user_preferences("not json").is_object());
    }

    #[test]
    fn stable_error_codes_map_to_the_source_messages() {
        assert_eq!(
            &*mapped_error_message("unauthorized"),
            "Authentication failed. Please check your API key."
        );
        assert_eq!(mapped_error_details("timeout").as_deref(), Some("timeout"));
        let message = mapped_error_message("error: EXAMPLE_MCP_SYSTEM_TOKEN not configured");
        assert_eq!(
            &*message,
            "Failed to sync servers: error: EXAMPLE_MCP_SYSTEM_TOKEN not configured"
        );
        assert!(mapped_error_details("error: boom").is_none());
    }

    #[test]
    fn the_route_is_registered_in_the_public_group() {
        use brz_http_server::__private::inventory;

        // Bit 5 in the route method mask is POST (see the `METHODS` order in
        // `hybrid::routes`).
        const POST_BIT: u16 = 1 << 5;
        let routes: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .filter(|route| route.path == "/api/mcp-providers/:provider_key/servers")
            .collect();
        assert_eq!(routes.len(), 1, "the servers route is registered once");
        assert_eq!(routes[0].methods, POST_BIT, "the route is POST-only");
    }

    #[test]
    fn the_response_serializes_with_the_pydantic_field_order() {
        let response = ServerListResponse {
            success: true,
            message: "Successfully synced 1 servers".to_owned(),
            servers: vec![McpServer {
                id: "@example/probe".to_owned(),
                name: "probe".to_owned(),
                description: Some("".to_owned()),
                server_type: "streamable-http".to_owned(),
                base_url: Some("https://mcp.example.invalid/server/probe".to_owned()),
                command: Some(String::new()),
                args: Some(Vec::new()),
                env: Some(HashMap::new()),
                headers: Some(HashMap::new()),
                is_active: true,
                provider: "微博 MCP".to_owned(),
                provider_url: None,
                logo_url: None,
                tags: None,
                install_state: "not_installed".to_owned(),
                installed_mcp_id: None,
                enabled: false,
            }],
            error_details: None,
        };
        let body = serde_json::to_string(&response).unwrap();
        assert!(body.starts_with(
            "{\"success\":true,\"message\":\"Successfully synced 1 servers\",\"servers\":[\
             {\"id\":\"@example/probe\",\"name\":\"probe\",\"description\":\"\",\
             \"type\":\"streamable-http\","
        ));
        assert!(body.contains(
            "\"installState\":\"not_installed\",\"installedMcpId\":null,\"enabled\":false}"
        ));
        assert!(body.ends_with("],\"error_details\":null}"));
    }
}

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

use crate::embedded_browser;

const AGENT_PLUGIN_SCHEMA: &str = "https://agent-plugins.org/schemas/plugin.json";
const EXECUTOR_SIDECAR_ENV: &str = "WEWORK_EXECUTOR_SIDECAR";
const HARNESS_ADAPTER_VERSION: u8 = 3;
const EMBEDDED_BROWSER_BRIDGE_RUNTIME_FILE_ENV: &str =
    "WEWORK_EMBEDDED_BROWSER_BRIDGE_RUNTIME_FILE";
const WEWORK_LOCAL_ROUTER_API_KEY: &str = "wework-local-router";
const WEWORK_BROWSER_SKILL_NAME: &str = "wework-built-in-browser";
static TEMPORARY_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub struct HarnessPluginAdapter {
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

struct PluginSource {
    name: String,
    root: PathBuf,
    data_root: PathBuf,
}

pub fn prepare_harness_plugin_adapter(
    app: &tauri::AppHandle,
    harness_id: &str,
    session_id: &str,
    cwd: Option<&str>,
    plugin_roots: &[String],
    base_env: &HashMap<String, String>,
    accept_bypass_permissions: bool,
) -> Result<HarnessPluginAdapter, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve Wework app data directory: {error}"))?;
    let sources = resolve_plugin_sources(&app_data, plugin_roots);
    let browser_bridge_runtime_path = embedded_browser::embedded_browser_bridge_runtime_path()?;
    let fingerprint = plugin_fingerprint(harness_id, &sources);
    let adapter_root = app_data
        .join("harness-adapters")
        .join(harness_id)
        .join(fingerprint);
    if !adapter_root.is_dir() {
        materialize_adapter(
            &adapter_root,
            harness_id,
            &sources,
            &browser_bridge_runtime_path,
        )?;
    }

    match harness_id {
        "opencode" => {
            let session_root = app_data.join("harness-sessions").join(session_id);
            let mut env = HashMap::from([
                (
                    "OPENCODE_CONFIG_DIR".to_string(),
                    adapter_root.display().to_string(),
                ),
                (
                    "XDG_DATA_HOME".to_string(),
                    session_root.join("share").display().to_string(),
                ),
                (
                    "XDG_CACHE_HOME".to_string(),
                    session_root.join("cache").display().to_string(),
                ),
                (
                    "XDG_STATE_HOME".to_string(),
                    session_root.join("state").display().to_string(),
                ),
            ]);
            merge_opencode_config_content(&adapter_root, base_env, &mut env)?;
            Ok(HarnessPluginAdapter {
                args: Vec::new(),
                env,
            })
        }
        "claude_code" => {
            let home = app_data
                .join("harness-sessions")
                .join(session_id)
                .join("claude-code");
            prepare_claude_home(&home, cwd, accept_bypass_permissions)?;
            Ok(HarnessPluginAdapter {
                args: vec![
                    "--plugin-dir".to_string(),
                    adapter_root.display().to_string(),
                ],
                env: HashMap::from([("CLAUDE_CONFIG_DIR".to_string(), home.display().to_string())]),
            })
        }
        "kimi_code" => {
            let home = app_data
                .join("harness-sessions")
                .join(session_id)
                .join("kimi-code");
            synchronize_kimi_home(&adapter_root, &home, cwd)?;
            Ok(HarnessPluginAdapter {
                args: Vec::new(),
                env: HashMap::from([("KIMI_CODE_HOME".to_string(), home.display().to_string())]),
            })
        }
        _ => Ok(HarnessPluginAdapter {
            args: Vec::new(),
            env: HashMap::new(),
        }),
    }
}

fn prepare_claude_home(
    home: &Path,
    cwd: Option<&str>,
    accept_bypass_permissions: bool,
) -> Result<(), String> {
    fs::create_dir_all(home)
        .map_err(|error| format!("Failed to create Claude Code home: {error}"))?;
    let config_path = home.join(".claude.json");
    let mut config = fs::read(&config_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    config.insert("hasCompletedOnboarding".to_string(), Value::Bool(true));
    config.insert(
        "customApiKeyResponses".to_string(),
        json!({
            "approved": [WEWORK_LOCAL_ROUTER_API_KEY],
            "rejected": [],
        }),
    );
    if let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        let canonical_cwd = fs::canonicalize(cwd)
            .unwrap_or_else(|_| PathBuf::from(cwd))
            .display()
            .to_string();
        let projects = config
            .entry("projects".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !projects.is_object() {
            *projects = Value::Object(Map::new());
        }
        let project = projects
            .as_object_mut()
            .expect("projects was normalized to an object")
            .entry(canonical_cwd)
            .or_insert_with(|| Value::Object(Map::new()));
        if !project.is_object() {
            *project = Value::Object(Map::new());
        }
        let project = project
            .as_object_mut()
            .expect("project was normalized to an object");
        project.insert("hasTrustDialogAccepted".to_string(), Value::Bool(true));
        project.insert(
            "hasCompletedProjectOnboarding".to_string(),
            Value::Bool(true),
        );
        project
            .entry("projectOnboardingSeenCount".to_string())
            .or_insert_with(|| Value::Number(0.into()));
    }
    fs::write(
        &config_path,
        serde_json::to_vec_pretty(&Value::Object(config))
            .map_err(|error| format!("Failed to encode Claude Code config: {error}"))?,
    )
    .map_err(|error| format!("Failed to write Claude Code config: {error}"))?;

    if accept_bypass_permissions {
        let settings_path = home.join("settings.json");
        let mut settings = fs::read(&settings_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        settings.insert(
            "skipDangerousModePermissionPrompt".to_string(),
            Value::Bool(true),
        );
        fs::write(
            &settings_path,
            serde_json::to_vec_pretty(&Value::Object(settings))
                .map_err(|error| format!("Failed to encode Claude Code settings: {error}"))?,
        )
        .map_err(|error| format!("Failed to write Claude Code settings: {error}"))?;
    }
    Ok(())
}

fn resolve_plugin_sources(app_data: &Path, plugin_roots: &[String]) -> Vec<PluginSource> {
    let mut seen = HashSet::new();
    plugin_roots
        .iter()
        .filter_map(|raw_root| {
            let root = fs::canonicalize(raw_root.trim()).ok()?;
            if !root.is_dir() || !seen.insert(root.clone()) {
                return None;
            }
            let manifest = read_plugin_manifest(&root)?;
            let name = manifest
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(sanitize_component_name)?;
            let data_root = app_data.join("agent-plugin-data").join(&name);
            if fs::create_dir_all(&data_root).is_err() {
                return None;
            }
            Some(PluginSource {
                name,
                root,
                data_root,
            })
        })
        .collect()
}

fn read_plugin_manifest(root: &Path) -> Option<Value> {
    let standard_path = root.join("plugin.json");
    if standard_path.is_file() {
        let manifest: Value = serde_json::from_slice(&fs::read(standard_path).ok()?).ok()?;
        let object = manifest.as_object()?;
        if object.get("$schema").and_then(Value::as_str) != Some(AGENT_PLUGIN_SCHEMA) {
            return None;
        }
        return Some(manifest);
    }

    [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]
        .into_iter()
        .find_map(|relative| {
            let bytes = fs::read(root.join(relative)).ok()?;
            serde_json::from_slice(&bytes).ok()
        })
}

fn sanitize_component_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if sanitized.is_empty() {
        "plugin".to_string()
    } else {
        sanitized
    }
}

fn plugin_fingerprint(harness_id: &str, sources: &[PluginSource]) -> String {
    let mut hasher = DefaultHasher::new();
    HARNESS_ADAPTER_VERSION.hash(&mut hasher);
    harness_id.hash(&mut hasher);
    for source in sources {
        source.root.hash(&mut hasher);
        source.name.hash(&mut hasher);
        for relative in [
            "plugin.json",
            ".codex-plugin/plugin.json",
            ".claude-plugin/plugin.json",
            "mcp.json",
            ".mcp.json",
            "skills",
        ] {
            let path = source.root.join(relative);
            hash_path_metadata(&path, &mut hasher);
        }
    }
    format!("{:016x}", hasher.finish())
}

fn hash_path_metadata(path: &Path, hasher: &mut DefaultHasher) {
    path.hash(hasher);
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    metadata.len().hash(hasher);
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .hash(hasher);
    if !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    paths.sort();
    for child in paths {
        hash_path_metadata(&child, hasher);
    }
}

fn temporary_path(parent: &Path, label: &str, suffix: &str) -> PathBuf {
    parent.join(format!(
        ".{label}.{}-{}.{}",
        std::process::id(),
        TEMPORARY_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        suffix
    ))
}

fn materialize_adapter(
    adapter_root: &Path,
    harness_id: &str,
    sources: &[PluginSource],
    browser_bridge_runtime_path: &Path,
) -> Result<(), String> {
    let parent = adapter_root
        .parent()
        .ok_or_else(|| "Harness plugin adapter path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let staging = temporary_path(
        parent,
        adapter_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("adapter"),
        "staging",
    );
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Failed to create {}: {error}", staging.display()))?;

    let result = (|| {
        let skills_root = staging.join("skills");
        fs::create_dir_all(&skills_root)
            .map_err(|error| format!("Failed to create {}: {error}", skills_root.display()))?;
        let mut used_skill_names = HashSet::new();
        let mut claude_mcp_servers = Map::new();
        let mut opencode_mcp_servers = Map::new();

        write_builtin_browser_skill(&skills_root)?;
        used_skill_names.insert(WEWORK_BROWSER_SKILL_NAME.to_string());
        for source in sources {
            copy_plugin_skills(source, &skills_root, &mut used_skill_names)?;
            for (name, server) in read_plugin_mcp_servers(source) {
                let unique_name = unique_server_name(&source.name, &name, &claude_mcp_servers);
                if let Some(adapted) = adapt_claude_mcp_server(&server, source) {
                    claude_mcp_servers.insert(unique_name.clone(), adapted);
                }
                if let Some(adapted) = adapt_opencode_mcp_server(&server, Some(source)) {
                    opencode_mcp_servers.insert(unique_name, adapted);
                }
            }
        }
        let browser_server = builtin_browser_mcp_server(browser_bridge_runtime_path);
        claude_mcp_servers.insert("wework_browser".to_string(), browser_server.clone());
        opencode_mcp_servers.insert(
            "wework_browser".to_string(),
            adapt_opencode_mcp_server(&browser_server, None)
                .ok_or_else(|| "Failed to adapt Wework browser MCP for OpenCode".to_string())?,
        );

        match harness_id {
            "opencode" => {
                fs::write(
                    staging.join("opencode.json"),
                    serde_json::to_vec_pretty(&json!({
                        "$schema": "https://opencode.ai/config.json",
                        "mcp": opencode_mcp_servers,
                    }))
                    .map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("Failed to write OpenCode adapter config: {error}"))?;
            }
            "claude_code" => {
                let manifest_root = staging.join(".claude-plugin");
                fs::create_dir_all(&manifest_root).map_err(|error| {
                    format!("Failed to create {}: {error}", manifest_root.display())
                })?;
                fs::write(
                    manifest_root.join("plugin.json"),
                    serde_json::to_vec_pretty(&json!({
                        "name": "wework-agent-plugins",
                        "version": "1.0.0",
                        "description": "Wework managed Agent Plugins adapter",
                    }))
                    .map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("Failed to write Claude Code plugin manifest: {error}"))?;
                fs::write(
                    staging.join(".mcp.json"),
                    serde_json::to_vec_pretty(&json!({ "mcpServers": claude_mcp_servers }))
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("Failed to write Claude Code MCP config: {error}"))?;
            }
            "kimi_code" => {
                fs::write(
                    staging.join("mcp.json"),
                    serde_json::to_vec_pretty(&json!({ "mcpServers": claude_mcp_servers }))
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("Failed to write Kimi Code MCP config: {error}"))?;
            }
            _ => {}
        }
        Ok(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    match fs::rename(&staging, adapter_root) {
        Ok(()) => Ok(()),
        Err(_) if adapter_root.is_dir() => {
            let _ = fs::remove_dir_all(&staging);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(format!(
                "Failed to activate Harness plugin adapter {}: {error}",
                adapter_root.display()
            ))
        }
    }
}

fn write_builtin_browser_skill(skills_root: &Path) -> Result<(), String> {
    let skill_root = skills_root.join(WEWORK_BROWSER_SKILL_NAME);
    fs::create_dir_all(&skill_root)
        .map_err(|error| format!("Failed to create {}: {error}", skill_root.display()))?;
    fs::write(
        skill_root.join("SKILL.md"),
        r#"---
name: wework-built-in-browser
description: Operate the Wework built-in browser through the wework_browser MCP tools when a task requires browser navigation or interaction inside Wework.
---

# Wework built-in browser

Use the `wework_browser` MCP server for browser work inside Wework.

1. Navigate with `browser_open`.
2. Inspect structured page state with `browser_inspect` before targeting controls.
3. Use the dedicated click, fill, and key tools for actions.
4. Re-inspect after navigation or when targets become stale.
5. Never claim an action succeeded unless the matching tool call succeeded.
6. Use `browser_take_screenshot` only when the user requests a screenshot.
7. Call only tools advertised by the MCP server. Use `browser_capabilities` to diagnose availability; there is no `browser_probe` tool.
"#,
    )
    .map_err(|error| format!("Failed to write Wework browser skill: {error}"))
}

fn builtin_browser_mcp_server(browser_bridge_runtime_path: &Path) -> Value {
    json!({
        "command": executor_sidecar_command(),
        "args": ["browser-mcp-server"],
        "env": {
            EMBEDDED_BROWSER_BRIDGE_RUNTIME_FILE_ENV:
                browser_bridge_runtime_path.display().to_string(),
        },
    })
}

fn executor_sidecar_command() -> String {
    if let Some(path) = std::env::var_os(EXECUTOR_SIDECAR_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return path.display().to_string();
    }
    if let Ok(current_executable) = std::env::current_exe() {
        let file_name = if cfg!(target_os = "windows") {
            "wegent-executor.exe"
        } else {
            "wegent-executor"
        };
        if let Some(parent) = current_executable.parent() {
            let sibling = parent.join(file_name);
            if sibling.is_file() {
                return sibling.display().to_string();
            }
        }
    }
    "wegent-executor".to_string()
}

fn synchronize_kimi_home(
    adapter_root: &Path,
    home: &Path,
    cwd: Option<&str>,
) -> Result<(), String> {
    fs::create_dir_all(home)
        .map_err(|error| format!("Failed to create {}: {error}", home.display()))?;
    let skills_destination = home.join("skills");
    let staged_skills = temporary_path(home, "skills", "tmp");
    let _ = fs::remove_dir_all(&staged_skills);
    copy_directory_within(
        &adapter_root.join("skills"),
        &staged_skills,
        &adapter_root.join("skills"),
    )?;
    let previous_skills = temporary_path(home, "skills", "old");
    let _ = fs::remove_dir_all(&previous_skills);
    if skills_destination.exists() {
        fs::rename(&skills_destination, &previous_skills).map_err(|error| {
            format!(
                "Failed to replace Kimi Code skills {}: {error}",
                skills_destination.display()
            )
        })?;
    }
    fs::rename(&staged_skills, &skills_destination).map_err(|error| {
        format!(
            "Failed to activate Kimi Code skills {}: {error}",
            skills_destination.display()
        )
    })?;
    let _ = fs::remove_dir_all(previous_skills);

    let mcp_source = adapter_root.join("mcp.json");
    let mcp_destination = home.join("mcp.json");
    let mcp_temporary = temporary_path(home, "mcp-json", "tmp");
    fs::copy(&mcp_source, &mcp_temporary).map_err(|error| {
        format!(
            "Failed to stage Kimi Code MCP config {}: {error}",
            mcp_source.display()
        )
    })?;
    if cfg!(windows) && mcp_destination.exists() {
        fs::remove_file(&mcp_destination).map_err(|error| {
            format!(
                "Failed to replace Kimi Code MCP config {}: {error}",
                mcp_destination.display()
            )
        })?;
    }
    fs::rename(&mcp_temporary, &mcp_destination).map_err(|error| {
        format!(
            "Failed to activate Kimi Code MCP config {}: {error}",
            mcp_destination.display()
        )
    })?;

    if let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        prepare_kimi_workspace_trust(home, cwd)?;
    }
    Ok(())
}

fn prepare_kimi_workspace_trust(home: &Path, cwd: &str) -> Result<(), String> {
    let root = fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
    let root = root.display().to_string();
    let normalized = root.replace('\\', "/").trim_end_matches('/').to_string();
    let directory_name = normalized.rsplit('/').next().unwrap_or(&normalized);
    let slug = kimi_workspace_slug(directory_name);
    let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    let key = format!("wd_{slug}_{}", &digest[..12]);
    let trust_root = home.join("workspace-trust");
    fs::create_dir_all(&trust_root)
        .map_err(|error| format!("Failed to create {}: {error}", trust_root.display()))?;
    let trust_path = trust_root.join(key);
    let temporary = temporary_path(&trust_root, "workspace-trust", "tmp");
    let trusted_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    fs::write(
        &temporary,
        serde_json::to_vec(&json!({
            "root": root,
            "trustedAt": trusted_at,
        }))
        .map_err(|error| format!("Failed to encode Kimi Code workspace trust: {error}"))?,
    )
    .map_err(|error| {
        format!(
            "Failed to stage Kimi Code workspace trust {}: {error}",
            temporary.display()
        )
    })?;
    if cfg!(windows) && trust_path.exists() {
        fs::remove_file(&trust_path).map_err(|error| {
            format!(
                "Failed to replace Kimi Code workspace trust {}: {error}",
                trust_path.display()
            )
        })?;
    }
    fs::rename(&temporary, &trust_path).map_err(|error| {
        format!(
            "Failed to activate Kimi Code workspace trust {}: {error}",
            trust_path.display()
        )
    })
}

fn kimi_workspace_slug(directory_name: &str) -> String {
    let mut slug = String::with_capacity(directory_name.len().min(40));
    let mut previous_was_separator = false;
    for character in directory_name.to_ascii_lowercase().chars() {
        let valid = character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-');
        if valid {
            slug.push(character);
            previous_was_separator = false;
        } else if !previous_was_separator && !slug.is_empty() {
            slug.push('-');
            previous_was_separator = true;
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() || matches!(slug, "." | "..") {
        "workspace".to_string()
    } else {
        slug.to_string()
    }
}

fn copy_plugin_skills(
    source: &PluginSource,
    destination: &Path,
    used_names: &mut HashSet<String>,
) -> Result<(), String> {
    let skills_root = source.root.join("skills");
    let Ok(entries) = fs::read_dir(&skills_root) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let skill_root = entry.path();
        if !skill_root.is_dir() || !skill_root.join("SKILL.md").is_file() {
            continue;
        }
        let base_name = sanitize_component_name(&entry.file_name().to_string_lossy());
        let mut name = base_name.clone();
        if !used_names.insert(name.clone()) {
            name = format!("{}-{}", source.name, base_name);
            if !used_names.insert(name.clone()) {
                continue;
            }
        }
        copy_directory_within(&skill_root, &destination.join(name), &skill_root)?;
    }
    Ok(())
}

fn copy_directory_within(source: &Path, destination: &Path, boundary: &Path) -> Result<(), String> {
    let canonical_boundary = fs::canonicalize(boundary)
        .map_err(|error| format!("Failed to inspect {}: {error}", boundary.display()))?;
    let canonical_source = fs::canonicalize(source)
        .map_err(|error| format!("Failed to inspect {}: {error}", source.display()))?;
    if !canonical_source.starts_with(&canonical_boundary) {
        return Err(format!(
            "Agent Plugin path escapes its component root: {}",
            source.display()
        ));
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Failed to create {}: {error}", destination.display()))?;
    for entry in fs::read_dir(&canonical_source)
        .map_err(|error| format!("Failed to read {}: {error}", canonical_source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", source_path.display()))?;
        if file_type.is_dir() {
            copy_directory_within(&source_path, &destination_path, &canonical_boundary)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "Failed to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn read_plugin_mcp_servers(source: &PluginSource) -> Vec<(String, Value)> {
    ["mcp.json", ".mcp.json"]
        .into_iter()
        .find_map(|relative| {
            let bytes = fs::read(source.root.join(relative)).ok()?;
            let document: Value = serde_json::from_slice(&bytes).ok()?;
            let servers = document.get("mcpServers")?.as_object()?;
            Some(
                servers
                    .iter()
                    .filter_map(|(name, server)| {
                        server
                            .is_object()
                            .then(|| (name.clone(), expand_plugin_values(server, source)))
                    })
                    .collect(),
            )
        })
        .unwrap_or_default()
}

fn expand_plugin_values(value: &Value, source: &PluginSource) -> Value {
    match value {
        Value::String(value) => Value::String(
            value
                .replace("${PLUGIN_ROOT}", &source.root.display().to_string())
                .replace("${CLAUDE_PLUGIN_ROOT}", &source.root.display().to_string())
                .replace("${PLUGIN_DATA}", &source.data_root.display().to_string()),
        ),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| expand_plugin_values(value, source))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), expand_plugin_values(value, source)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn unique_server_name(plugin: &str, name: &str, servers: &Map<String, Value>) -> String {
    if !servers.contains_key(name) {
        return name.to_string();
    }
    format!("{}-{}", plugin, name)
}

fn adapt_claude_mcp_server(server: &Value, source: &PluginSource) -> Option<Value> {
    let mut server = server.as_object()?.clone();
    if server.get("cwd").is_none() && server.get("command").is_some() {
        server.insert(
            "cwd".to_string(),
            Value::String(source.root.display().to_string()),
        );
    }
    if server.get("type").and_then(Value::as_str) == Some("streamable-http") {
        server.insert("type".to_string(), Value::String("http".to_string()));
    }
    Some(Value::Object(server))
}

fn adapt_opencode_mcp_server(server: &Value, source: Option<&PluginSource>) -> Option<Value> {
    let server = server.as_object()?;
    if let Some(command) = server.get("command").and_then(Value::as_str) {
        let mut command_parts = vec![command.to_string()];
        command_parts.extend(
            server
                .get("args")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned),
        );
        let environment = server
            .get("env")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let mut adapted = json!({
            "type": "local",
            "command": command_parts,
            "environment": environment,
            "enabled": true,
        });
        if let Some(cwd) = server
            .get("cwd")
            .cloned()
            .or_else(|| source.map(|source| Value::String(source.root.display().to_string())))
        {
            adapted.as_object_mut()?.insert("cwd".to_string(), cwd);
        }
        return Some(adapted);
    }
    let url = server.get("url")?.as_str()?;
    Some(json!({
        "type": "remote",
        "url": url,
        "headers": server.get("headers").cloned().unwrap_or_else(|| Value::Object(Map::new())),
        "enabled": true,
    }))
}

fn merge_opencode_config_content(
    adapter_root: &Path,
    base_env: &HashMap<String, String>,
    adapter_env: &mut HashMap<String, String>,
) -> Result<(), String> {
    let adapter_config: Value = serde_json::from_slice(
        &fs::read(adapter_root.join("opencode.json"))
            .map_err(|error| format!("Failed to read OpenCode adapter config: {error}"))?,
    )
    .map_err(|error| format!("Failed to parse OpenCode adapter config: {error}"))?;
    let mut merged = base_env
        .get("OPENCODE_CONFIG_CONTENT")
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(mcp) = adapter_config.get("mcp") {
        merged.insert("mcp".to_string(), mcp.clone());
    }
    adapter_env.insert(
        "OPENCODE_CONFIG_CONTENT".to_string(),
        serde_json::to_string(&Value::Object(merged))
            .map_err(|error| format!("Failed to encode OpenCode adapter config: {error}"))?,
    );
    Ok(())
}

#[cfg(test)]
#[path = "agent_plugins_tests.rs"]
mod tests;

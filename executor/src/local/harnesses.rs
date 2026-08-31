// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::{process::Command, time::timeout};

use crate::{path_compat::strip_windows_verbatim_prefix, process_environment};

const HARNESS_VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
struct LocalHarnessDefinition {
    id: &'static str,
    executable: &'static str,
    version_args: &'static [&'static str],
    home_relative_paths: &'static [&'static str],
}

const LOCAL_HARNESSES: [LocalHarnessDefinition; 3] = [
    LocalHarnessDefinition {
        id: "opencode",
        executable: "opencode",
        version_args: &["--version"],
        home_relative_paths: &[".opencode/bin/opencode"],
    },
    LocalHarnessDefinition {
        id: "claude_code",
        executable: "claude",
        version_args: &["--version"],
        home_relative_paths: &[
            ".local/bin/claude",
            ".claude/local/claude",
            ".claude/bin/claude",
        ],
    },
    LocalHarnessDefinition {
        id: "kimi_code",
        executable: "kimi",
        version_args: &["--version"],
        home_relative_paths: &[".local/bin/kimi", ".kimi-code/bin/kimi"],
    },
];

#[derive(Debug, Default, Deserialize)]
pub struct ListLocalHarnessesRequest {
    #[serde(default)]
    pub executable_overrides: HashMap<String, Option<String>>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct LocalHarnessDescriptor {
    pub id: String,
    pub installed: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct PrepareLocalHarnessLaunchRequest {
    pub harness_id: String,
    pub session_id: String,
    pub cwd: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub uses_wework_model: bool,
    #[serde(default)]
    pub accept_bypass_permissions: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PreparedLocalHarnessLaunch {
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

pub async fn list_local_harnesses(
    request: ListLocalHarnessesRequest,
) -> Vec<LocalHarnessDescriptor> {
    let detections = LOCAL_HARNESSES.into_iter().map(|definition| {
        let executable_override = request
            .executable_overrides
            .get(definition.id)
            .and_then(|value| value.as_deref())
            .map(str::to_owned);
        async move { detect_local_harness(definition, executable_override.as_deref()).await }
    });
    futures_util::future::join_all(detections).await
}

pub fn prepare_local_harness_launch(
    request: PrepareLocalHarnessLaunchRequest,
) -> Result<PreparedLocalHarnessLaunch, String> {
    prepare_local_harness_launch_at(request, &executor_home())
}

fn prepare_local_harness_launch_at(
    request: PrepareLocalHarnessLaunchRequest,
    executor_home: &Path,
) -> Result<PreparedLocalHarnessLaunch, String> {
    let session_id = safe_session_component(&request.session_id)?;
    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let session_root = executor_home.join("harness-sessions").join(session_id);
    let args = request.args;
    let mut env = HashMap::new();

    match request.harness_id.as_str() {
        "opencode" if request.uses_wework_model => {
            env.extend([
                (
                    "XDG_DATA_HOME".to_owned(),
                    session_root.join("share").display().to_string(),
                ),
                (
                    "XDG_CACHE_HOME".to_owned(),
                    session_root.join("cache").display().to_string(),
                ),
                (
                    "XDG_STATE_HOME".to_owned(),
                    session_root.join("state").display().to_string(),
                ),
            ]);
        }
        "claude_code" if request.uses_wework_model => {
            let home = session_root.join("claude-code");
            prepare_claude_home(&home, cwd, request.accept_bypass_permissions)?;
            env.insert("CLAUDE_CONFIG_DIR".to_owned(), home.display().to_string());
        }
        "kimi_code" if request.uses_wework_model => {
            let home = session_root.join("kimi-code");
            prepare_kimi_home(&home, cwd)?;
            env.insert("KIMI_CODE_HOME".to_owned(), home.display().to_string());
        }
        "opencode" | "claude_code" | "kimi_code" => {}
        harness_id => return Err(format!("Unsupported local Harness: {harness_id}")),
    }

    Ok(PreparedLocalHarnessLaunch { args, env })
}

fn executor_home() -> PathBuf {
    env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .unwrap_or_else(|| PathBuf::from(".wegent-executor"))
}

fn safe_session_component(session_id: &str) -> Result<&str, String> {
    let session_id = session_id.trim();
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err("Harness session id contains unsafe characters".to_owned());
    }
    Ok(session_id)
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
    config.insert("hasCompletedOnboarding".to_owned(), Value::Bool(true));
    config.insert(
        "customApiKeyResponses".to_owned(),
        json!({
            "approved": ["wework-local-router"],
            "rejected": [],
        }),
    );
    if let Some(cwd) = cwd {
        let canonical_cwd = fs::canonicalize(cwd)
            .unwrap_or_else(|_| PathBuf::from(cwd))
            .display()
            .to_string();
        let projects = config
            .entry("projects".to_owned())
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
        project.insert("hasTrustDialogAccepted".to_owned(), Value::Bool(true));
        project.insert(
            "hasCompletedProjectOnboarding".to_owned(),
            Value::Bool(true),
        );
        project
            .entry("projectOnboardingSeenCount".to_owned())
            .or_insert_with(|| Value::Number(0.into()));
    }
    write_json(&config_path, &Value::Object(config), "Claude Code config")?;

    if accept_bypass_permissions {
        let settings_path = home.join("settings.json");
        let mut settings = fs::read(&settings_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        settings.insert(
            "skipDangerousModePermissionPrompt".to_owned(),
            Value::Bool(true),
        );
        write_json(
            &settings_path,
            &Value::Object(settings),
            "Claude Code settings",
        )?;
    }
    Ok(())
}

fn prepare_kimi_home(home: &Path, cwd: Option<&str>) -> Result<(), String> {
    fs::create_dir_all(home)
        .map_err(|error| format!("Failed to create Kimi Code home: {error}"))?;
    if let Some(cwd) = cwd {
        prepare_kimi_workspace_trust(home, cwd)?;
    }
    Ok(())
}

fn prepare_kimi_workspace_trust(home: &Path, cwd: &str) -> Result<(), String> {
    let root = strip_windows_verbatim_prefix(
        &fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd)),
    );
    let root_text = root.display().to_string();
    let normalized = root_text
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned();
    let directory_name = normalized.rsplit('/').next().unwrap_or(&normalized);
    let slug = kimi_workspace_slug(directory_name);
    let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    let trust_root = home.join("workspace-trust");
    fs::create_dir_all(&trust_root)
        .map_err(|error| format!("Failed to create {}: {error}", trust_root.display()))?;
    let trusted_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    write_json(
        &trust_root.join(format!("wd_{slug}_{}", &digest[..12])),
        &json!({
            "root": root_text,
            "trustedAt": trusted_at,
        }),
        "Kimi Code workspace trust",
    )
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
        "workspace".to_owned()
    } else {
        slug.to_owned()
    }
}

fn write_json(path: &Path, value: &Value, label: &str) -> Result<(), String> {
    fs::write(
        path,
        serde_json::to_vec_pretty(value)
            .map_err(|error| format!("Failed to encode {label}: {error}"))?,
    )
    .map_err(|error| format!("Failed to write {label} {}: {error}", path.display()))
}

async fn detect_local_harness(
    definition: LocalHarnessDefinition,
    executable_override: Option<&str>,
) -> LocalHarnessDescriptor {
    let executable_path = resolve_local_harness_executable(definition, executable_override);
    let version = match executable_path.as_deref() {
        Some(path) => read_command_version(path, definition.version_args).await,
        None => None,
    };
    LocalHarnessDescriptor {
        id: definition.id.to_owned(),
        installed: executable_path.is_some(),
        executable_path: executable_path.map(|path| path.display().to_string()),
        version,
    }
}

fn resolve_local_harness_executable(
    definition: LocalHarnessDefinition,
    executable_override: Option<&str>,
) -> Option<PathBuf> {
    let current_path = env::var("PATH").unwrap_or_default();
    let search_path = process_environment::normalized_process_path(&current_path);
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir);
    let executable = executable_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(definition.executable);
    resolve_executable(
        executable,
        &search_path,
        home.as_deref(),
        if executable_override.is_some() {
            &[]
        } else {
            definition.home_relative_paths
        },
    )
}

fn resolve_executable(
    executable: &str,
    search_path: &str,
    home: Option<&Path>,
    home_relative_paths: &[&str],
) -> Option<PathBuf> {
    let path = Path::new(executable);
    if path.components().count() > 1 {
        return executable_candidates(path.to_path_buf())
            .into_iter()
            .find(|candidate| is_executable_file(candidate));
    }

    env::split_paths(search_path)
        .flat_map(|directory| executable_candidates(directory.join(executable)))
        .chain(home.into_iter().flat_map(|directory| {
            home_relative_paths
                .iter()
                .flat_map(move |path| executable_candidates(directory.join(path)))
        }))
        .find(|candidate| is_executable_file(candidate))
}

fn executable_candidates(path: PathBuf) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        if path.extension().is_some() {
            return vec![path];
        }
        return [".exe", ".cmd", ".bat", ".com"]
            .iter()
            .map(|extension| path.with_extension(&extension[1..]))
            .collect();
    }

    #[cfg(not(windows))]
    {
        vec![path]
    }
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    {
        true
    }
}

async fn read_command_version(path: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let output = timeout(HARNESS_VERSION_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn detects_an_explicit_executable_and_reads_its_version() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("claude");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' '2.1.228 (Claude Code)'\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        let descriptors = list_local_harnesses(ListLocalHarnessesRequest {
            executable_overrides: HashMap::from([(
                "claude_code".to_owned(),
                Some(executable.display().to_string()),
            )]),
        })
        .await;

        assert_eq!(
            descriptors
                .into_iter()
                .find(|descriptor| descriptor.id == "claude_code"),
            Some(LocalHarnessDescriptor {
                id: "claude_code".to_owned(),
                installed: true,
                executable_path: Some(executable.display().to_string()),
                version: Some("2.1.228 (Claude Code)".to_owned()),
            })
        );
    }

    #[tokio::test]
    async fn reports_a_missing_explicit_executable_as_not_installed() {
        let descriptors = list_local_harnesses(ListLocalHarnessesRequest {
            executable_overrides: HashMap::from([(
                "claude_code".to_owned(),
                Some("/definitely/missing/wework-e2e-claude".to_owned()),
            )]),
        })
        .await;

        let claude = descriptors
            .into_iter()
            .find(|descriptor| descriptor.id == "claude_code")
            .unwrap();
        assert!(!claude.installed);
        assert_eq!(claude.executable_path, None);
        assert_eq!(claude.version, None);
    }

    #[test]
    fn prepares_isolated_kimi_home_and_workspace_trust() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("Wegent Demo");
        fs::create_dir_all(&workspace).unwrap();

        let prepared = prepare_local_harness_launch_at(
            PrepareLocalHarnessLaunchRequest {
                harness_id: "kimi_code".to_owned(),
                session_id: "local-harness-1".to_owned(),
                cwd: Some(workspace.display().to_string()),
                uses_wework_model: true,
                ..Default::default()
            },
            &root.path().join("executor-home"),
        )
        .unwrap();

        let kimi_home = PathBuf::from(prepared.env["KIMI_CODE_HOME"].clone());
        let canonical_workspace =
            strip_windows_verbatim_prefix(&fs::canonicalize(&workspace).unwrap());
        let normalized = canonical_workspace.display().to_string().replace('\\', "/");
        let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
        let trust_path = kimi_home
            .join("workspace-trust")
            .join(format!("wd_wegent-demo_{}", &digest[..12]));
        let trust: Value = serde_json::from_slice(&fs::read(trust_path).unwrap()).unwrap();
        assert_eq!(trust["root"], canonical_workspace.display().to_string());
        assert!(trust["trustedAt"].as_u64().is_some());
    }

    #[test]
    fn rejects_unsafe_harness_session_ids() {
        let root = tempfile::tempdir().unwrap();
        let error = prepare_local_harness_launch_at(
            PrepareLocalHarnessLaunchRequest {
                harness_id: "kimi_code".to_owned(),
                session_id: "../escape".to_owned(),
                ..Default::default()
            },
            root.path(),
        )
        .unwrap_err();
        assert!(error.contains("unsafe"));
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
};

use fs2::FileExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::protocol::{AgentKind, ExecutionRequest};

#[path = "instance_session.rs"]
mod session;
pub(crate) use session::validate_session;

#[derive(Debug)]
pub(super) struct HomeLease(fs::File);

impl Drop for HomeLease {
    fn drop(&mut self) {
        // Closing alone leaves flock held if a concurrent fork inherited the
        // open file description. The execution's lifetime owns this lease.
        let _ = FileExt::unlock(&self.0);
    }
}

/// Backend Bot requests use the executing user's named agent Home.
/// Shell-only requests retain the application's managed native Home.
pub(super) fn request_home(request: &ExecutionRequest) -> Option<PathBuf> {
    // Direct Wework profiles carry runtime Bot IDs but do not own a backend Team.
    if request.extra.get("team_id") == Some(&json!(0)) {
        return None;
    }
    let bot = match &request.bot {
        Value::Array(bots) => bots.first()?,
        Value::Object(_) => &request.bot,
        _ => return None,
    };
    if bot.get("id").and_then(positive_id).is_none()
        && request.extra.get("team_id").and_then(positive_id).is_none()
    {
        return None;
    }
    if !matches!(
        request.resolved_agent_kind(),
        AgentKind::CodeX | AgentKind::ClaudeCode
    ) {
        return None;
    }
    // Invalid explicit roots remain invalid here and are rejected by acquire.
    let root = crate::services::workbench::workbench_root().unwrap_or_default();
    Some(named_home_at(&root, request).unwrap_or_default())
}

fn path_component(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 200
        || value == "."
        || value == ".."
        || value.ends_with([' ', '.'])
        || value
            .chars()
            .any(|ch| ch.is_control() || "/\\:<>\"|?*".contains(ch))
    {
        return Err("Invalid agent directory name".to_owned());
    }
    Ok(value)
}

fn named_home_at(root: &Path, request: &ExecutionRequest) -> Result<PathBuf, String> {
    home_with_user(root, request, current_user_component(request)?)
}

fn current_user_component(request: &ExecutionRequest) -> Result<&str, String> {
    path_component(
        request
            .user_name
            .as_deref()
            .ok_or("Executing user name is missing")?,
    )
}

fn home_with_user(root: &Path, request: &ExecutionRequest, user: &str) -> Result<PathBuf, String> {
    let namespace = namespace_component(
        request
            .team_namespace
            .as_deref()
            .ok_or("Agent namespace is missing")?,
    )?;
    let name = request
        .extra
        .get("team_name")
        .and_then(Value::as_str)
        .ok_or("Agent name is missing")?;
    Ok(root
        .join("agents")
        .join(user)
        .join(namespace)
        .join(path_component(name)?))
}

// Used only to recognize directories written by earlier versions.
fn legacy_owner_component(request: &ExecutionRequest) -> Result<String, String> {
    let owner = request
        .extra
        .get("team_owner")
        .ok_or("Agent resource owner is missing")?;
    let name = path_component(
        owner
            .get("name")
            .and_then(Value::as_str)
            .ok_or("Agent owner name is missing")?,
    )?;
    match owner.get("kind").and_then(Value::as_str) {
        Some("public") if owner.get("id") == Some(&json!(0)) && name == "public" => {
            Ok("public".to_owned())
        }
        Some("user") if owner.get("id").and_then(positive_id).is_some() => Ok(name.to_owned()),
        Some("group") if owner.get("id").and_then(positive_id).is_some() => {
            Ok(format!("group-{name}"))
        }
        _ => Err("Invalid agent resource owner".to_owned()),
    }
}

fn namespace_component(namespace: &str) -> Result<String, String> {
    for part in namespace.split('/') {
        path_component(part)?;
    }
    // Nested namespaces remain one directory level; encode '%' first to avoid collisions.
    let encoded = namespace.replace('%', "%25").replace('/', "%2F");
    path_component(&encoded)?;
    Ok(encoded)
}

fn legacy_named_home_at(root: &Path, request: &ExecutionRequest) -> Result<PathBuf, String> {
    let namespace = request
        .team_namespace
        .as_deref()
        .ok_or("Agent namespace is missing")?;
    let owner = if namespace == "default" {
        request
            .user_name
            .as_deref()
            .ok_or("Agent owner name is missing")?
    } else {
        namespace
    };
    let name = request
        .extra
        .get("team_name")
        .and_then(Value::as_str)
        .ok_or("Agent name is missing")?;
    Ok(root
        .join("agents")
        .join(path_component(owner)?)
        .join(path_component(name)?))
}

fn legacy_home_at(root: &Path, request: &ExecutionRequest) -> PathBuf {
    let bot = request
        .bot
        .as_array()
        .and_then(|bots| bots.first())
        .unwrap_or(&request.bot);
    let owner = json!([
        request_backend(request).and_then(|url| backend_identity(url).ok()),
        request_user_id(request),
    ]);
    let instance = json!([
        request.extra.get("team_id").and_then(positive_id),
        bot.get("id").and_then(positive_id),
        request.task_id,
        request.resolved_shell_type(),
    ]);
    root.join("agents")
        .join(digest(&owner))
        .join(digest(&instance))
}

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn positive_id(value: &Value) -> Option<String> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
}

fn request_user_id(request: &ExecutionRequest) -> Option<String> {
    request
        .extra
        .get("user_id")
        .and_then(positive_id)
        .or_else(|| request.extra.get("user")?.get("id").and_then(positive_id))
}

fn request_backend(request: &ExecutionRequest) -> Option<&str> {
    request
        .extra
        .get("authenticated_backend_url")
        .and_then(Value::as_str)
        .or(request.backend_url.as_deref())
}

fn backend_identity(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "Invalid agent backend identity")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid agent backend identity".to_owned());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn request_identity(request: &ExecutionRequest) -> Result<Value, String> {
    let mut identity = legacy_identity(request)?;
    current_user_component(request)?;
    namespace_component(
        request
            .team_namespace
            .as_deref()
            .ok_or("Agent namespace is missing")?,
    )?;
    path_component(
        request
            .extra
            .get("team_name")
            .and_then(Value::as_str)
            .ok_or("Agent name is missing")?,
    )?;
    identity["team_namespace"] = json!(request.team_namespace);
    identity["team_name"] = request.extra["team_name"].clone();
    identity["user_name"] = json!(request.user_name);
    Ok(identity)
}

fn legacy_identity(request: &ExecutionRequest) -> Result<Value, String> {
    let bot = request
        .bot
        .as_array()
        .and_then(|bots| bots.first())
        .unwrap_or(&request.bot);
    Ok(json!({
        "backend_url": backend_identity(request_backend(request).ok_or("Agent backend identity is missing")?)?,
        "user_id": request_user_id(request).ok_or("Agent user identity is missing")?,
        "team_id": request.extra.get("team_id").and_then(positive_id),
        "bot_id": bot.get("id").and_then(positive_id),
        "shell_type": request.resolved_shell_type(),
    }))
}

fn task_binding(home: &Path, task_id: &str) -> Result<PathBuf, String> {
    Ok(home
        .join("runtime/tasks")
        .join(format!("{}.json", path_component(task_id)?)))
}

fn read_marker(path: &Path) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err("Invalid agent identity marker".to_owned());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn marker_matches(marker: &Value, identity: &Value) -> bool {
    identity.as_object().is_some_and(|fields| {
        fields
            .iter()
            .all(|(key, value)| marker.get(key) == Some(value))
    })
}

fn validate_agent_identity(marker: &Value, request: &ExecutionRequest) -> Result<(), String> {
    let identity = match marker["schema_version"].as_u64() {
        Some(4) => {
            let mut identity = request_identity(request)?;
            identity.as_object_mut().unwrap().remove("user_name");
            identity
        }
        Some(5) => legacy_identity(request)?,
        _ => return Err("Unsupported agent Home identity format".to_owned()),
    };
    if !marker_matches(marker, &identity) {
        return Err("Agent Home identity does not match the execution".to_owned());
    }
    Ok(())
}

/// Upgrade expanded task records only after checking their original Home binding.
fn read_task_record(home: &Path, task_id: &str, agent: &Value) -> Result<Value, String> {
    let value = read_marker(&task_binding(home, task_id)?)?;
    if value["task_id"].as_str() != Some(task_id) {
        return Err("Agent task binding does not match the execution".to_owned());
    }
    let compact = value
        .as_object()
        .is_some_and(|fields| fields.len() == 2 && fields.contains_key("migrated_session"));
    if compact && agent["schema_version"] != 5 {
        return Err("Compact task binding requires the upgraded agent identity".to_owned());
    }
    if !compact {
        for key in ["backend_url", "user_id", "team_id", "bot_id", "shell_type"] {
            if agent.get(key).is_none() || value.get(key) != agent.get(key) {
                return Err("Agent task binding is inconsistent".to_owned());
            }
        }
        let identity: ExecutionRequest =
            serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
        let expected = if identity.user_name.is_some() {
            named_home_at(Path::new(""), &identity)?
        } else {
            home_with_user(
                Path::new(""),
                &identity,
                &legacy_owner_component(&identity)?,
            )?
        };
        if !home.ends_with(expected) {
            return Err("Agent task binding does not match its directory".to_owned());
        }
        if agent["schema_version"] == 4 {
            for key in ["team_owner", "team_namespace", "team_name"] {
                if value.get(key) != agent.get(key) {
                    return Err("Agent task binding is inconsistent".to_owned());
                }
            }
        }
    }
    if !value["migrated_session"].is_null() && !value["migrated_session"].is_object() {
        return Err("Invalid agent task migration record".to_owned());
    }
    Ok(json!({"task_id": task_id, "migrated_session": value["migrated_session"]}))
}

fn reject_symlink_ancestors(path: &Path, root: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Agent Home escapes workbench root")?;
    let mut current = root.canonicalize().map_err(|error| error.to_string())?;
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("Invalid agent Home component".to_owned());
        }
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Agent Home contains a symlink".to_owned())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
    }
    Ok(())
}

pub(super) fn acquire(request: &ExecutionRequest) -> Result<Option<HomeLease>, String> {
    if request_home(request).is_none() {
        return Ok(None);
    }
    request_identity(request)?;
    let root = crate::services::workbench::workbench_root()?;
    let home = named_home_at(&root, request)?;
    acquire_at(request, &root, &home).map(Some)
}

fn acquire_at(request: &ExecutionRequest, root: &Path, home: &Path) -> Result<HomeLease, String> {
    if request.task_id.trim().is_empty() {
        return Err("Bot native Home requires a task identity".to_owned());
    }
    if !home.is_absolute() {
        return Err("Workbench root must be absolute".to_owned());
    }
    request_identity(request)?;
    if named_home_at(root, request)? != home {
        return Err("Agent Home directory does not match the execution identity".to_owned());
    }
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    reject_symlink_ancestors(home, root)?;
    fs::create_dir_all(home).map_err(|error| format!("create agent Home: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(home, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure agent Home: {error}"))?;
    }
    reject_symlink_ancestors(&home.join(".execution.lock"), root)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(home.join(".execution.lock"))
        .map_err(|error| format!("open agent Home lock: {error}"))?;
    lock.try_lock_exclusive()
        .map_err(|_| "Agent Home already has an active execution".to_owned())?;
    let lock = HomeLease(lock);
    let marker = home.join("agent.json");
    let existing = marker
        .try_exists()
        .map_err(|error| error.to_string())?
        .then(|| read_marker(&marker))
        .transpose()?;
    if let Some(existing) = &existing {
        validate_agent_identity(existing, request)?;
    }
    let binding = task_binding(home, &request.task_id)?;
    reject_symlink_ancestors(&binding, root)?;
    let task = if binding.try_exists().map_err(|error| error.to_string())? {
        read_task_record(
            home,
            &request.task_id,
            existing
                .as_ref()
                .ok_or("Task binding has no agent identity")?,
        )?
    } else {
        json!({"task_id": request.task_id, "migrated_session": session::migrate(request, home, root)?})
    };
    let mut identity = legacy_identity(request)?;
    identity["schema_version"] = json!(5);
    identity["user_name"] = json!(request.user_name);
    // Readers accept expanded tasks under schema 5 if interrupted between writes.
    if existing.as_ref() != Some(&identity) {
        super::runtime_capabilities::write_json_file(&marker, &identity)?;
    }
    if !binding.exists() || read_marker(&binding)? != task {
        super::runtime_capabilities::write_json_file(&binding, &task)?;
    }
    Ok(lock)
}

fn verified_legacy_home(
    root: &Path,
    request: &ExecutionRequest,
) -> Result<Option<(PathBuf, HomeLease)>, String> {
    if request.new_session {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    // Find earlier resource-owner Homes using the recorded execution identity,
    // even when an older Backend does not send team_owner.
    let current = named_home_at(root, request)?;
    let identity = legacy_identity(request)?;
    if root.join("agents").is_dir() {
        for home in agent_homes(&root.join("agents"))? {
            if home == current || !home.join("agent.json").is_file() {
                continue;
            }
            let marker = read_marker(&home.join("agent.json"))?;
            if matches!(marker["schema_version"].as_u64(), Some(4 | 5))
                && marker_matches(&marker, &identity)
                && task_binding(&home, &request.task_id)?.is_file()
            {
                candidates.push((home, marker["schema_version"].as_u64().unwrap()));
            }
        }
    }
    if candidates.len() > 1 {
        return Err("Task has multiple legacy agent Homes".to_owned());
    }
    if let Ok(named) = legacy_named_home_at(root, request) {
        candidates.push((named, 3));
    }
    candidates.push((legacy_home_at(root, request), 2));
    // Prefer the last layout, but never skip an existing unverified Home.
    for (home, schema) in candidates {
        if !home.try_exists().map_err(|error| error.to_string())? {
            continue;
        }
        reject_symlink_ancestors(&home, root)?;
        reject_symlink_ancestors(&home.join(".execution.lock"), root)?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(home.join(".execution.lock"))
            .map_err(|error| error.to_string())?;
        lock.try_lock_exclusive()
            .map_err(|_| "Legacy agent Home is still active".to_owned())?;
        let lock = HomeLease(lock);
        let marker = read_marker(&home.join("agent.json"))?;
        let mut identity = if schema == 4 {
            let mut identity = request_identity(request)?;
            identity.as_object_mut().unwrap().remove("user_name");
            identity
        } else {
            legacy_identity(request)?
        };
        let mut task = identity.clone();
        task["task_id"] = json!(request.task_id);
        if schema == 5 {
            read_task_record(&home, &request.task_id, &marker)?;
        } else if schema >= 3 {
            identity["team_namespace"] = json!(request.team_namespace);
            identity["team_name"] = request.extra["team_name"].clone();
            let binding = task_binding(&home, &request.task_id)?;
            reject_symlink_ancestors(&binding, root)?;
            if !marker_matches(&read_marker(&binding)?, &task) {
                return Err("Legacy task binding does not match the execution".to_owned());
            }
        } else {
            identity["task_id"] = json!(request.task_id);
        }
        if marker.get("schema_version").and_then(Value::as_u64) != Some(schema)
            || !marker_matches(&marker, &identity)
        {
            return Err("Legacy agent Home identity does not match the execution".to_owned());
        }
        return Ok(Some((home, lock)));
    }
    Ok(None)
}

pub(super) fn migrated_codex_rollout(
    request: &ExecutionRequest,
    thread_id: &str,
) -> Option<PathBuf> {
    let home = request_home(request)?;
    let agent = read_marker(&home.join("agent.json")).ok()?;
    validate_agent_identity(&agent, request).ok()?;
    let marker = read_task_record(&home, &request.task_id, &agent).ok()?;
    let session = marker.get("migrated_session")?;
    if session.get("id")?.as_str()? != thread_id {
        return None;
    }
    let relative = Path::new(session.get("path")?.as_str()?);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return None;
    }
    Some(home.join(relative))
}

/// A task number alone is not an identity across accounts or backends.
pub(crate) fn task_skills_directory(
    task_id: &str,
    backend_url: &str,
    user_id: &str,
) -> Result<PathBuf, String> {
    task_skills_directory_at(
        &crate::services::workbench::workbench_root()?,
        task_id,
        backend_url,
        user_id,
    )
}

pub(crate) fn task_skills_directory_at(
    root: &Path,
    task_id: &str,
    backend_url: &str,
    user_id: &str,
) -> Result<PathBuf, String> {
    let backend_url = backend_identity(backend_url)?;
    let user_id = positive_id(&json!(user_id)).ok_or("Agent user identity is missing")?;
    let agents = root.join("agents");
    reject_symlink_ancestors(&agents, root)?;
    let mut found = Vec::new();
    for agent in agent_homes(&agents)? {
        let marker = agent.join("agent.json");
        if !marker.is_file() {
            continue;
        }
        let agent_marker = read_marker(&marker)?;
        if !matches!(agent_marker["schema_version"].as_u64(), Some(4 | 5)) {
            continue;
        }
        if agent_marker["backend_url"].as_str() != Some(backend_url.as_str())
            || agent_marker["user_id"].as_str() != Some(user_id.as_str())
        {
            continue;
        }
        if agent_marker["schema_version"] == 4 {
            let identity: ExecutionRequest =
                serde_json::from_value(agent_marker.clone()).map_err(|error| error.to_string())?;
            let expected = if identity.user_name.is_some() {
                named_home_at(root, &identity)?
            } else {
                home_with_user(root, &identity, &legacy_owner_component(&identity)?)?
            };
            if expected != agent {
                return Err("Agent Home directory does not match its identity".to_owned());
            }
        }
        let binding = task_binding(&agent, task_id)?;
        reject_symlink_ancestors(&binding, root)?;
        if !binding.try_exists().map_err(|error| error.to_string())? {
            continue;
        }
        read_task_record(&agent, task_id, &agent_marker)?;
        let is_current = agent_marker["user_name"].as_str().is_some_and(|name| {
            path_component(name).is_ok() && agent.starts_with(agents.join(name))
        });
        found.push((agent, is_current));
    }
    if found.iter().any(|(_, current)| *current) {
        found.retain(|(_, current)| *current);
    }
    let [(home, _)] = found.as_slice() else {
        return Err(if found.is_empty() {
            "Task has no prepared agent Home"
        } else {
            "Task has multiple isolated agent Homes"
        }
        .to_owned());
    };
    let skills = home.join("skills");
    reject_symlink_ancestors(&skills, root)?;
    if !skills.is_dir() {
        return Err("Task has no activated Skills directory".to_owned());
    }
    Ok(skills)
}

fn agent_homes(agents: &Path) -> Result<Vec<PathBuf>, String> {
    let mut directories = vec![agents.to_path_buf()];
    for _ in 0..3 {
        let mut children = Vec::new();
        for directory in directories {
            for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_dir()
                {
                    children.push(entry.path());
                }
            }
        }
        directories = children;
    }
    Ok(directories)
}

#[cfg(test)]
#[path = "instance_home_tests.rs"]
mod tests;

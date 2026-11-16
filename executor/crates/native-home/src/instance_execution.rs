// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::logging::log_executor_event;
use wegent_subprocess::CommandSpec;

/// A private native configuration with shared, durable conversation storage.
/// Shared Home leases allow executions to overlap while excluding session archives.
pub struct ExecutionHome {
    root: PathBuf,
    home: PathBuf,
    task_id: String,
    runtime_task_id: Option<String>,
    snapshot: PathBuf,
    staging: Option<tempfile::TempDir>,
    activity: Option<HomeLease>,
    _task_lease: HomeLease,
    session_lease: Option<HomeLease>,
    _home_lease: HomeLease,
}

pub async fn acquire_claude(request: &ExecutionRequest) -> Result<Option<ExecutionHome>, String> {
    if request_home(request).is_none() {
        return Ok(None);
    }
    let request = request.clone();
    tokio::task::spawn_blocking(move || {
        let root = wegent_runtime_config::home::workbench_root()?;
        let home = named_home_at(&root, &request)?;
        create_at(&request, &root, &home).map(Some)
    })
    .await
    .map_err(|error| format!("prepare execution Home: {error}"))?
}

fn create_at(
    request: &ExecutionRequest,
    root: &Path,
    home: &Path,
) -> Result<ExecutionHome, String> {
    prepare_home(request, root, home)?;
    let lock = open_home_lock(home, root)?;
    FileExt::try_lock_shared(&lock)
        .map_err(|error| format!("Agent Home is unavailable for execution: {error}"))?;
    let home_lease = HomeLease(lock);
    // Only binding/migration and the initial snapshot are serialized, never model work.
    let _preparation = preparation_lease(home, root)?;
    let scope = SnapshotScope::for_request(request);
    let task_lease = scope.lease(home, root)?;
    bind_task_at(request, root, home)?;
    let dispatch = SnapshotScope::Dispatch(&request.task_id);
    let pointer = dispatch.pointer(home);
    reject_symlink_ancestors(&pointer, root)?;
    if !pointer.try_exists().map_err(|error| error.to_string())? {
        let mut record = json!({"task_id": request.task_id, "snapshot": null});
        if let SnapshotScope::Runtime(id) = scope {
            record["runtime_task_id"] = json!(id);
        }
        wegent_filesystem::json_file::write_json_file(&pointer, &record)?;
    } else if let SnapshotScope::Runtime(id) = scope {
        let record = read_marker(&pointer)?;
        if record["task_id"] != request.task_id || record["runtime_task_id"] != id {
            return Err("Execution is already bound to a different task identity".to_owned());
        }
    }
    let executions = home.join("runtime/executions");
    reject_symlink_ancestors(&executions, root)?;
    fs::create_dir_all(&executions).map_err(|error| error.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix("execution-")
        .tempdir_in(&executions)
        .map_err(|error| error.to_string())?;
    let snapshot = staging.path().to_owned();
    seed_configuration(home, &snapshot)?;
    // Older versions wrote task MCP servers to the shared Home without provenance.
    // Only this task's previous snapshot is safe to use for continuation.
    if let Some(previous) = latest_snapshot(home, root, scope)? {
        copy_optional_file(&previous.join("mcp.json"), &snapshot.join("mcp.json"))?;
    }
    let projects = home.join("projects");
    reject_symlink_ancestors(&projects, root)?;
    fs::create_dir_all(&projects).map_err(|error| error.to_string())?;
    crate::directory_link::create(&projects, &snapshot.join("projects"))
        .map_err(|error| error.to_string())?;
    let activity = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(snapshot.join(".active.lock"))
        .map_err(|error| error.to_string())?;
    activity
        .try_lock_exclusive()
        .map_err(|error| error.to_string())?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(snapshot.join(".read.lock"))
        .map_err(|error| error.to_string())?;
    let mut identity =
        json!({"task_id": request.task_id, "subtask_id": request.subtask_id, "ready": false});
    if let SnapshotScope::Runtime(id) = scope {
        identity["runtime_task_id"] = json!(id);
    }
    wegent_filesystem::json_file::write_json_file(&snapshot.join("execution.json"), &identity)?;
    Ok(ExecutionHome {
        root: root.to_owned(),
        home: home.to_owned(),
        task_id: request.task_id.clone(),
        runtime_task_id: request.agent_home_runtime_task_id.clone(),
        snapshot,
        staging: Some(staging),
        activity: Some(HomeLease(activity)),
        _task_lease: task_lease,
        session_lease: None,
        _home_lease: home_lease,
    })
}

fn identity_lease(
    home: &Path,
    root: &Path,
    directory: &str,
    identity: &str,
    label: &str,
) -> Result<HomeLease, String> {
    let path = home
        .join("runtime")
        .join(directory)
        .join(format!("{}.lock", digest(&json!(identity))));
    reject_symlink_ancestors(&path, root)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.try_lock_exclusive()
        .map_err(|error| format!("{label} already has an active execution: {error}"))?;
    Ok(HomeLease(file))
}

fn preparation_lease(home: &Path, root: &Path) -> Result<HomeLease, String> {
    let path = home.join(".preparation.lock");
    reject_symlink_ancestors(&path, root)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| error.to_string())?;
    FileExt::lock_exclusive(&file).map_err(|error| error.to_string())?;
    Ok(HomeLease(file))
}

fn seed_configuration(home: &Path, snapshot: &Path) -> Result<(), String> {
    for name in [
        "settings.json",
        "claude.json",
        ".claude.json",
        ".credentials.json",
        "CLAUDE.md",
    ] {
        copy_optional_file(&home.join(name), &snapshot.join(name))?;
    }
    for name in ["agents", "commands", "rules", "plugins"] {
        copy_configuration_tree(&home.join(name), &snapshot.join(name), 0)?;
    }
    Ok(())
}

fn copy_optional_file(source: &Path, target: &Path) -> Result<(), String> {
    match fs::symlink_metadata(source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(metadata) if metadata.is_file() => fs::copy(source, target)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        Ok(_) => Err("Execution configuration must be a regular file".to_owned()),
        Err(error) => Err(error.to_string()),
    }
}

fn copy_configuration_tree(source: &Path, target: &Path, depth: usize) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        result => result.map_err(|error| error.to_string())?,
    };
    if depth > 12 {
        return Err("Native configuration tree exceeds supported depth".to_owned());
    }
    if metadata.is_file() {
        return copy_optional_file(source, target);
    }
    if !metadata.is_dir() {
        return Err("Native configuration tree must not contain links".to_owned());
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let destination = target.join(entry.file_name());
        // Native plugin packages are shared; selection and settings files are private.
        if matches!(entry.file_name().to_str(), Some("cache" | "marketplaces"))
            && source.file_name().is_some_and(|name| name == "plugins")
        {
            crate::directory_link::create(
                &fs::canonicalize(entry.path()).map_err(|e| e.to_string())?,
                &destination,
            )
            .map_err(|error| error.to_string())?;
        } else {
            copy_configuration_tree(&entry.path(), &destination, depth + 1)?;
        }
    }
    Ok(())
}

impl ExecutionHome {
    pub fn configure(&mut self, spec: CommandSpec) -> Result<CommandSpec, String> {
        if let Some(session) = spec.args().windows(2).find(|args| args[0] == "--resume") {
            self.session_lease = Some(identity_lease(
                &self.home,
                &self.root,
                "session-locks",
                &session[1],
                "Conversation",
            )?);
        }
        Ok(spec
            .env("CLAUDE_CONFIG_DIR", self.snapshot.display().to_string())
            .env(
                "SKILLS_DIR",
                self.snapshot.join("skills").display().to_string(),
            )
            .env("WEGENT_AGENT_HOME", self.home.display().to_string()))
    }

    pub fn activate(&mut self) -> Result<(), String> {
        let root = self.root.clone();
        let _preparation = preparation_lease(&self.home, &root)?;
        wegent_plugin_packages::skill_selection::publish_agent_skills(&self.home, &self.snapshot)?;
        let mut record = read_marker(&self.snapshot.join("execution.json"))?;
        record["ready"] = json!(true);
        wegent_filesystem::json_file::write_json_file(
            &self.snapshot.join("execution.json"),
            &record,
        )?;
        let scope = self.scope();
        let pointer = scope.pointer(&self.home);
        reject_symlink_ancestors(&pointer, &root)?;
        let name = self
            .snapshot
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid execution snapshot directory name")?;
        let mut selection = json!({"snapshot": name});
        selection[scope.field()] = json!(scope.id());
        wegent_filesystem::json_file::write_json_file(&pointer, &selection)?;
        if let Some(staging) = self.staging.take() {
            let _ = staging.keep();
        }
        // Only the most recent completed selection per task is retained for extensions.
        self.prune_completed();
        Ok(())
    }

    fn prune_completed(&self) {
        if let Err(error) = prune_inactive_snapshots(&self.home, &self.root, self.scope()) {
            log_executor_event(
                "execution snapshot prune failed",
                &[("task_id", self.task_id.clone()), ("error", error)],
            );
        }
    }

    fn scope(&self) -> SnapshotScope<'_> {
        self.runtime_task_id.as_deref().map_or(
            SnapshotScope::Dispatch(&self.task_id),
            SnapshotScope::Runtime,
        )
    }
}

impl Drop for ExecutionHome {
    fn drop(&mut self) {
        drop(self.activity.take());
        if self.staging.is_none() {
            if let Ok(_preparation) = preparation_lease(&self.home, &self.root) {
                self.prune_completed();
            }
        }
    }
}

#[derive(Clone, Copy)]
enum SnapshotScope<'a> {
    Dispatch(&'a str),
    Runtime(&'a str),
}

impl<'a> SnapshotScope<'a> {
    fn for_request(request: &'a ExecutionRequest) -> Self {
        request
            .agent_home_runtime_task_id
            .as_deref()
            .map_or(Self::Dispatch(&request.task_id), Self::Runtime)
    }

    fn id(self) -> &'a str {
        match self {
            Self::Dispatch(id) | Self::Runtime(id) => id,
        }
    }

    fn field(self) -> &'static str {
        match self {
            Self::Dispatch(_) => "task_id",
            Self::Runtime(_) => "runtime_task_id",
        }
    }

    fn pointer(self, home: &Path) -> PathBuf {
        let directory = match self {
            Self::Dispatch(_) => "task-executions",
            Self::Runtime(_) => "runtime-task-executions",
        };
        home.join("runtime")
            .join(directory)
            .join(format!("{}.json", digest(&json!(self.id()))))
    }

    fn lease(self, home: &Path, root: &Path) -> Result<HomeLease, String> {
        let directory = match self {
            Self::Dispatch(_) => "task-locks",
            Self::Runtime(_) => "runtime-task-locks",
        };
        identity_lease(home, root, directory, self.id(), "Task")
    }

    fn matches(self, record: &Value) -> bool {
        record[self.field()] == self.id()
    }
}

fn latest_snapshot(
    home: &Path,
    root: &Path,
    scope: SnapshotScope<'_>,
) -> Result<Option<PathBuf>, String> {
    let pointer = scope.pointer(home);
    reject_symlink_ancestors(&pointer, root)?;
    if !pointer.try_exists().map_err(|error| error.to_string())? {
        return Ok(None);
    }
    let record = read_marker(&pointer)?;
    if !scope.matches(&record) {
        return Err("Invalid execution snapshot identity".to_owned());
    }
    if let (SnapshotScope::Dispatch(task_id), Some(runtime_id)) =
        (scope, record["runtime_task_id"].as_str())
    {
        // A per-dispatch grant must never open the next turn's snapshot.
        let Some(path) = latest_snapshot(home, root, SnapshotScope::Runtime(runtime_id))? else {
            return Ok(None);
        };
        return Ok(
            (read_marker(&path.join("execution.json"))?["task_id"] == task_id).then_some(path),
        );
    }
    if record["snapshot"].is_null() {
        return Ok(None);
    }
    let name = record["snapshot"]
        .as_str()
        .ok_or("Invalid execution snapshot reference")?;
    if !name.starts_with("execution-") {
        return Err("Invalid execution snapshot identity".to_owned());
    }
    let path = home.join("runtime/executions").join(path_component(name)?);
    reject_symlink_ancestors(&path, root)?;
    let identity = read_marker(&path.join("execution.json"))?;
    if !scope.matches(&identity) || identity["ready"] != true {
        return Err("Invalid execution snapshot identity".to_owned());
    }
    Ok(Some(path))
}

fn is_active(snapshot: &Path) -> Result<bool, String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(snapshot.join(".active.lock"))
        .map_err(|error| error.to_string())?;
    match file.try_lock_exclusive() {
        Ok(()) => {
            FileExt::unlock(&file).map_err(|error| error.to_string())?;
            Ok(false)
        }
        Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
            Ok(true)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn task_snapshots(
    home: &Path,
    root: &Path,
    scope: Option<SnapshotScope<'_>>,
) -> Result<Vec<PathBuf>, String> {
    let path = home.join("runtime/executions");
    reject_symlink_ancestors(&path, root)?;
    let entries = match fs::read_dir(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        result => result.map_err(|error| error.to_string())?,
    };
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            return Err("Invalid execution snapshot directory".to_owned());
        }
        let record = match read_marker(&entry.path().join("execution.json")) {
            Err(_) if !entry.path().join("execution.json").exists() => continue,
            result => result?,
        };
        if scope.map_or(true, |scope| scope.matches(&record)) && record["ready"] == true {
            found.push(entry.path());
        }
    }
    Ok(found)
}

pub(super) fn active_skills(
    home: &Path,
    root: &Path,
    task_id: &str,
) -> Result<Vec<TaskSkillsDirectory>, String> {
    let _preparation = preparation_lease(home, root)?;
    task_snapshots(home, root, Some(SnapshotScope::Dispatch(task_id)))?
        .into_iter()
        .filter_map(|path| match is_active(&path) {
            Ok(true) => Some(pinned_snapshot_skills(&path)),
            Ok(false) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

pub(super) fn has_active_snapshot(home: &Path, root: &Path) -> Result<bool, String> {
    let _preparation = preparation_lease(home, root)?;
    for path in task_snapshots(home, root, None)? {
        if is_active(&path)? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn pin_skills(skills: &Path) -> Result<Option<HomeLease>, String> {
    let snapshot = skills.parent().ok_or("Skills directory has no parent")?;
    let path = snapshot.join(".read.lock");
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Ok(None);
    }
    if !fs::symlink_metadata(&path)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Invalid execution snapshot reader lock".to_owned());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    FileExt::try_lock_shared(&file).map_err(|error| error.to_string())?;
    Ok(Some(HomeLease(file)))
}

pub(super) fn latest_skills(
    home: &Path,
    root: &Path,
    task_id: &str,
) -> Result<Option<TaskSkillsDirectory>, String> {
    let _preparation = preparation_lease(home, root)?;
    let scope = SnapshotScope::Dispatch(task_id);
    let latest = latest_snapshot(home, root, scope)?;
    if latest.is_none()
        && scope
            .pointer(home)
            .try_exists()
            .map_err(|error| error.to_string())?
    {
        return Err("Task has no activated execution Skills directory".to_owned());
    }
    latest.as_deref().map(pinned_snapshot_skills).transpose()
}

// The caller holds the Home preparation lease until the reader lease is acquired.
fn pinned_snapshot_skills(snapshot: &Path) -> Result<TaskSkillsDirectory, String> {
    let skills = TaskSkillsDirectory::pin(snapshot.join("skills"))?;
    if skills._snapshot_lease.is_none() {
        return Err("Execution snapshot reader lock is missing".to_owned());
    }
    Ok(skills)
}

fn prune_inactive_snapshots(
    home: &Path,
    root: &Path,
    scope: SnapshotScope<'_>,
) -> Result<(), String> {
    let latest = latest_snapshot(home, root, scope)?;
    for path in task_snapshots(home, root, Some(scope))? {
        if Some(&path) != latest.as_ref() && !is_active(&path)? {
            let reader = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path.join(".read.lock"))
                .map_err(|error| error.to_string())?;
            match reader.try_lock_exclusive() {
                Ok(()) => {}
                Err(error)
                    if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    continue
                }
                Err(error) => return Err(error.to_string()),
            }
            let _reader = HomeLease(reader);
            // Remove the directory link explicitly before deleting private configuration.
            let projects = path.join("projects");
            if projects.is_symlink() {
                crate::directory_link::remove(&projects).map_err(|e| e.to_string())?;
            }
            fs::remove_dir_all(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "instance_execution_tests.rs"]
mod tests;

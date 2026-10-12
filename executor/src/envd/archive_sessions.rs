// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Component, Path, PathBuf},
};

/// Portable archive prefixes are independent of runtime mount points.
#[derive(Clone, Debug)]
pub struct SessionArchiveRoots {
    pub executor: PathBuf,
    pub workbench: PathBuf,
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub legacy_executor: PathBuf,
}

impl SessionArchiveRoots {
    pub(super) fn lock_task_homes(&self, task_id: &str) -> io::Result<Vec<fs::File>> {
        use fs2::FileExt;
        let mut homes = Vec::new();
        collect_agent_homes(&self.workbench.join("agents"), task_id, 0, &mut homes)?;
        homes
            .into_iter()
            .map(|home| {
                let file = fs::OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(home.join(".execution.lock"))?;
                file.try_lock_exclusive().map_err(|_| {
                    io::Error::other(
                        "Agent is running; retry the archive after execution completes",
                    )
                })?;
                Ok(file)
            })
            .collect()
    }
    pub fn for_home(home: &Path) -> Self {
        Self {
            executor: home.join(".wegent/workbench/executor"),
            workbench: home.join(".wegent/workbench"),
            claude: home.join(".claude"),
            codex: home.join(".codex"),
            legacy_executor: home.join(".wegent-executor"),
        }
    }

    pub fn from_env() -> io::Result<Self> {
        let home =
            dirs::home_dir().ok_or_else(|| io::Error::other("Home directory is unavailable"))?;
        Ok(Self {
            executor: crate::config::paths::executor_home(),
            workbench: crate::services::workbench::workbench_root().map_err(io::Error::other)?,
            claude: std::env::var_os("WEGENT_CLAUDE_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude")),
            codex: crate::agents::wework_codex_home(),
            legacy_executor: if std::env::var_os("WEGENT_EXECUTOR_HOME")
                .is_some_and(|value| !value.to_string_lossy().trim().is_empty())
            {
                crate::config::paths::executor_home()
            } else {
                home.join(".wegent-executor")
            },
        })
    }

    pub(super) fn collect(&self, task_id: &str) -> io::Result<BTreeMap<PathBuf, PathBuf>> {
        let mut files = BTreeMap::new();
        let markers = self.executor.join("sessions").join(task_id);
        let mut homes = Vec::new();
        collect_agent_homes(&self.workbench.join("agents"), task_id, 0, &mut homes)?;
        let mut candidates = children(&markers)?;
        if self.legacy_executor.canonicalize().ok() != self.executor.canonicalize().ok() {
            for path in children(&self.legacy_executor.join("sessions").join(task_id))? {
                if !candidates
                    .iter()
                    .any(|candidate| candidate.file_name() == path.file_name())
                {
                    candidates.push(path);
                }
            }
        }
        for marker in candidates {
            if !regular(&marker)? {
                continue;
            }
            let name = marker.file_name().unwrap().to_string_lossy();
            if !super::archive::is_session_marker_name(marker.file_name().unwrap()) {
                continue;
            }
            let claude = name.starts_with(".claude_session_id");
            if !claude && !name.starts_with(".codex_thread_id") {
                continue;
            }
            let id = fs::read_to_string(&marker)?;
            let id = id.trim();
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            {
                return Err(io::Error::other(
                    "Invalid session ID marker in task archive",
                ));
            }
            let mut found = false;
            for agent in &homes {
                let relative = agent.strip_prefix(&self.workbench).unwrap();
                let prefix =
                    Path::new("agent-homes").join(relative.strip_prefix("agents").unwrap());
                if collect_session(agent, &prefix, id, claude, &mut files)? {
                    found = true;
                    for meta in [
                        PathBuf::from("agent.json"),
                        PathBuf::from(format!("runtime/tasks/{task_id}.json")),
                    ] {
                        if !regular(&agent.join(&meta))? {
                            return Err(io::Error::other("Agent archive identity is missing"));
                        }
                        files.insert(prefix.join(&meta), agent.join(meta));
                    }
                }
            }
            if !found {
                let (root, prefix) = if claude {
                    (&self.claude, "native-claude")
                } else {
                    (&self.codex, "native-codex")
                };
                found = collect_session(root, Path::new(prefix), id, claude, &mut files)?;
            }
            if !found {
                return Err(io::Error::other(format!("Task {task_id} session backup is incomplete: native conversation for {name} is missing")));
            }
            files.insert(
                Path::new("executor-state/sessions")
                    .join(task_id)
                    .join(marker.file_name().unwrap()),
                marker,
            );
        }
        Ok(files)
    }

    pub(super) fn destination(&self, path: &Path, task_id: &str) -> Option<PathBuf> {
        if path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return None;
        }
        if let Ok(relative) = path.strip_prefix("executor-state") {
            let parent = Path::new("sessions").join(task_id);
            return (relative.parent() == Some(parent.as_path())
                && relative
                    .file_name()
                    .is_some_and(super::archive::is_session_marker_name))
            .then(|| self.executor.join(relative));
        }
        if let Ok(relative) = path.strip_prefix("agent-homes") {
            let parts: Vec<_> = relative.components().collect();
            if parts.len() < 4 {
                return None;
            }
            let suffix: PathBuf = parts[3..].iter().collect();
            if suffix == Path::new("agent.json")
                || suffix == Path::new(&format!("runtime/tasks/{task_id}.json"))
                || suffix.starts_with("projects")
                || suffix.starts_with("sessions")
            {
                return Some(self.workbench.join("agents").join(relative));
            }
            return None;
        }
        for (prefix, root, child) in [
            ("native-claude", &self.claude, "projects"),
            ("native-codex", &self.codex, "sessions"),
        ] {
            if let Ok(relative) = path.strip_prefix(prefix) {
                return relative.starts_with(child).then(|| root.join(relative));
            }
        }
        // Old archives keep task markers under the old Home-relative prefix.
        for prefix in [
            "home/.wegent-executor",
            "__home__/.wegent-executor",
            "home/.wegent/workbench/executor",
        ] {
            if let Ok(relative) = path.strip_prefix(prefix) {
                let parent = Path::new("sessions").join(task_id);
                if relative.parent() == Some(parent.as_path())
                    && relative
                        .file_name()
                        .is_some_and(super::archive::is_session_marker_name)
                {
                    return Some(self.executor.join(relative));
                }
            }
        }
        let relative = path.strip_prefix("workspace").unwrap_or(path);
        if relative.components().count() == 1
            && relative
                .file_name()
                .is_some_and(super::archive::is_session_marker_name)
        {
            return Some(self.executor.join("sessions").join(task_id).join(relative));
        }
        None
    }
}

fn children(root: &Path) -> io::Result<Vec<PathBuf>> {
    match fs::symlink_metadata(root) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
        Ok(m) if !m.is_dir() => {
            return Err(io::Error::other("Session archive root is not a directory"))
        }
        _ => {}
    }
    fs::read_dir(root)?
        .map(|entry| entry.map(|e| e.path()))
        .collect()
}

fn regular(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(m.is_file()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn collect_agent_homes(
    root: &Path,
    task: &str,
    depth: usize,
    found: &mut Vec<PathBuf>,
) -> io::Result<()> {
    if depth == 3 {
        if regular(&root.join(format!("runtime/tasks/{task}.json")))? {
            found.push(root.to_owned());
        }
        return Ok(());
    }
    for child in children(root)? {
        if fs::symlink_metadata(&child)?.is_dir() {
            collect_agent_homes(&child, task, depth + 1, found)?;
        }
    }
    Ok(())
}

fn collect_session(
    home: &Path,
    prefix: &Path,
    id: &str,
    claude: bool,
    files: &mut BTreeMap<PathBuf, PathBuf>,
) -> io::Result<bool> {
    let mut found = Vec::new();
    find_session(
        &home.join(if claude { "projects" } else { "sessions" }),
        id,
        claude,
        0,
        &mut found,
    )?;
    if found.len() > 1 {
        return Err(io::Error::other(
            "Ambiguous native session in archive source",
        ));
    }
    let Some(session) = found.first() else {
        return Ok(false);
    };
    crate::agents::validate_session(
        session,
        id,
        &if claude {
            crate::protocol::AgentKind::ClaudeCode
        } else {
            crate::protocol::AgentKind::CodeX
        },
    )
    .map_err(io::Error::other)?;
    files.insert(
        prefix.join(session.strip_prefix(home).unwrap()),
        session.clone(),
    );
    if claude {
        collect_companions(&session.with_extension(""), home, prefix, files, 0)?;
    }
    Ok(true)
}

fn find_session(
    root: &Path,
    id: &str,
    claude: bool,
    depth: usize,
    found: &mut Vec<PathBuf>,
) -> io::Result<()> {
    if depth > 6 {
        return Err(io::Error::other(
            "Native session archive exceeds directory depth",
        ));
    }
    for child in children(root)? {
        let meta = fs::symlink_metadata(&child)?;
        let name = child.file_name().unwrap().to_string_lossy();
        if meta.is_file()
            && (if claude {
                name == format!("{id}.jsonl")
            } else {
                name.starts_with("rollout-") && name.ends_with(&format!("-{id}.jsonl"))
            })
        {
            found.push(child);
        } else if meta.is_dir() && (!claude || depth == 0) {
            find_session(&child, id, claude, depth + 1, found)?;
        }
    }
    Ok(())
}

fn collect_companions(
    root: &Path,
    home: &Path,
    prefix: &Path,
    files: &mut BTreeMap<PathBuf, PathBuf>,
    depth: usize,
) -> io::Result<()> {
    if depth > 6 {
        return Err(io::Error::other(
            "Native session companion tree exceeds directory depth",
        ));
    }
    for child in children(root)? {
        let meta = fs::symlink_metadata(&child)?;
        if meta.is_dir() {
            collect_companions(&child, home, prefix, files, depth + 1)?;
        } else if meta.is_file() {
            files.insert(prefix.join(child.strip_prefix(home).unwrap()), child);
        }
    }
    Ok(())
}

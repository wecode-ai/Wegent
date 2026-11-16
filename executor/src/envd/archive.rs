// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
    time::Instant,
};

use super::{archive_repository, archive_sessions::SessionArchiveRoots};
use crate::logging::log_executor_event;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use tar::{Archive, Builder, EntryType};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveMode {
    Executor,
    Sandbox,
}

#[derive(Debug, Clone)]
pub struct ArchiveOptions {
    pub mode: ArchiveMode,
    pub task_id: String,
    pub workspace_path: PathBuf,
    pub home_path: PathBuf,
    pub max_size_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct RuntimeArchive {
    pub bytes: Vec<u8>,
    pub session_file_included: bool,
    pub git_included: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreResult {
    pub success: bool,
    pub session_restored: bool,
    pub git_restored: bool,
}

#[derive(Debug, Error)]
pub enum ArchiveError {
    #[error("workspace not found: {0}")]
    MissingWorkspace(PathBuf),
    #[error("no archive roots found: {workspace_path}, {home_path}")]
    EmptyArchiveRoots {
        workspace_path: PathBuf,
        home_path: PathBuf,
    },
    #[error("archive exceeds maximum size: {actual} > {max}")]
    TooLarge { actual: u64, max: u64 },
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub fn create_runtime_archive(options: ArchiveOptions) -> Result<RuntimeArchive, ArchiveError> {
    create_runtime_archive_with_repository(options, None)
}

/// Record the shared checkout binding alongside its task-relative archive members.
pub fn create_runtime_archive_with_repository(
    options: ArchiveOptions,
    repository: Option<(&Path, &str)>,
) -> Result<RuntimeArchive, ArchiveError> {
    let roots = SessionArchiveRoots::for_home(&options.home_path);
    create_runtime_archive_with_roots(options, repository, &roots)
}

pub fn create_runtime_archive_with_roots(
    options: ArchiveOptions,
    repository: Option<(&Path, &str)>,
    roots: &SessionArchiveRoots,
) -> Result<RuntimeArchive, ArchiveError> {
    if let Some((path, name)) = repository {
        if !path.is_dir() || options.workspace_path.join(name).exists() {
            return Err(ArchiveError::Io(std::io::Error::other(
                "Missing or conflicting task repository archive source",
            )));
        }
    }
    if options.mode == ArchiveMode::Executor
        && !options.workspace_path.is_dir()
        && repository.is_none()
    {
        return Err(ArchiveError::MissingWorkspace(options.workspace_path));
    }
    if options.mode == ArchiveMode::Sandbox
        && !options.workspace_path.is_dir()
        && !options.home_path.is_dir()
        && repository.is_none()
    {
        return Err(ArchiveError::EmptyArchiveRoots {
            workspace_path: options.workspace_path,
            home_path: options.home_path,
        });
    }

    let _session_leases = archive_stage(&options.task_id, "lock_sessions", || {
        Ok(roots.lock_task_homes(&options.task_id)?)
    })?;
    let sessions = archive_stage(&options.task_id, "collect_sessions", || {
        Ok(roots.collect(&options.task_id)?)
    })?;
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = Builder::new(encoder);
    // Store symlinks as symlink entries instead of dereferencing their targets.
    // Dereferencing a dangling symlink fails to read the (missing) target and
    // aborts the whole archive; storing the link itself always succeeds.
    builder.follow_symlinks(false);
    if let Some((path, name)) = repository {
        let bytes = archive_repository::encode(&options.workspace_path, path, name)?;
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        builder.append_data(&mut header, archive_repository::MEMBER, bytes.as_slice())?;
    }
    let mut contents = ArchiveContents::default();
    let mut member_count = 0usize;
    let managed_roots = [
        roots.executor.clone(),
        roots.workbench.clone(),
        roots.claude.clone(),
        roots.codex.clone(),
        roots.legacy_executor.clone(),
    ];
    archive_stage(&options.task_id, "pack_sessions", || {
        for (member, source) in &sessions {
            builder.append_path_with_name(source, member)?;
            member_count += 1;
            if member.starts_with("executor-state") {
                contents.session_file_included = true;
            }
        }
        Ok(())
    })?;

    if options.home_path.exists() {
        member_count += append_tree(
            &mut builder,
            ArchiveTreeContext {
                source_root: &options.home_path,
                archive_root: Path::new("home"),
                kind: TreeKind::Home,
                mode: options.mode,
                task_id: &options.task_id,
                excluded_roots: &managed_roots,
            },
            &mut contents,
        )?;
    }

    if options.workspace_path.is_dir() {
        member_count += append_tree(
            &mut builder,
            ArchiveTreeContext {
                source_root: &options.workspace_path,
                archive_root: Path::new("workspace"),
                kind: TreeKind::Workspace,
                mode: options.mode,
                task_id: &options.task_id,
                excluded_roots: &[],
            },
            &mut contents,
        )?;
    }
    if let Some((path, name)) = repository {
        member_count += append_tree(
            &mut builder,
            ArchiveTreeContext {
                source_root: path,
                archive_root: &Path::new("workspace").join(name),
                kind: TreeKind::Workspace,
                mode: options.mode,
                task_id: &options.task_id,
                excluded_roots: &[],
            },
            &mut contents,
        )?;
    }
    if options.mode == ArchiveMode::Sandbox && member_count == 0 {
        return Err(ArchiveError::EmptyArchiveRoots {
            workspace_path: options.workspace_path,
            home_path: options.home_path,
        });
    }

    let bytes = archive_stage(&options.task_id, "finish_compression", || {
        Ok(builder.into_inner()?.finish()?)
    })?;
    log_executor_event(
        "archive packed",
        &[
            ("task_id", options.task_id.clone()),
            ("entries", member_count.to_string()),
            ("session_entries", sessions.len().to_string()),
            ("compressed_bytes", bytes.len().to_string()),
        ],
    );
    if bytes.len() as u64 > options.max_size_bytes {
        return Err(ArchiveError::TooLarge {
            actual: bytes.len() as u64,
            max: options.max_size_bytes,
        });
    }

    Ok(RuntimeArchive {
        bytes,
        session_file_included: contents.session_file_included,
        git_included: contents.git_included,
    })
}

pub fn restore_runtime_archive(
    bytes: &[u8],
    mode: ArchiveMode,
    task_id: &str,
    workspace_path: &Path,
    home_path: &Path,
) -> Result<RestoreResult, ArchiveError> {
    restore_runtime_archive_with_roots(
        bytes,
        mode,
        task_id,
        workspace_path,
        home_path,
        &SessionArchiveRoots::for_home(home_path),
    )
}

pub fn restore_runtime_archive_with_roots(
    bytes: &[u8],
    mode: ArchiveMode,
    task_id: &str,
    workspace_path: &Path,
    home_path: &Path,
    roots: &SessionArchiveRoots,
) -> Result<RestoreResult, ArchiveError> {
    fs::create_dir_all(workspace_path)?;
    fs::create_dir_all(home_path)?;

    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = Archive::new(decoder);
    let mut session_restored = false;
    let mut git_restored = false;
    let mut repository = None;

    for (index, entry) in archive.entries()?.enumerate() {
        let mut entry = entry?;
        let entry_type = entry.header().entry_type();
        let path = entry.path()?.to_path_buf();
        if path == Path::new(archive_repository::MEMBER) {
            if index != 0 || !entry_type.is_file() || entry.size() > 4096 {
                return Err(std::io::Error::other("Invalid repository archive metadata").into());
            }
            let mut metadata = Vec::new();
            entry.read_to_end(&mut metadata)?;
            repository = Some(archive_repository::decode(
                &metadata,
                workspace_path,
                task_id,
            )?);
            continue;
        }
        if !is_restorable_entry(entry_type) {
            continue;
        }

        let portable = [
            "executor-state",
            "agent-homes",
            "native-claude",
            "native-codex",
        ]
        .iter()
        .any(|prefix| path.starts_with(prefix));
        let session_member =
            is_session_archive_member(&path, task_id) || path.starts_with("executor-state");
        if session_member && !entry_type.is_file() {
            continue;
        }
        if portable && !entry_type.is_file() {
            continue;
        }
        let Some(mut destination) = roots
            .destination(&path, task_id)
            .map(|path| Destination { path })
            .or_else(|| {
                if portable {
                    None
                } else {
                    destination_for_member(&path, mode, task_id, workspace_path, home_path)
                }
            })
        else {
            continue;
        };
        if let Some(binding) = &repository {
            if let Ok(relative) = destination
                .path
                .strip_prefix(workspace_path.join(&binding.name))
            {
                destination.path = workspace_path
                    .parent()
                    .unwrap()
                    .join(&binding.key)
                    .join(relative);
            }
        }
        if has_component(&path, ".git") {
            git_restored = true;
        }

        if let Some(parent) = destination.path.parent() {
            let bases: [&Path; 7] = [
                &roots.executor,
                &roots.workbench,
                &roots.claude,
                &roots.codex,
                workspace_path,
                home_path,
                // Shared repository members have already been validated and remapped.
                repository
                    .as_ref()
                    .map_or(workspace_path, |_| workspace_path.parent().unwrap()),
            ];
            let base = bases
                .into_iter()
                .filter(|root| destination.path.starts_with(root))
                .max_by_key(|root| root.components().count())
                .ok_or_else(|| std::io::Error::other("Archive destination has no runtime root"))?;
            reject_symlink_ancestors(parent, base)?;
            fs::create_dir_all(parent)?;
        }
        if fs::symlink_metadata(&destination.path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(std::io::Error::other("Refusing to restore over a symlink").into());
        }
        entry.unpack(&destination.path)?;
        if session_member {
            if is_valid_session_marker_file(&destination.path) {
                session_restored = true;
            } else {
                let _ = fs::remove_file(&destination.path);
            }
        }
    }

    if session_restored {
        roots.collect(task_id)?;
    }
    if let Some(binding) = &repository {
        archive_repository::publish(binding, workspace_path, task_id)?;
        log_executor_event(
            "archive repository restored",
            &[
                ("task_id", task_id.to_owned()),
                (
                    "repository_path",
                    workspace_path
                        .parent()
                        .unwrap()
                        .join(&binding.key)
                        .display()
                        .to_string(),
                ),
            ],
        );
    }
    Ok(RestoreResult {
        success: true,
        session_restored,
        git_restored,
    })
}

fn reject_symlink_ancestors(path: &Path, root: &Path) -> Result<(), ArchiveError> {
    for parent in path.ancestors().take_while(|parent| *parent != root) {
        if fs::symlink_metadata(parent).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(std::io::Error::other("Archive destination contains a symlink").into());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TreeKind {
    Workspace,
    Home,
}

struct Destination {
    path: PathBuf,
}

#[derive(Clone, Copy)]
struct ArchiveTreeContext<'a> {
    source_root: &'a Path,
    archive_root: &'a Path,
    kind: TreeKind,
    mode: ArchiveMode,
    task_id: &'a str,
    excluded_roots: &'a [PathBuf],
}

#[derive(Default)]
struct ArchiveContents {
    session_file_included: bool,
    git_included: bool,
}

fn append_tree(
    builder: &mut Builder<GzEncoder<Vec<u8>>>,
    context: ArchiveTreeContext<'_>,
    contents: &mut ArchiveContents,
) -> Result<usize, ArchiveError> {
    let phase = match context.kind {
        TreeKind::Home => "pack_home",
        TreeKind::Workspace if context.archive_root == Path::new("workspace") => "pack_workspace",
        TreeKind::Workspace => "pack_repository",
    };
    archive_stage(context.task_id, phase, || {
        let mut member_count = 0;
        for path in collect_direct_children(context.source_root)? {
            let relative = path.strip_prefix(context.source_root).unwrap_or(&path);
            if should_skip_archive_member(context.kind, context.mode, context.task_id, relative) {
                continue;
            }

            member_count += append_path_recursive(builder, &path, context, contents)?;
        }
        log_executor_event(
            "archive tree packed",
            &[
                ("task_id", context.task_id.to_owned()),
                ("phase", phase.to_owned()),
                ("entries", member_count.to_string()),
            ],
        );
        Ok(member_count)
    })
}

fn archive_stage<T>(
    task_id: &str,
    phase: &str,
    operation: impl FnOnce() -> Result<T, ArchiveError>,
) -> Result<T, ArchiveError> {
    let started = Instant::now();
    let mut fields = vec![("task_id", task_id.to_owned()), ("phase", phase.to_owned())];
    log_executor_event("archive stage started", &fields);
    let result = operation();
    fields.push(("elapsed_ms", started.elapsed().as_millis().to_string()));
    fields.push(("success", result.is_ok().to_string()));
    log_executor_event("archive stage finished", &fields);
    result
}

fn collect_direct_children(root: &Path) -> Result<Vec<PathBuf>, ArchiveError> {
    let mut children = fs::read_dir(root)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    children.sort();
    Ok(children)
}

fn append_path_recursive(
    builder: &mut Builder<GzEncoder<Vec<u8>>>,
    path: &Path,
    context: ArchiveTreeContext<'_>,
    contents: &mut ArchiveContents,
) -> Result<usize, ArchiveError> {
    if context
        .excluded_roots
        .iter()
        .any(|root| path.starts_with(root))
    {
        return Ok(0);
    }
    let relative = path.strip_prefix(context.source_root).unwrap_or(path);
    if should_skip_archive_member(context.kind, context.mode, context.task_id, relative) {
        return Ok(0);
    }

    let metadata = fs::symlink_metadata(path)?;
    let archive_path = context.archive_root.join(relative);
    let session_member = is_session_relative_path(context.kind, relative, context.task_id);
    if session_member && (!metadata.is_file() || !is_valid_session_marker_file(path)) {
        return Ok(0);
    }
    if has_component(relative, ".git") {
        contents.git_included = true;
    }
    if metadata.is_file() || metadata.file_type().is_symlink() {
        if session_member {
            contents.session_file_included = true;
        }
        builder.append_path_with_name(path, archive_path)?;
        return Ok(1);
    }
    if !metadata.is_dir() {
        return Ok(0);
    }

    builder.append_dir(&archive_path, path)?;
    let mut member_count = 1;
    for child in collect_direct_children(path)? {
        member_count += append_path_recursive(builder, &child, context, contents)?;
    }
    Ok(member_count)
}

fn destination_for_member(
    member: &Path,
    mode: ArchiveMode,
    task_id: &str,
    workspace_path: &Path,
    home_path: &Path,
) -> Option<Destination> {
    let clean = clean_relative_path(member)?;
    let (kind, relative) = split_member(&clean);

    if should_skip_restore_member(kind, mode, task_id, &relative) {
        return None;
    }

    let base = match kind {
        TreeKind::Workspace => workspace_path,
        TreeKind::Home => home_path,
    };

    Some(Destination {
        path: base.join(&relative),
    })
}

fn split_member(path: &Path) -> (TreeKind, PathBuf) {
    if let Ok(relative) = path.strip_prefix("workspace") {
        return (TreeKind::Workspace, relative.to_owned());
    }
    if let Ok(relative) = path.strip_prefix("home") {
        return (TreeKind::Home, relative.to_owned());
    }
    if let Ok(relative) = path.strip_prefix("__home__") {
        return (TreeKind::Home, relative.to_owned());
    }
    (TreeKind::Workspace, path.to_owned())
}

fn should_skip_archive_member(
    kind: TreeKind,
    mode: ArchiveMode,
    task_id: &str,
    relative: &Path,
) -> bool {
    if relative.as_os_str().is_empty() {
        return true;
    }
    // Managed homes are collected by task, including their native session files.
    if kind == TreeKind::Home
        && [
            ".wegent",
            ".wegent-executor",
            ".claude",
            ".claude.json",
            ".codex",
        ]
        .iter()
        .any(|root| relative.starts_with(root))
    {
        return true;
    }
    if kind == TreeKind::Home
        && mode == ArchiveMode::Executor
        && !is_executor_home_allowed(relative, task_id)
    {
        return true;
    }
    should_exclude_archive_path(relative)
}

fn should_skip_restore_member(
    kind: TreeKind,
    mode: ArchiveMode,
    task_id: &str,
    relative: &Path,
) -> bool {
    if relative.as_os_str().is_empty() || should_exclude_archive_path(relative) {
        return true;
    }
    kind == TreeKind::Home
        && mode == ArchiveMode::Executor
        && !is_executor_home_allowed(relative, task_id)
}

fn is_executor_home_allowed(relative: &Path, task_id: &str) -> bool {
    if relative.components().next().is_some_and(|component| {
        component.as_os_str() == ".claude" || component.as_os_str() == ".claude.json"
    }) {
        return true;
    }

    let executor_root = Path::new(".wegent-executor");
    let sessions_root = executor_root.join("sessions");
    let task_session_root = sessions_root.join(task_id);
    relative == executor_root
        || relative == sessions_root
        || relative == task_session_root
        || relative
            .parent()
            .is_some_and(|parent| parent == task_session_root)
            && relative.file_name().is_some_and(is_session_marker_name)
}

fn should_exclude_archive_path(relative: &Path) -> bool {
    let normalized = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if normalized == ".local/share/code-server"
        || normalized.starts_with(".local/share/code-server/")
    {
        return true;
    }
    relative.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        matches!(
            value.as_ref(),
            "node_modules"
                | "__pycache__"
                | ".venv"
                | "venv"
                | "target"
                | "build"
                | "dist"
                | ".next"
                | ".nuxt"
                | ".npm"
                | ".pnpm-store"
                | ".yarn"
                | "vendor"
                | ".cache"
        ) || value.ends_with(".pyc")
            || value.ends_with(".log")
    })
}

fn clean_relative_path(path: &Path) -> Option<PathBuf> {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => clean.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(clean)
}

fn is_restorable_entry(entry_type: EntryType) -> bool {
    entry_type.is_file() || entry_type.is_dir() || entry_type.is_symlink()
}

fn is_session_archive_member(path: &Path, task_id: &str) -> bool {
    let Some(clean) = clean_relative_path(path) else {
        return false;
    };
    let (kind, relative) = split_member(&clean);
    is_session_relative_path(kind, &relative, task_id)
}

fn is_session_relative_path(kind: TreeKind, relative: &Path, task_id: &str) -> bool {
    match kind {
        TreeKind::Workspace => {
            relative
                .parent()
                .is_some_and(|parent| parent.as_os_str().is_empty())
                && relative.file_name().is_some_and(is_session_marker_name)
        }
        TreeKind::Home => {
            let task_session_root = Path::new(".wegent-executor").join("sessions").join(task_id);
            relative
                .parent()
                .is_some_and(|parent| parent == task_session_root)
                && relative.file_name().is_some_and(is_session_marker_name)
        }
    }
}

pub(super) fn is_session_marker_name(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    [".claude_session_id", ".codex_thread_id"]
        .iter()
        .any(|marker| {
            name == *marker
                || name
                    .strip_prefix(&format!("{marker}_"))
                    .is_some_and(|suffix| {
                        !suffix.is_empty()
                            && suffix.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
                            })
                    })
        })
}

fn is_valid_session_marker_file(path: &Path) -> bool {
    fs::read_to_string(path)
        .ok()
        .is_some_and(|value| is_valid_session_identifier(value.trim()))
}

fn is_valid_session_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn has_component(path: &Path, component: &str) -> bool {
    path.components()
        .any(|value| value.as_os_str() == component)
}

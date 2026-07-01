// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::Cursor,
    path::{Component, Path, PathBuf},
};

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
    if options.mode == ArchiveMode::Executor && !options.workspace_path.is_dir() {
        return Err(ArchiveError::MissingWorkspace(options.workspace_path));
    }
    if options.mode == ArchiveMode::Sandbox
        && !options.workspace_path.is_dir()
        && !options.home_path.is_dir()
    {
        return Err(ArchiveError::EmptyArchiveRoots {
            workspace_path: options.workspace_path,
            home_path: options.home_path,
        });
    }

    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = Builder::new(encoder);
    let mut session_file_included = false;
    let mut git_included = false;
    let mut member_count = 0usize;

    if options.home_path.exists() {
        member_count += append_tree(
            &mut builder,
            &options.home_path,
            Path::new("home"),
            TreeKind::Home,
            options.mode,
            &mut session_file_included,
            &mut git_included,
        )?;
    }

    if options.workspace_path.is_dir() {
        member_count += append_tree(
            &mut builder,
            &options.workspace_path,
            Path::new("workspace"),
            TreeKind::Workspace,
            options.mode,
            &mut session_file_included,
            &mut git_included,
        )?;
    }
    if options.mode == ArchiveMode::Sandbox && member_count == 0 {
        return Err(ArchiveError::EmptyArchiveRoots {
            workspace_path: options.workspace_path,
            home_path: options.home_path,
        });
    }

    let bytes = builder.into_inner()?.finish()?;
    if bytes.len() as u64 > options.max_size_bytes {
        return Err(ArchiveError::TooLarge {
            actual: bytes.len() as u64,
            max: options.max_size_bytes,
        });
    }

    Ok(RuntimeArchive {
        bytes,
        session_file_included,
        git_included,
    })
}

pub fn restore_runtime_archive(
    bytes: &[u8],
    mode: ArchiveMode,
    workspace_path: &Path,
    home_path: &Path,
) -> Result<RestoreResult, ArchiveError> {
    fs::create_dir_all(workspace_path)?;
    fs::create_dir_all(home_path)?;

    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = Archive::new(decoder);
    let mut session_restored = false;
    let mut git_restored = false;

    for entry in archive.entries()? {
        let mut entry = entry?;
        if !is_restorable_entry(entry.header().entry_type()) {
            continue;
        }

        let path = entry.path()?.to_path_buf();
        if is_session_archive_member(&path) {
            session_restored = true;
        }
        if has_component(&path, ".git") {
            git_restored = true;
        }
        let Some(destination) = destination_for_member(&path, mode, workspace_path, home_path)
        else {
            continue;
        };

        if let Some(parent) = destination.path.parent() {
            fs::create_dir_all(parent)?;
        }
        entry.unpack(&destination.path)?;

        let _ = destination;
    }

    Ok(RestoreResult {
        success: true,
        session_restored,
        git_restored,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TreeKind {
    Workspace,
    Home,
}

struct Destination {
    path: PathBuf,
}

fn append_tree(
    builder: &mut Builder<GzEncoder<Vec<u8>>>,
    source_root: &Path,
    archive_root: &Path,
    kind: TreeKind,
    mode: ArchiveMode,
    session_file_included: &mut bool,
    git_included: &mut bool,
) -> Result<usize, ArchiveError> {
    let mut member_count = 0;
    for path in collect_direct_children(source_root)? {
        let relative = path.strip_prefix(source_root).unwrap_or(&path);
        if should_skip_archive_member(kind, mode, relative) {
            continue;
        }

        if relative
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".claude_session_id"))
        {
            *session_file_included = true;
        }
        if relative.file_name().is_some_and(|name| name == ".git") {
            *git_included = true;
        }

        member_count +=
            append_path_recursive(builder, source_root, &path, archive_root, kind, mode)?;
    }
    Ok(member_count)
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
    source_root: &Path,
    path: &Path,
    archive_root: &Path,
    kind: TreeKind,
    mode: ArchiveMode,
) -> Result<usize, ArchiveError> {
    let relative = path.strip_prefix(source_root).unwrap_or(path);
    if should_skip_archive_member(kind, mode, relative) {
        return Ok(0);
    }

    let metadata = fs::symlink_metadata(path)?;
    let archive_path = archive_root.join(relative);
    if metadata.is_file() || metadata.file_type().is_symlink() {
        builder.append_path_with_name(path, archive_path)?;
        return Ok(1);
    }
    if !metadata.is_dir() {
        return Ok(0);
    }

    builder.append_dir(&archive_path, path)?;
    let mut member_count = 1;
    for child in collect_direct_children(path)? {
        member_count +=
            append_path_recursive(builder, source_root, &child, archive_root, kind, mode)?;
    }
    Ok(member_count)
}

fn destination_for_member(
    member: &Path,
    mode: ArchiveMode,
    workspace_path: &Path,
    home_path: &Path,
) -> Option<Destination> {
    let clean = clean_relative_path(member)?;
    let (kind, relative) = split_member(&clean);

    if should_skip_restore_member(kind, mode, &relative) {
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

fn should_skip_archive_member(kind: TreeKind, mode: ArchiveMode, relative: &Path) -> bool {
    if relative.as_os_str().is_empty() {
        return true;
    }
    if kind == TreeKind::Home
        && mode == ArchiveMode::Executor
        && !is_executor_home_allowed(relative)
    {
        return true;
    }
    should_exclude_archive_path(relative)
}

fn should_skip_restore_member(kind: TreeKind, mode: ArchiveMode, relative: &Path) -> bool {
    if relative.as_os_str().is_empty() || should_exclude_archive_path(relative) {
        return true;
    }
    kind == TreeKind::Home && mode == ArchiveMode::Executor && !is_executor_home_allowed(relative)
}

fn is_executor_home_allowed(relative: &Path) -> bool {
    relative.components().next().is_some_and(|component| {
        component.as_os_str() == ".claude" || component.as_os_str() == ".claude.json"
    })
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

fn is_session_archive_member(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with(".claude_session_id"))
}

fn has_component(path: &Path, component: &str) -> bool {
    path.components()
        .any(|value| value.as_os_str() == component)
}

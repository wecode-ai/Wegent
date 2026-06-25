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
    #[error("archive exceeds maximum size: {actual} > {max}")]
    TooLarge { actual: u64, max: u64 },
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub fn create_runtime_archive(options: ArchiveOptions) -> Result<RuntimeArchive, ArchiveError> {
    if !options.workspace_path.is_dir() {
        return Err(ArchiveError::MissingWorkspace(options.workspace_path));
    }

    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = Builder::new(encoder);
    let mut session_file_included = false;
    let mut git_included = false;

    append_tree(
        &mut builder,
        &options.workspace_path,
        Path::new("workspace"),
        TreeKind::Workspace,
        options.mode,
        &mut session_file_included,
        &mut git_included,
    )?;

    if options.home_path.exists() {
        append_tree(
            &mut builder,
            &options.home_path,
            Path::new("home"),
            TreeKind::Home,
            options.mode,
            &mut session_file_included,
            &mut git_included,
        )?;
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
        let Some(destination) = destination_for_member(&path, mode, workspace_path, home_path)
        else {
            continue;
        };

        if let Some(parent) = destination.path.parent() {
            fs::create_dir_all(parent)?;
        }
        entry.unpack(&destination.path)?;

        if destination.kind == TreeKind::Workspace {
            if destination.relative == Path::new(".claude_session_id") {
                session_restored = true;
            }
            if starts_with_component(&destination.relative, ".git") {
                git_restored = true;
            }
        }
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
    kind: TreeKind,
    relative: PathBuf,
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
) -> Result<(), ArchiveError> {
    for path in collect_files(source_root)? {
        let relative = path.strip_prefix(source_root).unwrap_or(&path);
        if should_skip(kind, mode, relative) {
            continue;
        }

        if kind == TreeKind::Workspace && relative == Path::new(".claude_session_id") {
            *session_file_included = true;
        }
        if kind == TreeKind::Workspace && starts_with_component(relative, ".git") {
            *git_included = true;
        }

        builder.append_path_with_name(&path, archive_root.join(relative))?;
    }
    Ok(())
}

fn collect_files(root: &Path) -> Result<Vec<PathBuf>, ArchiveError> {
    let mut files = Vec::new();
    collect_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), ArchiveError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_file() {
        files.push(path.to_owned());
        return Ok(());
    }
    if !metadata.is_dir() {
        return Ok(());
    }

    let mut children = fs::read_dir(path)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    children.sort();
    for child in children {
        collect_files_inner(&child, files)?;
    }
    Ok(())
}

fn destination_for_member(
    member: &Path,
    mode: ArchiveMode,
    workspace_path: &Path,
    home_path: &Path,
) -> Option<Destination> {
    let clean = clean_relative_path(member)?;
    let (kind, relative) = split_member(&clean);

    if should_skip(kind, mode, &relative) {
        return None;
    }

    let base = match kind {
        TreeKind::Workspace => workspace_path,
        TreeKind::Home => home_path,
    };

    Some(Destination {
        kind,
        path: base.join(&relative),
        relative,
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

fn should_skip(kind: TreeKind, mode: ArchiveMode, relative: &Path) -> bool {
    if relative.as_os_str().is_empty() {
        return true;
    }

    match kind {
        TreeKind::Workspace => {
            has_component(relative, "node_modules")
                || has_component(relative, ".venv")
                || has_component(relative, "target")
        }
        TreeKind::Home => match mode {
            ArchiveMode::Executor => !is_executor_home_allowed(relative),
            ArchiveMode::Sandbox => is_unsafe_home_path(relative),
        },
    }
}

fn is_executor_home_allowed(relative: &Path) -> bool {
    relative == Path::new(".claude.json") || starts_with_component(relative, ".claude")
}

fn is_unsafe_home_path(relative: &Path) -> bool {
    has_component(relative, ".cache")
        || has_component(relative, ".ssh")
        || has_component(relative, "node_modules")
        || starts_with_component(relative, ".npm")
        || relative == Path::new(".npmrc")
        || relative.starts_with(Path::new(".local/share/code-server"))
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
    entry_type.is_file() || entry_type.is_dir()
}

fn starts_with_component(path: &Path, component: &str) -> bool {
    path.components()
        .next()
        .is_some_and(|value| value.as_os_str() == component)
}

fn has_component(path: &Path, component: &str) -> bool {
    path.components()
        .any(|value| value.as_os_str() == component)
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Content-addressed packages shared by desktop sync and task preparation.
//! Published directories are never rewritten or garbage-collected by installers.

use std::{
    collections::BTreeSet,
    env, fs,
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_FILES: usize = 10_000;
const MAX_EXPANDED_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct PublishedPackage {
    pub path: PathBuf,
    pub archive_hash: String,
}

#[derive(Clone, Copy, Debug)]
pub enum PackageKind {
    Skill,
    Plugin,
}

impl PackageKind {
    fn directory(self) -> &'static str {
        match self {
            Self::Skill => "skills",
            Self::Plugin => "plugins",
        }
    }

    fn root_for(self, path: &Path) -> Option<PathBuf> {
        let marker = match self {
            Self::Skill if path.ends_with("SKILL.md") => Path::new("SKILL.md"),
            Self::Plugin if path.ends_with(".codex-plugin/plugin.json") => {
                Path::new(".codex-plugin/plugin.json")
            }
            Self::Plugin if path.ends_with(".claude-plugin/plugin.json") => {
                Path::new(".claude-plugin/plugin.json")
            }
            _ => return None,
        };
        let mut root = path.to_owned();
        for _ in marker.components() {
            root.pop();
        }
        Some(root)
    }
}

/// Use the current user's Workbench root unless startup supplies an explicit root.
pub fn workbench_root() -> Result<PathBuf, String> {
    resolve_workbench_root(
        env::var_os("WEGENT_WORKBENCH_HOME")
            .filter(|value| !value.to_string_lossy().trim().is_empty())
            .map(PathBuf::from),
        dirs::home_dir(),
    )
}

fn resolve_workbench_root(
    explicit: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf, String> {
    let path = explicit
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| home.map(|path| path.join(".wegent/workbench")))
        .ok_or("Unable to resolve Workbench home")?;
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err("Workbench home must be an absolute path without parent traversal".into());
    }
    Ok(path)
}

pub fn archive_hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub fn validate_archive_hash(bytes: &[u8], expected: Option<&str>) -> Result<String, String> {
    let actual = archive_hash(bytes);
    if let Some(expected) = expected {
        let expected = expected.trim().trim_matches('"');
        let digest = expected.strip_prefix("sha256:").unwrap_or(expected);
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid package SHA256 digest".into());
        }
        if !actual[7..].eq_ignore_ascii_case(digest) {
            return Err("Package archive SHA256 mismatch".into());
        }
    }
    Ok(actual)
}

pub fn publish_skill_archive(
    root: &Path,
    bytes: &[u8],
    expected_hash: Option<&str>,
) -> Result<PublishedPackage, String> {
    publish_package(root, PackageKind::Skill, bytes, expected_hash)
}

/// Extract into a caller-owned staging location without touching the global store.
pub fn stage_skill_archive(
    bytes: &[u8],
    target: &Path,
    expected: Option<&str>,
) -> Result<(), String> {
    skill_version_hash(bytes, expected)?;
    if target.exists() || target.is_symlink() {
        return Err("Skill staging destination is already occupied".into());
    }
    let parent = target
        .parent()
        .ok_or("Skill staging destination has no parent")?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let staging = tempfile::tempdir_in(parent).map_err(io_error)?;
    extract_archive(bytes, staging.path(), PackageKind::Skill)?;
    fs::rename(staging.path(), target).map_err(io_error)
}

pub fn publish_plugin_archive(
    root: &Path,
    bytes: &[u8],
    expected_hash: Option<&str>,
) -> Result<PublishedPackage, String> {
    publish_package(root, PackageKind::Plugin, bytes, expected_hash)
}

#[derive(Serialize, Deserialize)]
struct PackageRecord {
    archive_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    files_hash: Option<String>,
}

fn skill_version_hash(bytes: &[u8], version: Option<&str>) -> Result<String, String> {
    let Some(version) = version else {
        // Local imports have no server version; assign a content-addressed identity.
        return Ok(archive_hash(bytes));
    };
    let version = version.trim().trim_matches('"');
    let digest = version.strip_prefix("sha256:").unwrap_or(version);
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid package SHA256 digest".into());
    }
    Ok(format!("sha256:{}", digest.to_ascii_lowercase()))
}

pub fn verify_published_package(
    root: &Path,
    kind: PackageKind,
    hash: &str,
) -> Result<PublishedPackage, String> {
    let digest = hash.strip_prefix("sha256:").unwrap_or(hash);
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid package SHA256 digest".into());
    }
    let digest = digest.to_ascii_lowercase();
    let hash = format!("sha256:{digest}");
    let shared = root.join("shared");
    let destination = shared.join(kind.directory()).join(&digest);
    let record_path = shared
        .join("metadata")
        .join(format!("{}-{digest}.json", kind.directory()));
    let record: PackageRecord = serde_json::from_slice(&fs::read(record_path).map_err(io_error)?)
        .map_err(|error| format!("Invalid package record: {error}"))?;
    if record.archive_hash != hash
        || destination.is_symlink()
        || !destination.is_dir()
        || match kind {
            PackageKind::Skill => !destination.join("SKILL.md").is_file(),
            PackageKind::Plugin => {
                record.files_hash.as_deref() != Some(files_hash(&destination)?.as_str())
            }
        }
    {
        return Err("Published package integrity check failed; refusing to rewrite it".into());
    }
    Ok(PublishedPackage {
        path: destination,
        archive_hash: hash,
    })
}

pub fn publish_package(
    root: &Path,
    kind: PackageKind,
    bytes: &[u8],
    expected_hash: Option<&str>,
) -> Result<PublishedPackage, String> {
    let hash = match kind {
        PackageKind::Skill => skill_version_hash(bytes, expected_hash)?,
        PackageKind::Plugin => validate_archive_hash(bytes, expected_hash)?,
    };
    let shared = root.join("shared");
    let destination = shared.join(kind.directory()).join(&hash[7..]);
    let lock_dir = shared.join("locks");
    fs::create_dir_all(&lock_dir).map_err(io_error)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_dir.join(format!("{}-{}.lock", kind.directory(), &hash[7..])))
        .map_err(io_error)?;
    lock.lock_exclusive().map_err(io_error)?;
    let metadata_dir = shared.join("metadata");
    fs::create_dir_all(&metadata_dir).map_err(io_error)?;
    let record_path = metadata_dir.join(format!("{}-{}.json", kind.directory(), &hash[7..]));
    if destination.exists() || destination.is_symlink() {
        verify_published_package(root, kind, &hash)?;
    } else {
        let staging_dir = shared.join("staging");
        fs::create_dir_all(&staging_dir).map_err(io_error)?;
        let staging = tempfile::tempdir_in(&staging_dir).map_err(io_error)?;
        extract_archive(bytes, staging.path(), kind)?;
        let record = PackageRecord {
            archive_hash: hash.clone(),
            files_hash: match kind {
                PackageKind::Skill => None,
                PackageKind::Plugin => Some(files_hash(staging.path())?),
            },
        };
        // The journal precedes publication; a crash can leave only an unused record.
        let mut temporary = tempfile::NamedTempFile::new_in(&metadata_dir).map_err(io_error)?;
        serde_json::to_writer(&mut temporary, &record).map_err(|error| error.to_string())?;
        temporary.flush().map_err(io_error)?;
        temporary.as_file().sync_all().map_err(io_error)?;
        temporary
            .persist(&record_path)
            .map_err(|error| io_error(error.error))?;
        fs::create_dir_all(destination.parent().ok_or("Invalid package destination")?)
            .map_err(io_error)?;
        fs::rename(staging.path(), &destination).map_err(io_error)?;
    }
    Ok(PublishedPackage {
        path: destination,
        archive_hash: hash,
    })
}

fn io_error(error: std::io::Error) -> String {
    format!("Workbench package I/O error: {error}")
}

fn safe_entry_path(name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    if name.is_empty()
        || name.contains(['\\', ':', '\0'])
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Unsafe archive entry path".into());
    }
    Ok(path.to_owned())
}

fn extract_archive(bytes: &[u8], target: &Path, kind: PackageKind) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    if archive.len() > MAX_FILES {
        return Err("Package contains too many entries".into());
    }
    let mut names = BTreeSet::new();
    let mut roots = BTreeSet::new();
    let mut entries = Vec::new();
    let mut size = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        let path = safe_entry_path(file.name().trim_end_matches('/'))?;
        let mode = file.unix_mode().unwrap_or(0);
        let file_type = mode & 0o170000;
        if !matches!(file_type, 0 | 0o040000 | 0o100000) {
            return Err("Archive links and special files are not permitted".into());
        }
        if !names.insert(path.to_string_lossy().to_lowercase()) {
            return Err("Duplicate archive entry path".into());
        }
        if file.is_dir()
            || path.components().any(|part| {
                let name = part.as_os_str().to_string_lossy();
                name == "__MACOSX" || name.starts_with("._")
            })
        {
            continue;
        }
        let remaining = MAX_EXPANDED_BYTES.saturating_sub(size);
        if file.size() > remaining {
            return Err("Expanded package is too large".into());
        }
        let mut content = Vec::new();
        file.by_ref()
            .take(remaining + 1)
            .read_to_end(&mut content)
            .map_err(io_error)?;
        size += content.len() as u64;
        if size > MAX_EXPANDED_BYTES {
            return Err("Expanded package is too large".into());
        }
        if let Some(root) = kind.root_for(&path) {
            roots.insert(root);
        }
        entries.push((path, content, mode));
    }
    let depth = roots
        .iter()
        .map(|path| path.components().count())
        .min()
        .ok_or("Package is missing its skill or plugin manifest")?;
    let roots = roots
        .into_iter()
        .filter(|path| path.components().count() == depth)
        .collect::<Vec<_>>();
    if roots.len() != 1 {
        return Err("Package has ambiguous manifest roots".into());
    }
    for (path, content, mode) in entries {
        let Ok(relative) = path.strip_prefix(&roots[0]) else {
            continue;
        };
        let output = target.join(relative);
        fs::create_dir_all(output.parent().ok_or("Invalid package path")?).map_err(io_error)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(io_error)?;
        file.write_all(&content).map_err(io_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o644 | (mode & 0o111)))
                .map_err(io_error)?;
        }
    }
    Ok(())
}

fn files_hash(root: &Path) -> Result<String, String> {
    fn visit(root: &Path, path: &Path, digest: &mut Sha256) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err("Published packages cannot contain symbolic links".into());
        }
        if metadata.is_dir() {
            let mut entries = fs::read_dir(path)
                .map_err(io_error)?
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(io_error)?;
            entries.sort();
            for entry in entries {
                visit(root, &entry, digest)?;
            }
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy();
            digest.update((relative.len() as u64).to_le_bytes());
            digest.update(relative.as_bytes());
            digest.update(metadata.len().to_le_bytes());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                digest.update((metadata.permissions().mode() & 0o111).to_le_bytes());
            }
            let mut file = fs::File::open(path).map_err(io_error)?;
            let mut buffer = [0_u8; 8192];
            loop {
                let count = file.read(&mut buffer).map_err(io_error)?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
        } else {
            return Err("Published package contains a special file".into());
        }
        Ok(())
    }
    let mut digest = Sha256::new();
    visit(root, root, &mut digest)?;
    Ok(format!("sha256:{:x}", digest.finalize()))
}

/// Replace a managed symlink. Callers must establish ownership and exclude readers.
/// Unix replacement is atomic. Windows requires symlink privileges and briefly
/// moves the previous entry aside because rename cannot replace a directory link.
pub fn link_package(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or("Package link has no parent")?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let parent = fs::canonicalize(parent).map_err(io_error)?;
    let source = fs::canonicalize(source).map_err(io_error)?;
    let left = parent.components().collect::<Vec<_>>();
    let right = source.components().collect::<Vec<_>>();
    let common = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
    let relative = if common == 0 {
        source.clone()
    } else {
        let mut path = PathBuf::new();
        for _ in common..left.len() {
            path.push("..");
        }
        for part in &right[common..] {
            path.push(part.as_os_str());
        }
        path
    };
    let temporary = tempfile::tempdir_in(&parent).map_err(io_error)?;
    let link = temporary.path().join("entry");
    // Compute relative to the final parent, not the temporary staging directory.
    #[cfg(unix)]
    std::os::unix::fs::symlink(&relative, &link).map_err(io_error)?;
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&relative, &link).map_err(io_error)?;
    #[cfg(not(any(unix, windows)))]
    return Err("Package links are unsupported on this platform".into());
    #[cfg(windows)]
    if target.exists() || target.is_symlink() {
        if !target.is_symlink() {
            return Err("Package link destination is not a managed symbolic link".into());
        }
        // Stage the new link before touching the old entry, including privilege
        // checks. Restore by rename rather than recreating a privileged symlink.
        let backup = temporary.path().join("previous");
        fs::rename(target, &backup).map_err(io_error)?;
        if let Err(error) = fs::rename(&link, target) {
            if let Err(rollback) = fs::rename(&backup, target) {
                let retained = temporary.keep();
                return Err(format!(
                    "Package link replacement failed: {error}; rollback failed: {rollback}; original retained at {}",
                    retained.join("previous").display()
                ));
            }
            return Err(io_error(error));
        }
        return Ok(());
    }
    fs::rename(&link, target).map_err(io_error)
}

#[cfg(test)]
#[path = "workbench_tests.rs"]
mod tests;

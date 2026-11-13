// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Installation-only recovery of receipted, corrupt plugin packages.
//! Keep strict publication unchanged and retain the original bytes for diagnosis.

use super::*;
use std::{io, ops::Deref};

#[derive(Debug, thiserror::Error)]
pub(crate) enum PackageRecoveryError {
    #[error("Plugin package is in use by another preparation; retry installation")]
    Busy,
    #[error("{0}")]
    Invalid(String),
}

impl From<String> for PackageRecoveryError {
    fn from(error: String) -> Self {
        Self::Invalid(error)
    }
}

impl From<io::Error> for PackageRecoveryError {
    fn from(error: io::Error) -> Self {
        Self::Invalid(io_error(error))
    }
}

/// Runtime copies are independent; only preparation/recovery reads the shared tree.
/// Retain this lease until every copy and its installation transaction finishes.
#[derive(Debug)]
pub(crate) struct LeasedPluginPackage {
    package: PublishedPackage,
    _reader: FileLease,
}

impl Deref for LeasedPluginPackage {
    type Target = PublishedPackage;

    fn deref(&self) -> &Self::Target {
        &self.package
    }
}

fn normalized_hash(hash: &str) -> Result<String, String> {
    let digest = hash.strip_prefix("sha256:").unwrap_or(hash);
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid package SHA256 digest".into());
    }
    Ok(format!("sha256:{}", digest.to_ascii_lowercase()))
}

fn use_lease(root: &Path, hash: &str, exclusive: bool) -> Result<FileLease, PackageRecoveryError> {
    let hash = normalized_hash(hash)?;
    ensure_package_directories(root, PackageKind::Plugin)?;
    let path = root
        .join("shared/locks")
        .join(format!("plugins-{}.use.lock", &hash[7..]));
    if path.is_symlink() || (path.exists() && !path.is_file()) {
        return Err("Package reader lock must be a regular file"
            .to_owned()
            .into());
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    let result = if exclusive {
        FileExt::try_lock_exclusive(&file)
    } else {
        FileExt::try_lock_shared(&file)
    };
    result.map_err(|error| {
        if error.kind() == io::ErrorKind::WouldBlock
            || error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
        {
            PackageRecoveryError::Busy
        } else {
            PackageRecoveryError::from(error)
        }
    })?;
    Ok(FileLease(file))
}

pub(super) fn read_lease(root: &Path, hash: &str) -> Result<FileLease, PackageRecoveryError> {
    use_lease(root, hash, false)
}

pub(crate) fn read_plugin_package(
    root: &Path,
    hash: &str,
) -> Result<LeasedPluginPackage, PackageRecoveryError> {
    let hash = normalized_hash(hash)?;
    let reader = prepared_read_lease(root, &hash)?;
    let package = verify_published_package(root, PackageKind::Plugin, &hash)?;
    Ok(LeasedPluginPackage {
        package,
        _reader: reader,
    })
}

fn prepared_read_lease(root: &Path, hash: &str) -> Result<FileLease, PackageRecoveryError> {
    let reader = read_lease(root, hash)?;
    let paths = RecoveryPaths::new(root, hash);
    if occupied(&paths.pending) {
        drop(reader);
        let writer = use_lease(root, hash, true)?;
        let publication = lock_package(root, PackageKind::Plugin, hash)?;
        resume_pending(&paths)?;
        drop(publication);
        drop(writer);
        let reader = read_lease(root, hash)?;
        if occupied(&paths.pending) {
            return Err(PackageRecoveryError::Busy);
        }
        return Ok(reader);
    }
    Ok(reader)
}

pub(crate) fn prepare_plugin_archive(
    root: &Path,
    bytes: &[u8],
    expected_hash: Option<&str>,
    validate: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<LeasedPluginPackage, PackageRecoveryError> {
    let hash = validate_archive_hash(bytes, expected_hash)?;
    let reader = prepared_read_lease(root, &hash)?;
    let publish_error = match publish_plugin_archive(root, bytes, expected_hash) {
        Ok(package) => {
            return Ok(LeasedPluginPackage {
                package,
                _reader: reader,
            });
        }
        // An unchecksummed download cannot authorize replacement of existing data.
        Err(error) if expected_hash.is_none() => return Err(error.into()),
        Err(error) => error,
    };
    drop(reader);
    recover_plugin_archive(root, bytes, &hash, validate).map_err(|error| match error {
        PackageRecoveryError::Busy => PackageRecoveryError::Busy,
        PackageRecoveryError::Invalid(recovery) => PackageRecoveryError::Invalid(format!(
            "{publish_error}; package recovery failed: {recovery}"
        )),
    })
}

fn recover_plugin_archive(
    root: &Path,
    bytes: &[u8],
    hash: &str,
    validate: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<LeasedPluginPackage, PackageRecoveryError> {
    let staging = tempfile::tempdir_in(root.join("shared/staging"))?;
    extract_archive(bytes, staging.path(), PackageKind::Plugin)?;
    validate(staging.path())?;
    let writer = use_lease(root, hash, true)?;
    let publication = lock_package(root, PackageKind::Plugin, hash)?;
    let paths = RecoveryPaths::new(root, hash);
    resume_pending(&paths)?;
    if verify_published_package_locked(root, PackageKind::Plugin, hash).is_err() {
        replace_corrupt_package(&paths, staging.path())?;
    }
    drop(publication);
    drop(writer);
    read_plugin_package(root, hash)
}

struct RecoveryPaths {
    root: PathBuf,
    hash: String,
    package: PathBuf,
    metadata: PathBuf,
    history: PathBuf,
    pending: PathBuf,
}

impl RecoveryPaths {
    fn new(root: &Path, hash: &str) -> Self {
        let digest = &hash[7..];
        let history = root.join("shared/recovery/plugins").join(digest);
        Self {
            root: root.to_owned(),
            hash: hash.to_owned(),
            package: root.join("shared/plugins").join(digest),
            metadata: root
                .join("shared/metadata")
                .join(format!("plugins-{digest}.json")),
            pending: history.join("pending"),
            history,
        }
    }

    fn original_package(&self) -> PathBuf {
        self.pending.join("package")
    }

    fn original_metadata(&self) -> PathBuf {
        self.pending.join("metadata.json")
    }
}

#[derive(Serialize, Deserialize)]
struct RecoveryRecord {
    archive_hash: String,
    before_files_hash: String,
    before_metadata_hash: String,
    after_files_hash: String,
    after_metadata_hash: String,
}

fn occupied(path: &Path) -> bool {
    path.exists() || path.is_symlink()
}

fn safe_path(root: &Path, path: &Path) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err("Package recovery path escaped Workbench".into());
    }
    let mut cursor = path;
    loop {
        if cursor.is_symlink() {
            return Err("Package recovery cannot traverse symbolic links".into());
        }
        if cursor == root {
            return Ok(());
        }
        cursor = cursor.parent().ok_or("Invalid package recovery path")?;
    }
}

fn metadata_hash(path: &Path) -> Result<String, String> {
    if path.is_symlink() || !path.is_file() {
        return Err("Package recovery metadata must be a regular file".into());
    }
    Ok(archive_hash(&fs::read(path).map_err(io_error)?))
}

fn replace_corrupt_package(paths: &RecoveryPaths, staged: &Path) -> Result<(), String> {
    for path in [&paths.package, &paths.metadata, &paths.history] {
        safe_path(&paths.root, path)?;
    }
    // A matching receipt proves application ownership. Never adopt an unrecorded
    // directory, mismatched receipt, link, or special file as a repair candidate.
    read_package_record(&paths.root, PackageKind::Plugin, &paths.hash)?;
    if !paths.package.is_dir() {
        return Err("Package recovery requires a receipted ordinary directory".into());
    }
    let before_files_hash = files_hash(&paths.package)?;
    let before_metadata_hash = metadata_hash(&paths.metadata)?;
    let replacement = PackageRecord {
        archive_hash: paths.hash.clone(),
        files_hash: Some(files_hash(staged)?),
        published_bytecode_paths: Some(bytecode_paths(staged)?),
    };
    let bytes = serde_json::to_vec(&replacement).map_err(|error| error.to_string())?;
    let record = RecoveryRecord {
        archive_hash: paths.hash.clone(),
        before_files_hash,
        before_metadata_hash,
        after_files_hash: replacement.files_hash.unwrap(),
        after_metadata_hash: archive_hash(&bytes),
    };
    prepare_journal(paths, staged, &bytes, &record)?;
    if let Err(error) = publish_replacement(paths) {
        return match rollback_pending(paths, &record) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!(
                "{error}; package recovery retained at {}: {rollback}",
                paths.pending.display()
            )),
        };
    }
    archive_pending(paths, "recovered")
}

fn prepare_journal(
    paths: &RecoveryPaths,
    staged: &Path,
    metadata: &[u8],
    record: &RecoveryRecord,
) -> Result<(), String> {
    fs::create_dir_all(&paths.history).map_err(io_error)?;
    let journal = tempfile::tempdir_in(&paths.history).map_err(io_error)?;
    fs::rename(staged, journal.path().join("replacement")).map_err(io_error)?;
    write_synced(&journal.path().join("replacement.json"), metadata)?;
    write_synced(
        &journal.path().join("journal.json"),
        &serde_json::to_vec(record).map_err(|error| error.to_string())?,
    )?;
    sync_directory(journal.path())?;
    fs::rename(journal.path(), &paths.pending).map_err(io_error)?;
    sync_directory(&paths.history)
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(io_error)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn publish_replacement(paths: &RecoveryPaths) -> Result<(), String> {
    fs::rename(&paths.package, paths.original_package()).map_err(io_error)?;
    fs::rename(&paths.metadata, paths.original_metadata()).map_err(io_error)?;
    fs::rename(paths.pending.join("replacement.json"), &paths.metadata).map_err(io_error)?;
    fs::rename(paths.pending.join("replacement"), &paths.package).map_err(io_error)?;
    sync_directory(paths.package.parent().unwrap())?;
    sync_directory(paths.metadata.parent().unwrap())?;
    verify_published_package_locked(&paths.root, PackageKind::Plugin, &paths.hash)?;
    Ok(())
}

fn resume_pending(paths: &RecoveryPaths) -> Result<(), String> {
    safe_path(&paths.root, &paths.pending)?;
    if !occupied(&paths.pending) {
        return Ok(());
    }
    let journal = paths.pending.join("journal.json");
    safe_path(&paths.root, &journal)?;
    let record: RecoveryRecord = serde_json::from_slice(&fs::read(journal).map_err(io_error)?)
        .map_err(|error| format!("Invalid package recovery journal: {error}"))?;
    if record.archive_hash != paths.hash
        || [
            &record.before_files_hash,
            &record.before_metadata_hash,
            &record.after_files_hash,
            &record.after_metadata_hash,
        ]
        .into_iter()
        .any(|hash| normalized_hash(hash).as_ref() != Ok(hash))
    {
        return Err("Package recovery journal identity is invalid; preserving snapshots".into());
    }
    if matches_package(&paths.package, &record.after_files_hash)?
        && matches_metadata(&paths.metadata, &record.after_metadata_hash)?
    {
        verify_published_package_locked(&paths.root, PackageKind::Plugin, &paths.hash)?;
        archive_pending(paths, "recovered")
    } else {
        rollback_pending(paths, &record)
    }
}

fn matches_package(path: &Path, expected: &str) -> Result<bool, String> {
    if !occupied(path) {
        return Ok(false);
    }
    Ok(files_hash(path)? == expected)
}

fn matches_metadata(path: &Path, expected: &str) -> Result<bool, String> {
    if !occupied(path) {
        return Ok(false);
    }
    Ok(metadata_hash(path)? == expected)
}

fn rollback_pending(paths: &RecoveryPaths, record: &RecoveryRecord) -> Result<(), String> {
    for path in [
        paths.original_package(),
        paths.original_metadata(),
        paths.package.clone(),
        paths.metadata.clone(),
    ] {
        safe_path(&paths.root, &path)?;
    }
    let package = occupied(&paths.original_package());
    let metadata = occupied(&paths.original_metadata());
    check_restore(
        package,
        matches_package(&paths.original_package(), &record.before_files_hash)?,
        matches_package(&paths.package, &record.before_files_hash)?,
        matches_package(&paths.package, &record.after_files_hash)?,
        occupied(&paths.package),
    )?;
    check_restore(
        metadata,
        matches_metadata(&paths.original_metadata(), &record.before_metadata_hash)?,
        matches_metadata(&paths.metadata, &record.before_metadata_hash)?,
        matches_metadata(&paths.metadata, &record.after_metadata_hash)?,
        occupied(&paths.metadata),
    )?;
    if metadata {
        if occupied(&paths.metadata) {
            fs::remove_file(&paths.metadata).map_err(io_error)?;
        }
        fs::rename(paths.original_metadata(), &paths.metadata).map_err(io_error)?;
    }
    if package {
        if occupied(&paths.package) {
            fs::remove_dir_all(&paths.package).map_err(io_error)?;
        }
        fs::rename(paths.original_package(), &paths.package).map_err(io_error)?;
    }
    sync_directory(paths.package.parent().unwrap())?;
    sync_directory(paths.metadata.parent().unwrap())?;
    archive_pending(paths, "rolled-back")
}

fn check_restore(
    has_backup: bool,
    backup_matches: bool,
    original_matches: bool,
    replacement_matches: bool,
    target_exists: bool,
) -> Result<(), String> {
    if (has_backup && (!backup_matches || (target_exists && !replacement_matches)))
        || (!has_backup && !original_matches)
    {
        return Err("Package recovery destination changed; preserving snapshots".into());
    }
    Ok(())
}

fn archive_pending(paths: &RecoveryPaths, outcome: &str) -> Result<(), String> {
    let destination = paths
        .history
        .join(format!("{outcome}-{}", uuid::Uuid::new_v4()));
    fs::rename(&paths.pending, &destination).map_err(io_error)?;
    sync_directory(&paths.history)?;
    crate::logging::log_executor_event(
        "plugin_package_recovery",
        &[
            ("checksum", paths.hash.clone()),
            ("outcome", outcome.to_owned()),
            ("backup", destination.display().to_string()),
        ],
    );
    Ok(())
}

#[cfg(test)]
#[path = "workbench_recovery_tests.rs"]
mod tests;

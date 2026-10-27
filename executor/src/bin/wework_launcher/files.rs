// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::model::{host_arch, host_platform, Release, State, SCHEMA_VERSION};
use super::Result;
use fs2::FileExt;
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub fn root(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || !regular_metadata(path)?.is_dir() {
        return Err("Installation root must be an absolute regular directory".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}

pub fn lock(root: &Path) -> Result<File> {
    directory(root, ".updates")?;
    let path = root.join(".updates/update.lock");
    reject_link_if_present(&path)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("Cannot open update lock: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Update lock must be a regular file".into());
    }
    // Keep this file permanently: every process must lock the same file identity.
    file.lock_exclusive()
        .map_err(|e| format!("Cannot acquire update lock: {e}"))?;
    Ok(file)
}

pub fn directory(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    for component in relative_path(relative)?.components() {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                if !regular_metadata(&path)?.is_dir() {
                    return Err(format!("Expected a directory: {}", path.display()));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&path).map_err(|e| e.to_string())?;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(path)
}

pub fn relative_path(value: &str) -> Result<PathBuf> {
    if value.is_empty()
        || value.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
        || value.chars().any(char::is_control)
        || value.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with(['.', ' '])
                || reserved_windows_name(part)
        })
    {
        return Err(format!("Invalid release path: {value}"));
    }
    let path = PathBuf::from(value);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("Release path must be relative: {value}"));
    }
    Ok(path)
}

fn reserved_windows_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

pub fn installed_path(root: &Path, relative: &str) -> Result<PathBuf> {
    checked_join(root, &release_relative_path(relative)?)
}

fn release_relative_path(relative: &str) -> Result<PathBuf> {
    let path = relative_path(relative)?;
    let parts: Vec<_> = path.components().collect();
    if parts.len() != 2 || parts[0].as_os_str() != "versions" {
        return Err("Installed releases must be direct children of versions".into());
    }
    Ok(path)
}

pub fn staged_path(root: &Path, absolute: &Path) -> Result<PathBuf> {
    if !absolute.is_absolute() {
        return Err("Candidate path must be absolute".into());
    }
    let staging = directory(root, ".updates/staging")?;
    if absolute
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Candidate must use its direct staging path without traversal".into());
    }
    let parent = absolute
        .parent()
        .ok_or("Candidate has no parent directory")?;
    // canonicalize() uses extended Windows paths while Electron may use ordinary drive paths.
    if self::root(parent)? != staging {
        return Err("Candidate must be a direct child of .updates/staging".into());
    }
    let canonical = absolute.canonicalize().map_err(|e| e.to_string())?;
    if canonical.parent() != Some(staging.as_path()) {
        return Err("Candidate must be a direct child of .updates/staging".into());
    }
    // Check the supplied path as well as its canonical destination.
    regular_metadata(absolute)?;
    regular_metadata(&canonical)?;
    Ok(canonical)
}

fn checked_join(root: &Path, relative: &Path) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        regular_metadata(&path)?;
    }
    Ok(path)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let metadata = regular_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err(format!("Invalid JSON file: {}", path.display()));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid {}: {e}", path.display()))
}

pub fn state(root: &Path) -> Result<State> {
    validate_state(root, recoverable_state(root)?)
}

pub fn recoverable_state(root: &Path) -> Result<State> {
    validate_state_paths(read_json(&root.join("update-state.json"))?)
}

pub fn validate_state(root: &Path, state: State) -> Result<State> {
    let state = validate_state_paths(state)?;
    installed_path(root, &state.active.path)?;
    Ok(state)
}

fn validate_state_paths(state: State) -> Result<State> {
    if state.schema_version != SCHEMA_VERSION || state.data_schema_version != 1 {
        return Err("Unsupported installation state or data schema".into());
    }
    release_relative_path(&state.active.path)?;
    if let Some(previous) = &state.previous {
        release_relative_path(&previous.path)?;
    }
    if let Some(candidate) = &state.candidate {
        release_relative_path(&candidate.path)?;
        uuid::Uuid::parse_str(&candidate.transaction_id)
            .map_err(|_| "Invalid update transaction ID")?;
    }
    Ok(state)
}

pub fn release(path: &Path, data_schema: u32, verify_files: bool) -> Result<(Release, String)> {
    if !regular_metadata(path)?.is_dir() {
        return Err("Release must be a regular directory".into());
    }
    let manifest_path = path.join("release.json");
    let manifest: Release = read_json(&manifest_path)?;
    if manifest.schema_version != SCHEMA_VERSION
        || manifest.platform != host_platform()
        || manifest.arch != host_arch()
        || manifest.data_schema_version != data_schema
        || manifest.entry_point != "WeWork.exe"
        || manifest.files.is_empty()
        || manifest.files.len() > 100_000
        || manifest.version.is_empty()
        || manifest.version.len() > 100
        || !manifest
            .version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".+-_".contains(&c))
    {
        return Err("Incompatible release manifest, platform, architecture or data schema".into());
    }
    let mut names = HashSet::new();
    for file in &manifest.files {
        relative_path(&file.path)?;
        if file.path.eq_ignore_ascii_case("release.json")
            || !names.insert(file.path.to_lowercase())
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Invalid or duplicate release file record".into());
        }
        if verify_files {
            let full = checked_join(path, &relative_path(&file.path)?)?;
            let metadata = regular_metadata(&full)?;
            if !metadata.is_file()
                || metadata.len() != file.size
                || hash(&full)? != file.sha256.to_lowercase()
            {
                return Err(format!(
                    "Release file checksum or size mismatch: {}",
                    file.path
                ));
            }
        }
    }
    if !names.contains(&manifest.entry_point.to_lowercase())
        || !names.contains("resources/app.asar")
    {
        return Err("Release is missing the complete Electron application".into());
    }
    let entry = checked_join(path, &relative_path(&manifest.entry_point)?)?;
    if !regular_metadata(&entry)?.is_file() {
        return Err("Release entry point must be a regular file".into());
    }
    if verify_files {
        let mut discovered = HashSet::new();
        inventory(path, path, &mut discovered)?;
        discovered.remove("release.json");
        if names != discovered {
            return Err("Release directory contains files outside its manifest".into());
        }
    }
    Ok((manifest, hash(&manifest_path)?))
}

fn inventory(root: &Path, directory: &Path, names: &mut HashSet<String>) -> Result<()> {
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let metadata = regular_metadata(&path)?;
        if metadata.is_dir() {
            inventory(root, &path, names)?;
        } else if metadata.is_file() {
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
            let name = relative
                .to_str()
                .ok_or("Release file name is not valid Unicode")?
                .replace('\\', "/");
            relative_path(&name)?;
            if !names.insert(name.to_lowercase()) {
                return Err("Release contains case-insensitive duplicate paths".into());
            }
        } else {
            return Err("Release contains a non-regular file".into());
        }
    }
    Ok(())
}

pub fn hash(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(format!("{:x}", hash.finalize()));
        }
        hash.update(&buffer[..count]);
    }
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    reject_link_if_present(path)?;
    let parent = path.parent().ok_or("State has no parent directory")?;
    let temporary = parent.join(format!(".update-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        replace(&temporary, path)?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(not(windows))]
pub fn replace(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn replace(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

pub fn regular_metadata(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let linked = linked || {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    };
    if linked {
        return Err(format!(
            "Symbolic links or reparse points are forbidden: {}",
            path.display()
        ));
    }
    Ok(metadata)
}

fn reject_link_if_present(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => regular_metadata(path).map(|_| ()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn event(root: &Path, event: &str, detail: &str) {
    let path = root.join(".updates/launcher.log");
    if reject_link_if_present(&path).is_err() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let value = serde_json::json!({"event":event,"detail":detail});
        let _ = writeln!(file, "{value}");
        let _ = file.flush();
    }
}

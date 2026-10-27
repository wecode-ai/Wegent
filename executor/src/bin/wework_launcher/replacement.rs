// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::{
    files,
    model::{InstalledRelease, LauncherReplacement, State, SCHEMA_VERSION},
    process::Parent,
    Result,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const LAUNCHER_RESOURCE: &str = "resources/bin/wework-launcher.exe";
const REQUEST_FILE: &str = ".updates/launcher-replacement.json";

pub fn retry(root: &Path, state: &State) -> Result<()> {
    let path = root.join(REQUEST_FILE);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let pending: LauncherReplacement = files::read_json(&path)?;
    if pending.schema_version != SCHEMA_VERSION
        || pending.release != state.active
        || files::root(&pending.install_root)? != root
    {
        return Err("Pending launcher replacement is not for the current active release".into());
    }
    schedule(root, state)
}

pub fn schedule(root: &Path, state: &State) -> Result<()> {
    let source = files::installed_path(root, &state.active.path)?.join(LAUNCHER_RESOURCE);
    if !source.exists() || files::hash(&source)? == files::hash(&root.join("WeWork.exe"))? {
        return Ok(());
    }
    verified_source(root, &state.active, state.data_schema_version)?;
    let request = LauncherReplacement {
        schema_version: SCHEMA_VERSION,
        install_root: root.to_path_buf(),
        release: state.active.clone(),
        parent_pid: std::process::id(),
    };
    let path = root.join(REQUEST_FILE);
    files::write_json(&path, &request)?;
    let mut command = Command::new(source);
    command
        .arg("--replace-launcher")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|e| format!("Cannot start launcher replacement: {e}"))?;
    files::event(
        root,
        "launcher-replacement-scheduled",
        &state.active.version,
    );
    Ok(())
}

pub fn run(executable: &Path, request_path: &Path) -> Result<()> {
    if !request_path.is_absolute() {
        return Err("Launcher replacement request must be absolute".into());
    }
    let request: LauncherReplacement = files::read_json(request_path)?;
    let root = files::root(&request.install_root)?;
    if request.schema_version != SCHEMA_VERSION
        || request_path.parent() != Some(root.join(".updates").as_path())
    {
        return Err("Invalid launcher replacement request".into());
    }
    let expected = files::installed_path(&root, &request.release.path)?.join(LAUNCHER_RESOURCE);
    if !files::regular_metadata(executable)?.is_file()
        || executable.canonicalize().map_err(|e| e.to_string())?
            != expected.canonicalize().map_err(|e| e.to_string())?
    {
        return Err("Launcher replacement must run from the committed release resource".into());
    }
    let parent = Parent::open(request.parent_pid)?;
    files::event(
        &root,
        "launcher-replacement-waiting",
        &request.parent_pid.to_string(),
    );
    parent.wait()?;
    let _lock = files::lock(&root)?;
    let state = files::state(&root)?;
    if state.active != request.release || state.candidate.is_some() {
        return Err(
            "Launcher replacement release is no longer the committed active release".into(),
        );
    }
    let (source, source_hash) = verified_source(&root, &state.active, state.data_schema_version)?;
    let target = root.join("WeWork.exe");
    if !files::regular_metadata(&target)?.is_file() {
        return Err("Existing launcher is not a regular file".into());
    }
    // Both copies are on the installation volume. The root entry is never removed.
    atomic_copy(
        &target,
        &root.join(".updates/launcher-previous.exe"),
        &files::hash(&target)?,
    )?;
    atomic_copy(&source, &target, &source_hash)?;
    files::event(&root, "launcher-replaced", &state.active.version);
    fs::remove_file(request_path).map_err(|e| e.to_string())?;
    Ok(())
}

fn verified_source(
    root: &Path,
    release: &InstalledRelease,
    schema: u32,
) -> Result<(PathBuf, String)> {
    let directory = files::installed_path(root, &release.path)?;
    let (manifest, _) = files::release(&directory, schema, true)?;
    if manifest.version != release.version {
        return Err("Committed release does not contain its verified launcher".into());
    }
    let record = manifest
        .files
        .iter()
        .find(|file| file.path == LAUNCHER_RESOURCE)
        .ok_or("Committed release is missing its verified launcher")?;
    Ok((
        directory.join(LAUNCHER_RESOURCE),
        record.sha256.to_lowercase(),
    ))
}

fn atomic_copy(source: &Path, target: &Path, expected_hash: &str) -> Result<()> {
    if fs::symlink_metadata(target).is_ok() && !files::regular_metadata(target)?.is_file() {
        return Err("Launcher replacement target must be a regular file".into());
    }
    let temporary = target
        .parent()
        .ok_or("Launcher has no parent")?
        .join(format!(".launcher-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        // Create a fresh name so a partially copied executable can never become the entry.
        let destination = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        drop(destination);
        fs::copy(source, &temporary).map_err(|e| e.to_string())?;
        if files::hash(&temporary)? != expected_hash {
            return Err("Launcher copy failed its integrity check".into());
        }
        fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        files::replace(&temporary, target)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

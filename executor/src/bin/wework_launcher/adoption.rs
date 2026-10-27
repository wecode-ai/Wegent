// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::{
    files,
    model::{Candidate, InstalledRelease},
    Result,
};
use std::{fs, path::Path};

pub fn run(executable: &Path, root: &Path, seed_path: &Path) -> Result<()> {
    if !seed_path.is_absolute() {
        return Err("Installer seed state path must be absolute".into());
    }
    let entry = root.join("WeWork.exe");
    if !files::regular_metadata(&entry)?.is_file()
        || executable.canonicalize().map_err(|e| e.to_string())?
            != entry.canonicalize().map_err(|e| e.to_string())?
    {
        return Err("Installation adoption must run from the stable root launcher".into());
    }
    let _lock = files::lock(root)?;
    let seed = verified_seed(root, seed_path)?;
    let mut previous = match fs::symlink_metadata(root.join("update-state.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            files::write_json(&root.join("update-state.json"), &seed)?;
            return Ok(());
        }
        Err(error) => return Err(error.to_string()),
        Ok(_) => files::recoverable_state(root)?,
    };
    if seed.data_schema_version != previous.data_schema_version {
        return Err("Installer cannot adopt an incompatible user data schema".into());
    }
    // A complete installer must also repair releases damaged or removed after installation.
    // Keep the old identity until the new release passes health, even if rollback is unavailable.
    if let Err(error) = verify_active(root, &previous.active, previous.data_schema_version) {
        files::event(root, "previous-installation-unavailable", &error);
    }
    if seed.active != previous.active {
        previous.candidate = Some(Candidate {
            version: seed.active.version,
            path: seed.active.path,
            transaction_id: uuid::Uuid::new_v4().to_string(),
            attempted: false,
        });
    }
    // The installer never replaces live state. Only this transaction may publish its new candidate.
    files::write_json(&root.join("update-state.json"), &previous)?;
    files::event(
        root,
        "installation-adopted",
        "Preserved last-good installation state before first launch",
    );
    Ok(())
}

pub fn initialize(root: &Path) -> Result<()> {
    match fs::symlink_metadata(root.join("update-state.json")) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let seed = verified_seed(root, &root.join("initial-update-state.json"))?;
    files::write_json(&root.join("update-state.json"), &seed)
}

fn verified_seed(root: &Path, path: &Path) -> Result<super::model::State> {
    let seed = files::validate_state(root, files::read_json(path)?)?;
    if seed.candidate.is_some() || seed.previous.is_some() {
        return Err("Installer seed must describe exactly one complete initial release".into());
    }
    verify_active(root, &seed.active, seed.data_schema_version)?;
    Ok(seed)
}

fn verify_active(root: &Path, active: &InstalledRelease, data_schema: u32) -> Result<()> {
    let directory = files::installed_path(root, &active.path)?;
    let (manifest, _) = files::release(&directory, data_schema, true)?;
    if manifest.version != active.version {
        return Err("Installer release version does not match its state".into());
    }
    Ok(())
}

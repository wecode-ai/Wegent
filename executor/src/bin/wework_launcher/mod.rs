// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

mod adoption;
mod files;
mod model;
mod process;
mod replacement;

use model::{ApplyRequest, Candidate, Health, InstalledRelease, State, SCHEMA_VERSION};
use process::{AppProcess, Parent};
use std::{
    ffi::OsString,
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;

pub fn run(args: Vec<OsString>) -> Result<()> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if args.first().is_some_and(|arg| arg == "--replace-launcher") {
        if args.len() != 2 {
            return Err("Usage: --replace-launcher <absolute request.json>".into());
        }
        return replacement::run(&executable, Path::new(&args[1]));
    }
    let root = files::root(
        executable
            .parent()
            .ok_or("Launcher has no installation root")?,
    )?;
    if args.first().is_some_and(|arg| arg == "--adopt-install") {
        if args.len() != 2 {
            return Err("Usage: --adopt-install <absolute initial-update-state.json>".into());
        }
        return adoption::run(&executable, &root, Path::new(&args[1]));
    }
    if args.first().is_some_and(|arg| arg == "--apply") {
        if args.len() != 2 || !Path::new(&args[1]).is_absolute() {
            return Err("Usage: WeWork.exe --apply <absolute request.json>".into());
        }
        let request: ApplyRequest = files::read_json(Path::new(&args[1]))?;
        if files::root(&request.install_root)? != root {
            return Err("Update request targets a different installation".into());
        }
        // Capture a Windows process handle before any download validation or lock wait.
        let parent = Parent::open(request.parent_pid)?;
        let _lock = files::lock(&root)?;
        let mut state = files::state(&root)?;
        let arguments: Vec<_> = request.launch_args.iter().map(OsString::from).collect();
        let mut recovery_safe = true;
        let result = apply(
            &root,
            &mut state,
            request,
            Path::new(&args[1]),
            parent,
            &arguments,
            &mut recovery_safe,
        );
        if let Err(error) = &result {
            files::event(&root, "update-failed", error);
            // The last-good release was never overwritten. Reopen it after a rejected update.
            if recovery_safe {
                launch_active(&root, &state, &arguments, true)?;
            }
        }
        result
    } else {
        let _lock = files::lock(&root)?;
        adoption::initialize(&root)?;
        let mut state = files::recoverable_state(&root)?;
        launch(&root, &mut state, &args)
    }
}

fn apply(
    root: &Path,
    state: &mut State,
    request: ApplyRequest,
    request_path: &Path,
    parent: Parent,
    args: &[OsString],
    recovery_safe: &mut bool,
) -> Result<()> {
    if request.schema_version != SCHEMA_VERSION
        || !(100..=600_000).contains(&request.health_timeout_ms)
        || request.launch_args.iter().any(|arg| arg.contains('\0'))
    {
        return Err("Invalid update request schema, timeout or arguments".into());
    }
    files::event(root, "waiting-for-parent", &request.parent_pid.to_string());
    parent.wait()?;
    if !matches!(files::read_json::<ApplyRequest>(request_path), Ok(current) if current == request)
    {
        // Cancellation must not reopen an application that the user subsequently closed.
        *recovery_safe = false;
        files::event(
            root,
            "update-cancelled",
            "Waiting update request was revoked or changed",
        );
        return Err("Update request was cancelled or changed before desktop exit".into());
    }
    let staged = files::staged_path(root, &request.candidate_path)?;
    files::event(
        root,
        "verifying",
        "Checking the complete release before activation",
    );
    let (manifest, digest) = files::release(&staged, state.data_schema_version, true)?;
    let relative = format!("versions/{}-{}", manifest.version, &digest[..16]);
    files::directory(root, "versions")?;
    let installed = root.join(&relative);
    if installed.exists() {
        let (_, existing_digest) = files::release(&installed, state.data_schema_version, true)?;
        if existing_digest != digest {
            return Err("Immutable release directory already has different contents".into());
        }
    } else {
        fs::rename(&staged, &installed)
            .map_err(|e| format!("Cannot publish immutable release: {e}"))?;
    }
    let candidate = Candidate {
        version: manifest.version,
        path: relative,
        transaction_id: uuid::Uuid::new_v4().to_string(),
        attempted: false,
    };
    state.candidate = Some(candidate);
    save(root, state)?;
    files::event(
        root,
        "prepared",
        "Complete candidate is installed; active release unchanged",
    );
    if let Err(error) = trial(root, state, args, request.health_timeout_ms, recovery_safe) {
        if !*recovery_safe {
            return Err(error);
        }
        state.candidate = None;
        save(root, state)?;
        return Err(error);
    }
    Ok(())
}

fn launch(root: &Path, state: &mut State, args: &[OsString]) -> Result<()> {
    let recovering_trial = state.candidate.is_some();
    if let Some(candidate) = &state.candidate {
        if candidate.attempted {
            process::recover_trial(&candidate.transaction_id)?;
            files::event(
                root,
                "recovered",
                "Interrupted trial discarded; using last-good release",
            );
            state.candidate = None;
            if let Err(error) = save(root, state) {
                files::event(root, "state-cleanup-failed", &error);
            }
        } else {
            let mut recovery_safe = true;
            match trial(
                root,
                state,
                args,
                model::DEFAULT_HEALTH_TIMEOUT_MS,
                &mut recovery_safe,
            ) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if !recovery_safe {
                        return Err(error);
                    }
                    files::event(root, "trial-failed", &error);
                    state.candidate = None;
                    if let Err(error) = save(root, state) {
                        files::event(root, "state-cleanup-failed", &error);
                    }
                }
            }
        }
    }
    launch_active(root, state, args, recovering_trial)
}

fn launch_active(root: &Path, state: &State, args: &[OsString], verify_files: bool) -> Result<()> {
    let result = spawn_active(root, state, args, verify_files);
    if let Err(error) = &result {
        files::event(root, "active-unavailable", error);
    }
    result
}

fn spawn_active(root: &Path, state: &State, args: &[OsString], verify_files: bool) -> Result<()> {
    let path = files::installed_path(root, &state.active.path)?;
    let (manifest, _) = files::release(&path, state.data_schema_version, verify_files)?;
    if manifest.version != state.active.version {
        return Err("Active release version does not match installation state".into());
    }
    let executable = files::child_path(&path.join(&manifest.entry_point));
    let child_root = files::child_path(root);
    let child = AppProcess::spawn(&executable, &child_root, args, None)?;
    files::event(
        root,
        "active-started",
        &format!("pid={} version={}", child.id(), manifest.version),
    );
    if let Err(error) = replacement::retry(root, state) {
        files::event(root, "launcher-replacement-failed", &error);
    }
    Ok(())
}

fn trial(
    root: &Path,
    state: &mut State,
    args: &[OsString],
    timeout_ms: u64,
    recovery_safe: &mut bool,
) -> Result<()> {
    let mut candidate = state.candidate.clone().ok_or("No candidate release")?;
    let path = files::installed_path(root, &candidate.path)?;
    let (manifest, _) = files::release(&path, state.data_schema_version, true)?;
    if manifest.version != candidate.version {
        return Err("Candidate version does not match installation state".into());
    }
    files::directory(root, ".updates/health")?;
    let health = root.join(format!(".updates/health/{}.json", candidate.transaction_id));
    if fs::symlink_metadata(&health).is_ok() {
        return Err("Health acknowledgment already exists for this trial".into());
    }
    candidate.attempted = true;
    state.candidate = Some(candidate.clone());
    save(root, state)?;
    let token = uuid::Uuid::new_v4().to_string();
    let executable = files::child_path(&path.join(&manifest.entry_point));
    let child_root = files::child_path(root);
    let mut child = AppProcess::spawn(
        &executable,
        &child_root,
        args,
        Some((&candidate.transaction_id, &token)),
    )?;
    *recovery_safe = false;
    files::event(
        root,
        "trial-started",
        &format!(
            "pid={} transactionId={}",
            child.id(),
            candidate.transaction_id
        ),
    );
    let result = wait_for_health(
        &mut child,
        &health,
        &candidate.transaction_id,
        &token,
        timeout_ms,
    );
    if let Err(error) = result {
        child.terminate()?;
        *recovery_safe = true;
        files::event(
            root,
            "trial-stopped",
            "Failed candidate and its process tree stopped",
        );
        return Err(error);
    }
    let mut committed = state.clone();
    committed.previous = Some(state.active.clone());
    committed.active = InstalledRelease {
        version: candidate.version,
        path: candidate.path,
    };
    committed.candidate = None;
    save(root, &committed)?;
    *state = committed;
    child.disarm()?;
    *recovery_safe = true;
    files::event(
        root,
        "committed",
        &format!("version={}", state.active.version),
    );
    if let Err(error) = replacement::schedule(root, state) {
        files::event(root, "launcher-replacement-failed", &error);
    }
    Ok(())
}

fn wait_for_health(
    child: &mut AppProcess,
    path: &Path,
    transaction_id: &str,
    token: &str,
    timeout_ms: u64,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if child.exited()? {
            return Err("Candidate exited before startup was confirmed".into());
        }
        match fs::symlink_metadata(path) {
            Ok(_) => {
                let health: Health = files::read_json(path)?;
                if health.schema_version != SCHEMA_VERSION
                    || health.transaction_id != transaction_id
                    || health.token != token
                {
                    return Err("Invalid candidate health acknowledgment".into());
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot inspect health acknowledgment: {error}")),
        }
        if Instant::now() >= deadline {
            return Err("Candidate startup health confirmation timed out".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn save(root: &Path, state: &State) -> Result<()> {
    files::write_json(&root.join("update-state.json"), state)
}

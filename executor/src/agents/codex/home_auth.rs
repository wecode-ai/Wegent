// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use fs2::FileExt;

use super::super::CodexAuthMode;
use crate::file_lease::FileLease;

/// Prepare durable state without launching a native process or changing auth.
/// The same Home-wide leases exclude older Wework executors during migration.
pub(crate) fn prepare_provider_migration(
    home: &Path,
    wait_for_writers: bool,
) -> Result<(), String> {
    fs::create_dir_all(home).map_err(|error| format!("create Codex Home: {error}"))?;
    let gate = FileLease(open_lock(&home.join(".wework-auth-start.lock"))?);
    (if wait_for_writers {
        FileExt::lock_exclusive(&gate.0)
    } else {
        gate.0.try_lock_exclusive()
    })
    .map_err(|error| lock_error(error, None))?;
    let users = FileLease(open_lock(&home.join(".wework-auth-processes.lock"))?);
    (if wait_for_writers {
        FileExt::lock_exclusive(&users.0)
    } else {
        users.0.try_lock_exclusive()
    })
    .map_err(|error| lock_error(error, None))?;
    super::super::provider_migration::migrate_stopped(home, wait_for_writers)
}

/// The startup gate keeps mode selection atomic while lifetime readers protect
/// authentication from changes by every executor sharing this Home.
pub(in crate::agents::codex) fn acquire_shared_auth(
    home: &Path,
    requested: Option<CodexAuthMode>,
) -> Result<FileLease, String> {
    acquire_process_home(home, requested, true)
}

pub(in crate::agents::codex) fn acquire_named_home(home: &Path) -> Result<FileLease, String> {
    acquire_process_home(home, None, false)
}

fn acquire_process_home(
    home: &Path,
    requested: Option<CodexAuthMode>,
    managed: bool,
) -> Result<FileLease, String> {
    fs::create_dir_all(home).map_err(|error| format!("create Codex Home: {error}"))?;
    let gate = FileLease(open_lock(&home.join(".wework-auth-start.lock"))?);
    gate.0
        .try_lock_exclusive()
        .map_err(|error| lock_error(error, requested))?;
    let mut users = FileLease(open_lock(&home.join(".wework-auth-processes.lock"))?);
    match users.0.try_lock_exclusive() {
        Ok(()) => {
            // The desktop upgrade hook owns bulk migration. This also admits
            // interrupted upgrades and headless executor startup before any RPC.
            super::super::provider_migration::migrate(home)?;
            if managed {
                let mode = requested.unwrap_or(CodexAuthMode::WeworkRouter);
                super::prepare_wework_codex_home_with_auth(
                    home,
                    mode == CodexAuthMode::LocalSubscription,
                )?;
                write_mode(&mut users.0, mode)?;
            }
            // Every contender holds the startup gate, so this conversion cannot
            // admit a writer between releasing exclusive and acquiring shared.
            FileExt::unlock(&users.0).map_err(|error| error.to_string())?;
            FileExt::try_lock_shared(&users.0).map_err(|error| lock_error(error, requested))?;
        }
        Err(error) if is_contended(&error) => {
            FileExt::try_lock_shared(&users.0).map_err(|error| lock_error(error, requested))?;
            if !managed {
                return Ok(users);
            }
            let mut current = String::new();
            users
                .0
                .read_to_string(&mut current)
                .map_err(|error| format!("read Codex authentication ownership mode: {error}"))?;
            if !["local_subscription", "wework_router"].contains(&current.as_str()) {
                return Err("Codex authentication ownership mode is invalid".to_owned());
            }
            if requested.is_some_and(|mode| current != mode_name(mode)) {
                return Err(busy_error(requested));
            }
        }
        Err(error) => return Err(lock_error(error, requested)),
    }
    Ok(users)
}

fn open_lock(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("open Codex authentication ownership lock: {error}"))
}

fn write_mode(file: &mut File, mode: CodexAuthMode) -> Result<(), String> {
    file.set_len(0)
        .and_then(|()| file.seek(SeekFrom::Start(0)).map(|_| ()))
        .and_then(|()| file.write_all(mode_name(mode).as_bytes()))
        .map_err(|error| format!("record Codex authentication ownership mode: {error}"))
}

fn mode_name(mode: CodexAuthMode) -> &'static str {
    match mode {
        CodexAuthMode::LocalSubscription => "local_subscription",
        CodexAuthMode::WeworkRouter => "wework_router",
    }
}

fn is_contended(error: &std::io::Error) -> bool {
    error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
}

fn lock_error(error: std::io::Error, requested: Option<CodexAuthMode>) -> String {
    if is_contended(&error) {
        busy_error(requested)
    } else {
        format!("lock Codex authentication ownership: {error}")
    }
}

fn busy_error(requested: Option<CodexAuthMode>) -> String {
    format!(
        "Codex authentication mode is busy (requested={requested:?}); \
         retry after other Codex processes using this Home finish"
    )
}

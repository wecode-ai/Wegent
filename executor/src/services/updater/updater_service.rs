// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
};

use crate::{
    config::device::UpdateConfig,
    services::updater::{
        binary_name_for, BinaryReplacer, GithubVersionChecker, RegistryVersionChecker, UpdateInfo,
    },
    version::get_version,
};

pub const MIN_FREE_SPACE_BYTES: u64 = 150 * 1024 * 1024;

pub type BoxFutureResult<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait UpdateChecker: Clone + Send + Sync + 'static {
    fn check_for_updates<'a>(
        &'a self,
        current_version: &'a str,
    ) -> BoxFutureResult<'a, Option<UpdateInfo>>;
}

pub trait BinaryInstaller: Clone + Send + Sync + 'static {
    fn install<'a>(
        &'a self,
        update: &'a UpdateInfo,
        current_binary: &'a Path,
        auth_token: Option<&'a str>,
    ) -> BoxFutureResult<'a, Result<(), String>>;
}

pub trait UpdateRuntime: Clone + Send + Sync + 'static {
    fn current_version(&self) -> String;
    fn current_binary_path(&self) -> PathBuf;
    fn has_sufficient_disk_space(&self) -> bool;
    fn confirm_update(&self) -> bool;
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateResult {
    pub success: bool,
    pub already_latest: bool,
    pub old_version: Option<String>,
    pub new_version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UpdaterService<C, I, R>
where
    C: UpdateChecker,
    I: BinaryInstaller,
    R: UpdateRuntime,
{
    update_config: UpdateConfig,
    version_checker: C,
    installer: I,
    runtime: R,
    auto_confirm: bool,
}

impl<C, I, R> UpdaterService<C, I, R>
where
    C: UpdateChecker,
    I: BinaryInstaller,
    R: UpdateRuntime,
{
    pub fn with_components(
        update_config: UpdateConfig,
        version_checker: C,
        installer: I,
        runtime: R,
        auto_confirm: bool,
    ) -> Self {
        Self {
            update_config,
            version_checker,
            installer,
            runtime,
            auto_confirm,
        }
    }

    pub fn update_config(&self) -> &UpdateConfig {
        &self.update_config
    }

    pub fn auto_confirm(&self) -> bool {
        self.auto_confirm
    }

    pub async fn check_and_update(&self) -> UpdateResult {
        let current_version = self.runtime.current_version();
        let Some(update_info) = self
            .version_checker
            .check_for_updates(&current_version)
            .await
        else {
            return UpdateResult {
                success: true,
                already_latest: true,
                old_version: Some(current_version),
                ..UpdateResult::default()
            };
        };

        if !self.runtime.has_sufficient_disk_space() {
            return UpdateResult {
                success: false,
                old_version: Some(current_version),
                new_version: Some(update_info.version),
                error: Some("Insufficient disk space (need ~150 MB free)".to_owned()),
                ..UpdateResult::default()
            };
        }

        if !self.auto_confirm && !self.runtime.confirm_update() {
            return UpdateResult {
                success: false,
                old_version: Some(current_version),
                new_version: Some(update_info.version),
                error: Some("Update cancelled by user".to_owned()),
                ..UpdateResult::default()
            };
        }

        let current_binary = self.runtime.current_binary_path();
        match self
            .installer
            .install(&update_info, &current_binary, self.update_config.token())
            .await
        {
            Ok(()) => UpdateResult {
                success: true,
                old_version: Some(current_version),
                new_version: Some(update_info.version),
                ..UpdateResult::default()
            },
            Err(error) => UpdateResult {
                success: false,
                old_version: Some(current_version),
                new_version: Some(update_info.version),
                error: Some(error),
                ..UpdateResult::default()
            },
        }
    }
}

impl UpdaterService<DefaultUpdateChecker, DefaultBinaryInstaller, SystemUpdateRuntime> {
    pub fn new(update_config: UpdateConfig, auto_confirm: bool) -> Self {
        Self::with_components(
            update_config.clone(),
            DefaultUpdateChecker::from_config(&update_config),
            DefaultBinaryInstaller,
            SystemUpdateRuntime,
            auto_confirm,
        )
    }
}

#[derive(Debug, Clone)]
pub enum DefaultUpdateChecker {
    Github(GithubVersionChecker),
    Registry(RegistryVersionChecker),
}

impl DefaultUpdateChecker {
    pub fn from_config(config: &UpdateConfig) -> Self {
        if let Some(registry_url) = config.registry_url() {
            return Self::Registry(RegistryVersionChecker::new(registry_url, config.token()));
        }
        Self::Github(GithubVersionChecker::new(None))
    }
}

impl UpdateChecker for DefaultUpdateChecker {
    fn check_for_updates<'a>(
        &'a self,
        current_version: &'a str,
    ) -> BoxFutureResult<'a, Option<UpdateInfo>> {
        Box::pin(async move {
            let binary_name = binary_name_for(std::env::consts::OS, std::env::consts::ARCH);
            match self {
                Self::Github(checker) => {
                    checker
                        .check_for_updates_for_binary(current_version, &binary_name)
                        .await
                }
                Self::Registry(checker) => {
                    checker
                        .check_for_updates_for_binary(current_version, &binary_name)
                        .await
                }
            }
        })
    }
}

#[derive(Debug, Clone)]
pub struct DefaultBinaryInstaller;

impl BinaryInstaller for DefaultBinaryInstaller {
    fn install<'a>(
        &'a self,
        update: &'a UpdateInfo,
        current_binary: &'a Path,
        auth_token: Option<&'a str>,
    ) -> BoxFutureResult<'a, Result<(), String>> {
        Box::pin(async move {
            let replacer = BinaryReplacer::new(&update.download_url, auth_token);
            let new_binary = replacer
                .download_binary_to(&std::env::temp_dir(), |_downloaded, _total| {})
                .await
                .map_err(|error| error.to_string())?;
            if replacer.replace_binary(&new_binary, current_binary) {
                Ok(())
            } else {
                Err("Failed to replace binary (permission denied or file in use)".to_owned())
            }
        })
    }
}

#[derive(Debug, Clone)]
pub struct SystemUpdateRuntime;

impl UpdateRuntime for SystemUpdateRuntime {
    fn current_version(&self) -> String {
        get_version()
    }

    fn current_binary_path(&self) -> PathBuf {
        std::env::current_exe().unwrap_or_else(|_| PathBuf::from("wegent-executor"))
    }

    fn has_sufficient_disk_space(&self) -> bool {
        free_space_bytes(&home_dir())
            .map(has_sufficient_update_space)
            .unwrap_or(true)
    }

    fn confirm_update(&self) -> bool {
        true
    }
}

pub fn parse_update_confirmation(input: &str) -> bool {
    matches!(input.trim().to_ascii_lowercase().as_str(), "" | "y" | "yes")
}

pub fn has_sufficient_update_space(free_bytes: u64) -> bool {
    free_bytes >= MIN_FREE_SPACE_BYTES
}

#[cfg(unix)]
fn free_space_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let result = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    let stat = unsafe { stat.assume_init() };
    let available_blocks = numeric_to_u64(stat.f_bavail)?;
    let fragment_size = numeric_to_u64(stat.f_frsize)?;
    Some(available_blocks.saturating_mul(fragment_size))
}

#[cfg(windows)]
fn free_space_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide_path.push(0);
    let mut free_bytes_available = 0u64;
    let mut total_bytes = 0u64;
    let mut total_free_bytes = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide_path.as_ptr(),
            &mut free_bytes_available,
            &mut total_bytes,
            &mut total_free_bytes,
        )
    };
    if ok == 0 {
        return None;
    }
    Some(free_bytes_available)
}

#[cfg(not(any(unix, windows)))]
fn free_space_bytes(_path: &Path) -> Option<u64> {
    None
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir)
}

#[cfg(unix)]
fn numeric_to_u64<T>(value: T) -> Option<u64>
where
    T: TryInto<u64>,
{
    value.try_into().ok()
}

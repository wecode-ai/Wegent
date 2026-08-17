use std::{
    collections::HashSet,
    fs::{self, File},
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, SystemTime},
};

use fs2::FileExt;
use tauri::Manager;

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(30 * 60);
const TEMP_FILE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const STAGING_DIRECTORY_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const LOG_FILE_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const RUNTIME_INSTANCE_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const MAX_REMOVALS_PER_DIRECTORY: usize = 20;
const RUNTIME_INSTANCE_LOCK_FILE: &str = ".instance.lock";
const MARKETPLACE_STAGING_PREFIXES: [&str; 2] = ["marketplace-add-", "marketplace-upgrade-"];

struct RuntimeInstanceLease {
    root: PathBuf,
    instance: PathBuf,
    lock: File,
}

pub fn schedule(app: tauri::AppHandle) {
    thread::spawn(move || {
        let runtime_instance_lease = match acquire_runtime_instance_lease() {
            Ok(lease) => lease,
            Err(error) => {
                log::warn!("Failed to protect the current runtime instance: {error}");
                None
            }
        };
        loop {
            let now = SystemTime::now();
            if let Some(lease) = &runtime_instance_lease {
                if let Err(error) = lease.lock.set_modified(now) {
                    log::warn!(
                        "Failed to refresh runtime instance lease {}: {error}",
                        lease.instance.display()
                    );
                }
            }
            run(&app, now, runtime_instance_lease.as_ref());
            thread::sleep(MAINTENANCE_INTERVAL);
        }
    });
}

fn acquire_runtime_instance_lease() -> Result<Option<RuntimeInstanceLease>, String> {
    let Some((root, instance)) = crate::local_executor::isolated_runtime_instance_paths()? else {
        return Ok(None);
    };
    fs::create_dir_all(&instance).map_err(|error| {
        format!(
            "Failed to create runtime instance directory {}: {error}",
            instance.display()
        )
    })?;
    let lock_path = instance.join(RUNTIME_INSTANCE_LOCK_FILE);
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| {
            format!(
                "Failed to open runtime instance lock {}: {error}",
                lock_path.display()
            )
        })?;
    lock.lock_exclusive().map_err(|error| {
        format!(
            "Failed to lock runtime instance {}: {error}",
            instance.display()
        )
    })?;
    Ok(Some(RuntimeInstanceLease {
        root,
        instance,
        lock,
    }))
}

fn run(app: &tauri::AppHandle, now: SystemTime, lease: Option<&RuntimeInstanceLease>) {
    match app.path().app_cache_dir() {
        Ok(cache_directory) => cleanup_target(
            &cache_directory.join("feedback-staging"),
            now,
            TEMP_FILE_MAX_AGE,
            &HashSet::new(),
        ),
        Err(error) => log::warn!("Failed to locate the cache directory: {error}"),
    }

    cleanup_target(
        &std::env::temp_dir().join("wework-embedded-browser"),
        now,
        TEMP_FILE_MAX_AGE,
        &HashSet::new(),
    );

    match crate::local_executor::managed_codex_home_paths() {
        Ok(codex_homes) => {
            for codex_home in codex_homes {
                cleanup_staging_target(
                    &codex_home.join(".tmp/marketplaces/.staging"),
                    now,
                    STAGING_DIRECTORY_MAX_AGE,
                    &MARKETPLACE_STAGING_PREFIXES,
                );
            }
        }
        Err(error) => log::warn!("Failed to locate managed Codex homes: {error}"),
    }

    match crate::app_log_directory(app) {
        Ok(log_directory) => {
            let current_process_suffix = format!("-{}.log", std::process::id());
            cleanup_target(
                &log_directory,
                now,
                LOG_FILE_MAX_AGE,
                &HashSet::from([current_process_suffix]),
            );
        }
        Err(error) => log::warn!("Failed to locate the log directory: {error}"),
    }

    if let Some(lease) = lease {
        if let Err(error) = cleanup_old_runtime_instances(
            &lease.root,
            &lease.instance,
            now,
            RUNTIME_INSTANCE_MAX_AGE,
        ) {
            log::warn!(
                "Runtime instance maintenance skipped {}: {error}",
                lease.root.display()
            );
        }
    }
}

fn cleanup_target(
    directory: &Path,
    now: SystemTime,
    max_age: Duration,
    protected_suffixes: &HashSet<String>,
) {
    if let Err(error) = cleanup_old_files(
        directory,
        now,
        max_age,
        protected_suffixes,
        MAX_REMOVALS_PER_DIRECTORY,
    ) {
        log::warn!(
            "Storage maintenance skipped {}: {error}",
            directory.display()
        );
    }
}

fn cleanup_staging_target(
    directory: &Path,
    now: SystemTime,
    max_age: Duration,
    allowed_prefixes: &[&str],
) {
    if let Err(error) = cleanup_old_directories(directory, now, max_age, allowed_prefixes) {
        log::warn!(
            "Staging directory maintenance skipped {}: {error}",
            directory.display()
        );
    }
}

fn cleanup_old_files(
    directory: &Path,
    now: SystemTime,
    max_age: Duration,
    protected_suffixes: &HashSet<String>,
    max_removals: usize,
) -> Result<usize, String> {
    ensure_concrete_absolute_path(directory)?;
    if !directory.exists() {
        return Ok(0);
    }
    let canonical_directory = fs::canonicalize(directory)
        .map_err(|error| format!("Failed to resolve {}: {error}", directory.display()))?;
    let mut candidates = fs::read_dir(directory)
        .map_err(|error| format!("Failed to inspect {}: {error}", directory.display()))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if protected_suffixes
                .iter()
                .any(|suffix| name.ends_with(suffix))
            {
                return None;
            }
            let modified = metadata.modified().ok()?;
            let age = now.duration_since(modified).ok()?;
            (age >= max_age).then_some((modified, path))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(modified, _)| *modified);

    let mut removed = 0;
    for (_, path) in candidates.into_iter().take(max_removals) {
        if let Err(error) = ensure_safe_file_target(&canonical_directory, &path) {
            log::warn!("Skipping unsafe storage maintenance target: {error}");
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(error) => {
                log::warn!(
                    "Failed to remove maintenance file {}: {error}",
                    path.display()
                );
            }
        }
    }
    Ok(removed)
}

fn cleanup_old_directories(
    directory: &Path,
    now: SystemTime,
    max_age: Duration,
    allowed_prefixes: &[&str],
) -> Result<usize, String> {
    ensure_concrete_absolute_path(directory)?;
    if !directory.exists() {
        return Ok(0);
    }
    let canonical_directory = fs::canonicalize(directory)
        .map_err(|error| format!("Failed to resolve {}: {error}", directory.display()))?;
    let mut candidates = fs::read_dir(directory)
        .map_err(|error| format!("Failed to inspect {}: {error}", directory.display()))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !allowed_prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix))
            {
                return None;
            }
            let modified = metadata.modified().ok()?;
            let age = now.duration_since(modified).ok()?;
            (age >= max_age).then_some((modified, path))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(modified, _)| *modified);

    let mut removed = 0;
    for (_, path) in candidates {
        if let Err(error) = ensure_safe_directory_target(&canonical_directory, &path) {
            log::warn!("Skipping unsafe staging directory target: {error}");
            continue;
        }
        match fs::remove_dir_all(&path) {
            Ok(()) => removed += 1,
            Err(error) => {
                log::warn!(
                    "Failed to remove staging directory {}: {error}",
                    path.display()
                );
            }
        }
    }
    Ok(removed)
}

fn cleanup_old_runtime_instances(
    root: &Path,
    current_instance: &Path,
    now: SystemTime,
    max_age: Duration,
) -> Result<usize, String> {
    ensure_concrete_absolute_path(root)?;
    ensure_concrete_absolute_path(current_instance)?;
    if !root.exists() {
        return Ok(0);
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Failed to resolve {}: {error}", root.display()))?;
    let canonical_current = fs::canonicalize(current_instance).map_err(|error| {
        format!(
            "Failed to resolve current runtime instance {}: {error}",
            current_instance.display()
        )
    })?;
    if canonical_current.parent() != Some(canonical_root.as_path()) {
        return Err(format!(
            "Current runtime instance {} is outside {}",
            current_instance.display(),
            root.display()
        ));
    }

    let mut candidates = Vec::new();
    for entry in fs::read_dir(root)
        .map_err(|error| format!("Failed to inspect {}: {error}", root.display()))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = runtime_instance_pid(&name) else {
            continue;
        };
        let canonical_path = match fs::canonicalize(&path) {
            Ok(canonical_path) => canonical_path,
            Err(error) => {
                log::warn!(
                    "Skipping unresolved runtime instance {}: {error}",
                    path.display()
                );
                continue;
            }
        };
        if canonical_path == canonical_current {
            continue;
        }

        let lock_path = path.join(RUNTIME_INSTANCE_LOCK_FILE);
        let (modified, lock) = match inactive_instance_lock(&lock_path, &metadata, pid) {
            Ok(Some(state)) => state,
            Ok(None) => continue,
            Err(error) => {
                log::warn!(
                    "Skipping runtime instance with unreadable lock {}: {error}",
                    path.display()
                );
                continue;
            }
        };
        let Some(age) = now.duration_since(modified).ok() else {
            continue;
        };
        if age >= max_age {
            candidates.push((modified, path, lock));
        }
    }
    candidates.sort_by_key(|(modified, _, _)| *modified);

    let mut removed = 0;
    for (_, path, lock) in candidates {
        if let Err(error) = ensure_safe_directory_target(&canonical_root, &path) {
            log::warn!("Skipping unsafe runtime instance target: {error}");
            continue;
        }
        drop(lock);
        match fs::remove_dir_all(&path) {
            Ok(()) => removed += 1,
            Err(error) => {
                log::warn!(
                    "Failed to remove runtime instance {}: {error}",
                    path.display()
                );
            }
        }
    }
    Ok(removed)
}

fn inactive_instance_lock(
    lock_path: &Path,
    instance_metadata: &fs::Metadata,
    pid: u32,
) -> Result<Option<(SystemTime, Option<File>)>, String> {
    if !lock_path.exists() {
        if process_is_alive(pid) {
            return Ok(None);
        }
        return Ok(Some((
            instance_metadata
                .modified()
                .map_err(|error| format!("Failed to read instance modification time: {error}"))?,
            None,
        )));
    }
    let metadata = fs::symlink_metadata(lock_path)
        .map_err(|error| format!("Failed to inspect {}: {error}", lock_path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "{} is not a regular lock file",
            lock_path.display()
        ));
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| format!("Failed to open {}: {error}", lock_path.display()))?;
    if let Err(error) = lock.try_lock_exclusive() {
        if error.kind() == fs2::lock_contended_error().kind() {
            return Ok(None);
        }
        return Err(format!("Failed to lock {}: {error}", lock_path.display()));
    }
    let modified = metadata.modified().map_err(|error| {
        format!(
            "Failed to read {} modification time: {error}",
            lock_path.display()
        )
    })?;
    Ok(Some((modified, Some(lock))))
}

fn runtime_instance_pid(name: &str) -> Option<u32> {
    let Some(identity) = name.strip_prefix("wework-") else {
        return None;
    };
    let identity = identity.strip_prefix("dev-").unwrap_or(identity);
    let Some((pid, timestamp)) = identity.split_once('-') else {
        return None;
    };
    if timestamp.is_empty()
        || !timestamp
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return None;
    }
    pid.parse().ok()
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const STILL_ACTIVE: u32 = 259;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut exit_code = 0;
        let result = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        result != 0 && exit_code == STILL_ACTIVE
    }
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive(_pid: u32) -> bool {
    false
}

fn ensure_concrete_absolute_path(path: &Path) -> Result<(), String> {
    let has_placeholder = path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        value.starts_with('~')
            || value.starts_with('$')
            || (value.len() > 2 && value.starts_with('%') && value.ends_with('%'))
    });
    let has_parent_component = path
        .components()
        .any(|component| matches!(component, Component::ParentDir));
    if !path.is_absolute() || has_placeholder || has_parent_component {
        return Err(format!(
            "{} is not an expanded absolute path",
            path.display()
        ));
    }
    Ok(())
}

fn ensure_safe_file_target(canonical_directory: &Path, path: &Path) -> Result<(), String> {
    ensure_concrete_absolute_path(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let canonical_path = fs::canonicalize(path)
        .map_err(|error| format!("Failed to resolve {}: {error}", path.display()))?;
    if canonical_path.parent() != Some(canonical_directory) {
        return Err(format!(
            "{} resolves outside its maintenance directory",
            path.display()
        ));
    }
    Ok(())
}

fn ensure_safe_directory_target(canonical_root: &Path, path: &Path) -> Result<(), String> {
    ensure_concrete_absolute_path(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("{} is not a concrete directory", path.display()));
    }
    let canonical_path = fs::canonicalize(path)
        .map_err(|error| format!("Failed to resolve {}: {error}", path.display()))?;
    if canonical_path.parent() != Some(canonical_root) {
        return Err(format!(
            "{} resolves outside its runtime root",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn cleanup_is_bounded_and_preserves_recent_files() {
        let root = test_directory("wework-storage-maintenance");
        fs::create_dir_all(&root).unwrap();
        for index in 0..3 {
            fs::write(root.join(format!("old-{index}.log")), "old").unwrap();
        }
        fs::write(root.join("recent.log"), "recent").unwrap();
        let now = SystemTime::now();
        let old = now - Duration::from_secs(120);
        for index in 0..3 {
            set_modified(root.join(format!("old-{index}.log")), old);
        }

        let removed =
            cleanup_old_files(&root, now, Duration::from_secs(60), &HashSet::new(), 2).unwrap();

        assert_eq!(removed, 2);
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name() == "recent.log")
                .count(),
            1
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_rejects_placeholders_and_never_deletes_directories() {
        assert!(cleanup_old_files(
            Path::new("/tmp/$WEWORK_CACHE"),
            SystemTime::now(),
            Duration::ZERO,
            &HashSet::new(),
            20,
        )
        .is_err());
        assert!(ensure_concrete_absolute_path(Path::new("/tmp/cost$analysis")).is_ok());
        assert!(ensure_concrete_absolute_path(Path::new("/tmp/100%done")).is_ok());

        let root = test_directory("wework-storage-directory-safety");
        let nested = root.join("old-directory");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("keep.txt"), "keep").unwrap();

        let removed = cleanup_old_files(
            &root,
            SystemTime::now(),
            Duration::ZERO,
            &HashSet::new(),
            20,
        )
        .unwrap();

        assert_eq!(removed, 0);
        assert!(nested.join("keep.txt").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_skips_symlinks_and_protected_process_logs() {
        let root = test_directory("wework-storage-symlink-safety");
        fs::create_dir_all(&root).unwrap();
        let outside = root.with_extension("outside");
        fs::write(&outside, "outside").unwrap();
        let protected = root.join("wework-tauri-42.log");
        fs::write(&protected, "active").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("linked.log")).unwrap();

        let removed = cleanup_old_files(
            &root,
            SystemTime::now(),
            Duration::ZERO,
            &HashSet::from(["-42.log".to_owned()]),
            20,
        )
        .unwrap();

        assert_eq!(removed, 0);
        assert!(outside.is_file());
        assert!(protected.is_file());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn cleanup_removes_only_old_known_staging_directories() {
        let root = test_directory("wework-storage-staging");
        let stale = root.join("marketplace-upgrade-stale");
        let recent = root.join("marketplace-add-recent");
        let unknown = root.join("user-marketplace");
        for directory in [&stale, &recent, &unknown] {
            fs::create_dir_all(directory).unwrap();
            fs::write(directory.join("content"), "content").unwrap();
        }
        let outside = root.with_extension("outside");
        fs::create_dir_all(&outside).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("marketplace-upgrade-linked")).unwrap();
        let now = SystemTime::now();
        set_directory_modified(&stale, now - Duration::from_secs(120));
        set_directory_modified(&recent, now - Duration::from_secs(30));
        set_directory_modified(&unknown, now - Duration::from_secs(120));

        let removed = cleanup_old_directories(
            &root,
            now,
            Duration::from_secs(60),
            &MARKETPLACE_STAGING_PREFIXES,
        )
        .unwrap();

        assert_eq!(removed, 1);
        assert!(!stale.exists());
        assert!(recent.is_dir());
        assert!(unknown.is_dir());
        assert!(outside.is_dir());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn cleanup_removes_only_old_inactive_runtime_instances() {
        let root = test_directory("wework-runtime-maintenance");
        let current = root.join("wework-10-100");
        let active = root.join("wework-20-200");
        let stale = root.join("wework-30-300");
        let recent = root.join("wework-40-400");
        for directory in [&current, &active, &stale, &recent] {
            fs::create_dir_all(directory.join("logs")).unwrap();
        }
        let active_lock = create_locked_instance_file(&active);
        let stale_lock = create_instance_lock_file(&stale);
        let recent_lock = create_instance_lock_file(&recent);
        let now = SystemTime::now();
        set_modified(
            stale.join(RUNTIME_INSTANCE_LOCK_FILE),
            now - Duration::from_secs(120),
        );
        set_modified(
            recent.join(RUNTIME_INSTANCE_LOCK_FILE),
            now - Duration::from_secs(30),
        );
        drop(stale_lock);

        let removed =
            cleanup_old_runtime_instances(&root, &current, now, Duration::from_secs(60)).unwrap();

        assert_eq!(removed, 1);
        assert!(current.is_dir());
        assert!(active.is_dir());
        assert!(!stale.exists());
        assert!(recent.is_dir());
        drop(active_lock);
        drop(recent_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_cleanup_drains_stale_instances_and_ignores_unknown_directories() {
        let root = test_directory("wework-runtime-maintenance-drain");
        let current = root.join("wework-10-100");
        let unknown = root.join("user-data");
        let legacy = root.join("wework-dev-99-999");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&unknown).unwrap();
        fs::create_dir_all(&legacy).unwrap();
        let now = SystemTime::now();
        let legacy_lock = create_instance_lock_file(&legacy);
        set_modified(
            legacy.join(RUNTIME_INSTANCE_LOCK_FILE),
            now - Duration::from_secs(120),
        );
        drop(legacy_lock);
        for index in 0..3 {
            let instance = root.join(format!("wework-{}-{}", index + 20, index + 200));
            fs::create_dir_all(&instance).unwrap();
            let lock = create_instance_lock_file(&instance);
            set_modified(
                instance.join(RUNTIME_INSTANCE_LOCK_FILE),
                now - Duration::from_secs(120),
            );
            drop(lock);
        }

        let removed =
            cleanup_old_runtime_instances(&root, &current, now, Duration::from_secs(60)).unwrap();

        assert_eq!(removed, 4);
        assert!(current.is_dir());
        assert!(unknown.is_dir());
        assert!(!legacy.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_cleanup_preserves_lockless_instance_with_live_pid() {
        let root = test_directory("wework-runtime-maintenance-live-pid");
        let current = root.join("wework-10-100");
        let active = root.join(format!("wework-{}-200", std::process::id()));
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&active).unwrap();
        let now = SystemTime::now();
        set_directory_modified(&active, now - Duration::from_secs(120));

        let removed =
            cleanup_old_runtime_instances(&root, &current, now, Duration::from_secs(60)).unwrap();

        assert_eq!(removed, 0);
        assert!(active.is_dir());
        let _ = fs::remove_dir_all(root);
    }

    fn create_instance_lock_file(instance: &Path) -> File {
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(instance.join(RUNTIME_INSTANCE_LOCK_FILE))
            .unwrap()
    }

    fn create_locked_instance_file(instance: &Path) -> File {
        let file = create_instance_lock_file(instance);
        file.lock_exclusive().unwrap();
        file
    }

    fn test_directory(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn set_modified(path: PathBuf, modified: SystemTime) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(modified).unwrap();
    }

    fn set_directory_modified(path: &Path, modified: SystemTime) {
        let directory = fs::OpenOptions::new().read(true).open(path).unwrap();
        directory.set_modified(modified).unwrap();
    }
}

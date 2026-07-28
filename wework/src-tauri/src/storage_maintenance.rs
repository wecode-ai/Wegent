use std::{
    collections::HashSet,
    fs,
    path::{Component, Path},
    thread,
    time::{Duration, SystemTime},
};

use tauri::Manager;

const INITIAL_DELAY: Duration = Duration::from_secs(5 * 60);
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(30 * 60);
const TEMP_FILE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const LOG_FILE_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const MAX_REMOVALS_PER_DIRECTORY: usize = 20;

pub fn schedule(app: tauri::AppHandle) {
    thread::spawn(move || {
        thread::sleep(INITIAL_DELAY);
        loop {
            run(&app, SystemTime::now());
            thread::sleep(MAINTENANCE_INTERVAL);
        }
    });
}

fn run(app: &tauri::AppHandle, now: SystemTime) {
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

fn ensure_concrete_absolute_path(path: &Path) -> Result<(), String> {
    let value = path.to_string_lossy();
    let has_placeholder = value.starts_with('~') || value.contains('$') || value.contains('%');
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
}

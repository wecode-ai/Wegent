//! Atomic publication of the runtime work index.
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use wegent_filesystem::atomic_file::replace_file;

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn temporary_index_path(index_path: &Path) -> PathBuf {
    let file_name = index_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("index.json");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    index_path.with_file_name(format!(
        ".{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        nanos,
        sequence
    ))
}

pub(crate) fn atomic_write_file(index_path: &Path, payload: &[u8]) -> io::Result<()> {
    let parent = index_parent(index_path);
    fs::create_dir_all(parent)
        .map_err(|error| io_error_with_context("create index parent directory", parent, error))?;

    let temp_path = temporary_index_path(index_path);
    let mut temp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| io_error_with_context("create temporary index", &temp_path, error))?;

    let write_result = temp_file
        .write_all(payload)
        .and_then(|_| temp_file.sync_all());
    drop(temp_file);
    if let Err(error) = write_result {
        return Err(clean_up_temp_file(
            &temp_path,
            io_error_with_context("write and sync temporary index", &temp_path, error),
        ));
    }

    if let Err(error) = replace_file(&temp_path, index_path) {
        crate::logging::log_executor_event(
            "runtime work index replacement failed",
            &[
                ("source", temp_path.display().to_string()),
                ("destination", index_path.display().to_string()),
                ("os_error", format!("{:?}", error.raw_os_error())),
                (
                    "destination_readonly",
                    format!(
                        "{:?}",
                        fs::metadata(index_path).map(|metadata| metadata.permissions().readonly())
                    ),
                ),
            ],
        );
        return Err(clean_up_temp_file(
            &temp_path,
            io_error_with_context("replace runtime work index", index_path, error),
        ));
    }

    sync_parent_directory(parent)
        .map_err(|error| io_error_with_context("sync index parent directory", parent, error))
}

fn index_parent(index_path: &Path) -> &Path {
    index_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

fn clean_up_temp_file(temp_path: &Path, original_error: io::Error) -> io::Error {
    match fs::remove_file(temp_path) {
        Ok(()) => original_error,
        Err(cleanup_error) if cleanup_error.kind() == io::ErrorKind::NotFound => original_error,
        Err(cleanup_error) => io::Error::new(
            original_error.kind(),
            format!(
                "{original_error}; failed to clean up temporary index {}: {cleanup_error}",
                temp_path.display()
            ),
        ),
    }
}

fn io_error_with_context(action: &str, path: &Path, error: io::Error) -> io::Error {
    io::Error::new(
        error.kind(),
        format!("{action} {}: {error}", path.display()),
    )
}

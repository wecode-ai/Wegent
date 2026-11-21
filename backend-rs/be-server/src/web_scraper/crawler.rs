// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `AsyncWebCrawler.__init__`'s crawler workspace
//! (`crawl4ai.async_webcrawler`), the first crawl4ai step the source runs.
//!
//! crawl4ai resolves its home as
//! `os.path.join(os.getenv("CRAWL4_AI_BASE_DIRECTORY", Path.home()),
//! ".crawl4ai")` and creates it (plus `.crawl4ai/cache`) with
//! `os.makedirs(..., exist_ok=True)`. `Path.home()` is `$HOME` when set.
//! `WebScraperService.scrape_url`'s generic handler renders a raised
//! `OSError` as `"Failed to scrape page: {str(exc)}"`, and Python's
//! `str(OSError)` is `[Errno <n>] <reason>: '<filename>'`.

use std::io;
use std::path::{Path, PathBuf};

/// The directory crawl4ai keeps under its base path.
const CRAWL4AI_DIRECTORY: &str = ".crawl4ai";

/// `AsyncWebCrawler.__init__`'s workspace-creation failure, already rendered
/// the way `str(OSError)` renders it.
#[derive(Debug, PartialEq, Eq)]
pub struct WorkspaceError(String);

impl WorkspaceError {
    /// The rendered `OSError` message.
    pub fn message(&self) -> &str {
        &self.0
    }
}

/// Create the crawler workspace, as the source does on the first scrape.
///
/// The source keeps the created crawler for the process lifetime and retries
/// creation after a failure; this deployment never gets past the creation
/// failure, so the port performs the same two `makedirs` calls per scrape.
pub async fn start() -> Result<(), WorkspaceError> {
    let base = base_directory();
    // The source's `os.makedirs` is blocking filesystem work; keep it off the
    // async workers like the repository's other blocking file operations.
    tokio::task::spawn_blocking(move || create_workspace(&base))
        .await
        .unwrap_or_else(|error| Err(WorkspaceError(error.to_string())))
}

fn create_workspace(base: &Path) -> Result<(), WorkspaceError> {
    let folder = base.join(CRAWL4AI_DIRECTORY);
    create_directory(&folder)?;
    create_directory(&folder.join("cache"))?;
    Ok(())
}

fn create_directory(path: &Path) -> Result<(), WorkspaceError> {
    std::fs::create_dir_all(path).map_err(|error| WorkspaceError(python_os_error(&error, path)))
}

/// `Path.home()`: `$HOME` when set, otherwise the passwd entry. Without a
/// libc passwd lookup the port falls back to `/`, which is the passwd home of
/// the deployment's UID 998 and therefore the value Python would read with
/// `HOME` unset.
fn base_directory() -> PathBuf {
    std::env::var_os("CRAWL4_AI_BASE_DIRECTORY")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// `str(OSError)`: `[Errno <n>] <strerror>: '<filename>'`.
fn python_os_error(error: &io::Error, path: &Path) -> String {
    let Some(errno) = error.raw_os_error() else {
        return error.to_string();
    };
    let fallback = error.to_string();
    let reason = strerror(errno).unwrap_or(&fallback);
    format!("[Errno {errno}] {reason}: '{}'", path.display())
}

/// `os.strerror` for the errno values a workspace creation can raise
/// (glibc's English messages).
fn strerror(errno: i32) -> Option<&'static str> {
    Some(match errno {
        1 => "Operation not permitted",
        2 => "No such file or directory",
        13 => "Permission denied",
        17 => "File exists",
        20 => "Not a directory",
        21 => "Is a directory",
        28 => "No space left on device",
        30 => "Read-only file system",
        36 => "File name too long",
        40 => "Too many levels of symbolic links",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_denied_renders_like_python_oserror() {
        let error = io::Error::from_raw_os_error(13);
        assert_eq!(
            python_os_error(&error, Path::new("/root/.crawl4ai")),
            "[Errno 13] Permission denied: '/root/.crawl4ai'"
        );
    }

    #[test]
    fn other_errnos_use_their_strerror_text() {
        assert_eq!(
            python_os_error(
                &io::Error::from_raw_os_error(30),
                Path::new("/data/.crawl4ai")
            ),
            "[Errno 30] Read-only file system: '/data/.crawl4ai'"
        );
        assert_eq!(
            python_os_error(&io::Error::from_raw_os_error(2), Path::new("/missing")),
            "[Errno 2] No such file or directory: '/missing'"
        );
    }

    #[test]
    fn workspace_creation_builds_the_crawl4ai_and_cache_directories() {
        let base = std::env::temp_dir().join(format!(
            "wegent-web-scraper-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        create_workspace(&base).expect("workspace creation must succeed");
        assert!(base.join(".crawl4ai").is_dir());
        assert!(base.join(".crawl4ai/cache").is_dir());
        let _ = std::fs::remove_dir_all(&base);
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub struct BinaryReplacer {
    download_url: String,
    auth_token: Option<String>,
}

impl BinaryReplacer {
    pub fn new(download_url: &str, auth_token: Option<&str>) -> Self {
        Self {
            download_url: download_url.to_owned(),
            auth_token: auth_token.map(ToOwned::to_owned),
        }
    }

    pub fn download_url(&self) -> &str {
        &self.download_url
    }

    pub fn auth_token(&self) -> Option<&str> {
        self.auth_token.as_deref()
    }

    pub async fn download_binary_to<F>(
        &self,
        target_dir: &Path,
        mut progress_callback: F,
    ) -> Result<PathBuf, BinaryReplaceError>
    where
        F: FnMut(u64, Option<u64>),
    {
        fs::create_dir_all(target_dir).map_err(BinaryReplaceError::download)?;
        let temp_path = self.temp_download_path(target_dir);
        let mut temp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(BinaryReplaceError::download)?;

        let result = self
            .stream_download(&mut temp_file, &mut progress_callback)
            .await;
        match result {
            Ok(()) => Ok(temp_path),
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                Err(error)
            }
        }
    }

    pub fn replace_binary(&self, new_binary: &Path, current_binary: &Path) -> bool {
        let backup_path = backup_path_for(current_binary);

        if let Some(parent) = current_binary.parent() {
            if fs::create_dir_all(parent).is_err() {
                return false;
            }
        }

        if current_binary.exists() && fs::copy(current_binary, &backup_path).is_err() {
            return false;
        }

        if set_executable_permissions(new_binary).is_err() {
            self.cleanup_on_failure(new_binary, &backup_path, current_binary);
            return false;
        }

        if fs::rename(new_binary, current_binary).is_err() {
            self.cleanup_on_failure(new_binary, &backup_path, current_binary);
            return false;
        }

        true
    }

    pub fn cleanup_backup(&self, current_binary: &Path) -> bool {
        let backup_path = backup_path_for(current_binary);
        if !backup_path.exists() {
            return true;
        }
        fs::remove_file(backup_path).is_ok()
    }

    pub fn format_progress_bar(downloaded: u64, total: Option<u64>, width: usize) -> String {
        match total.filter(|total| *total > 0) {
            Some(total) => {
                let percent = ((100 * downloaded) / total).min(100);
                let filled = ((width as u64 * percent) / 100) as usize;
                let arrow = if filled < width { ">" } else { "" };
                let padding = width.saturating_sub(filled + arrow.len());
                let bar = format!("{}{}{}", "=".repeat(filled), arrow, " ".repeat(padding));
                format!(
                    "[{bar}] {percent}% ({} MB / {} MB)",
                    downloaded / bytes_per_mb(),
                    total / bytes_per_mb()
                )
            }
            None => format!(
                "[{}] {} MB downloaded",
                "=".repeat(width),
                downloaded / bytes_per_mb()
            ),
        }
    }

    async fn stream_download<F>(
        &self,
        temp_file: &mut File,
        progress_callback: &mut F,
    ) -> Result<(), BinaryReplaceError>
    where
        F: FnMut(u64, Option<u64>),
    {
        let client = reqwest::Client::builder()
            .timeout(DOWNLOAD_TIMEOUT)
            .build()
            .map_err(BinaryReplaceError::download)?;
        let mut request = client.get(&self.download_url).headers(self.headers()?);
        request = request.timeout(DOWNLOAD_TIMEOUT);

        let response = request.send().await.map_err(BinaryReplaceError::download)?;
        let response = response
            .error_for_status()
            .map_err(BinaryReplaceError::download)?;
        let total = response.content_length();
        let mut downloaded = 0_u64;
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(BinaryReplaceError::download)?;
            if chunk.is_empty() {
                continue;
            }
            temp_file
                .write_all(&chunk)
                .map_err(BinaryReplaceError::download)?;
            downloaded += chunk.len() as u64;
            progress_callback(downloaded, total);
        }
        temp_file.flush().map_err(BinaryReplaceError::download)?;

        Ok(())
    }

    fn headers(&self) -> Result<HeaderMap, BinaryReplaceError> {
        let mut headers = HeaderMap::new();
        if let Some(token) = &self.auth_token {
            let value = HeaderValue::from_str(token).map_err(BinaryReplaceError::download)?;
            headers.insert("PRIVATE-TOKEN", value);
        }
        Ok(headers)
    }

    fn temp_download_path(&self, target_dir: &Path) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        target_dir.join(format!(
            "{}-{suffix}-wegent-executor-new",
            std::process::id()
        ))
    }

    fn cleanup_on_failure(&self, new_binary: &Path, backup_path: &Path, current_binary: &Path) {
        let _ = fs::remove_file(new_binary);
        if !current_binary.exists() && backup_path.exists() {
            let _ = fs::rename(backup_path, current_binary);
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BinaryReplaceError {
    #[error("Failed to download binary: {0}")]
    Download(String),
}

impl BinaryReplaceError {
    fn download(error: impl ToString) -> Self {
        Self::Download(error.to_string())
    }
}

fn backup_path_for(current_binary: &Path) -> PathBuf {
    current_binary.with_extension("backup")
}

fn bytes_per_mb() -> u64 {
    1024 * 1024
}

#[cfg(unix)]
fn set_executable_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
}

#[cfg(not(unix))]
fn set_executable_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

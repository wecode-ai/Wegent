// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use chrono::Local;

use crate::config::device::DeviceConfig;

const DEFAULT_LOG_FILE_NAME: &str = "executor.log";
const BYTES_PER_MIB: u64 = 1024 * 1024;

static ROLLING_LOGGER: OnceLock<Mutex<Option<RollingLogFile>>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
struct RollingLogConfig {
    path: PathBuf,
    max_size_bytes: u64,
    backup_count: u32,
}

#[derive(Debug)]
struct RollingLogFile {
    config: RollingLogConfig,
    file: fs::File,
    current_size: u64,
}

impl RollingLogFile {
    fn new(config: RollingLogConfig) -> io::Result<Self> {
        if let Some(parent) = config.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = open_log_file(&config.path)?;
        let current_size = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        Ok(Self {
            config,
            file,
            current_size,
        })
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let bytes_len = line.len() as u64 + 1;
        if self.should_rotate(bytes_len) {
            self.rotate()?;
        }
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.file.flush()?;
        self.current_size += bytes_len;
        Ok(())
    }

    fn should_rotate(&self, next_bytes: u64) -> bool {
        self.config.max_size_bytes > 0
            && self.current_size > 0
            && self.current_size.saturating_add(next_bytes) > self.config.max_size_bytes
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        if self.config.backup_count == 0 {
            let _ = fs::remove_file(&self.config.path);
        } else {
            let oldest = backup_path(&self.config.path, self.config.backup_count);
            let _ = fs::remove_file(oldest);
            for index in (1..self.config.backup_count).rev() {
                let from = backup_path(&self.config.path, index);
                if from.exists() {
                    let to = backup_path(&self.config.path, index + 1);
                    let _ = fs::rename(from, to);
                }
            }
            if self.config.path.exists() {
                let _ = fs::rename(&self.config.path, backup_path(&self.config.path, 1));
            }
        }
        self.file = open_log_file(&self.config.path)?;
        self.current_size = 0;
        Ok(())
    }
}

pub fn log_executor_event(event: &str, fields: &[(&str, String)]) {
    write_executor_log_line(&format_executor_log(event, fields));
}

pub fn write_executor_log_line(line: &str) {
    println!("{line}");
    let _ = std::io::stdout().flush();
    write_rolling_log_line(line);
}

pub fn write_executor_error_line(line: &str) {
    eprintln!("{line}");
    let _ = std::io::stderr().flush();
    write_rolling_log_line(line);
}

pub fn init_executor_logging(config: &DeviceConfig) {
    let log_config = rolling_log_config_from_device(config);
    match create_rolling_log_file(log_config, &config.executor_home) {
        Ok(file) => {
            let mut logger = rolling_logger().lock().expect("rolling logger lock");
            *logger = Some(file);
        }
        Err(error) => {
            eprintln!("failed to initialize executor rolling log: {error}");
        }
    }
}

fn create_rolling_log_file(
    log_config: RollingLogConfig,
    executor_home: &Path,
) -> io::Result<RollingLogFile> {
    match RollingLogFile::new(log_config.clone()) {
        Ok(file) => Ok(file),
        Err(_initial_error) if can_recover_executor_home_file(&log_config.path, executor_home) => {
            fs::remove_file(executor_home)?;
            RollingLogFile::new(log_config)
        }
        Err(error) => Err(error),
    }
}

fn can_recover_executor_home_file(log_path: &Path, executor_home: &Path) -> bool {
    log_path.starts_with(executor_home.join("logs"))
        && fs::metadata(executor_home)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
}

pub fn task_fields(task_id: &str, subtask_id: &str) -> Vec<(&'static str, String)> {
    vec![
        ("task_id", task_id.to_owned()),
        ("subtask_id", subtask_id.to_owned()),
    ]
}

pub fn push_error_fields(fields: &mut Vec<(&'static str, String)>, error: impl ToString) {
    let error = error.to_string();
    fields.push(("error_len", error.len().to_string()));
    fields.push(("error", error));
}

pub fn format_executor_log(event: &str, fields: &[(&str, String)]) -> String {
    let mut line = format!("{} {event}", executor_log_timestamp());
    for (key, value) in fields {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(&format_field_value(value));
    }
    line
}

pub fn executor_log_timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn format_field_value(value: &str) -> String {
    if value
        .chars()
        .all(|character| !character.is_whitespace() && character != '"')
    {
        return value.to_owned();
    }

    format!("\"{}\"", value.replace('"', "\\\""))
}

fn write_rolling_log_line(line: &str) {
    let mut logger = rolling_logger().lock().expect("rolling logger lock");
    let Some(file) = logger.as_mut() else {
        return;
    };
    let _ = file.write_line(line);
}

fn rolling_logger() -> &'static Mutex<Option<RollingLogFile>> {
    ROLLING_LOGGER.get_or_init(|| Mutex::new(None))
}

fn rolling_log_config_from_device(config: &DeviceConfig) -> RollingLogConfig {
    let log_dir = env::var("WEGENT_EXECUTOR_LOG_DIR")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| config.executor_home.join("logs"));
    let log_file = env::var("WEGENT_EXECUTOR_LOG_FILE")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_LOG_FILE_NAME.to_owned());
    let path = log_path(log_dir, log_file);
    let max_size_mb = env_u32("WEGENT_EXECUTOR_LOG_MAX_SIZE").unwrap_or(config.logging.max_size_mb);
    let backup_count =
        env_u32("WEGENT_EXECUTOR_LOG_BACKUP_COUNT").unwrap_or(config.logging.backup_count);

    RollingLogConfig {
        path,
        max_size_bytes: u64::from(max_size_mb).saturating_mul(BYTES_PER_MIB),
        backup_count,
    }
}

fn log_path(log_dir: PathBuf, log_file: String) -> PathBuf {
    let file_path = PathBuf::from(log_file);
    if file_path.is_absolute() {
        file_path
    } else {
        log_dir.join(file_path)
    }
}

fn env_u32(name: &str) -> Option<u32> {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
}

fn open_log_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().create(true).append(true).open(path)
}

fn backup_path(path: &Path, index: u32) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn rolling_log_file_rotates_when_next_line_exceeds_max_size() {
        let path = temp_log_path("rotate");
        let mut file = RollingLogFile::new(RollingLogConfig {
            path: path.clone(),
            max_size_bytes: 30,
            backup_count: 2,
        })
        .unwrap();

        file.write_line("first line").unwrap();
        file.write_line("second line").unwrap();
        file.write_line("third line").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "third line\n");
        assert_eq!(
            fs::read_to_string(backup_path(&path, 1)).unwrap(),
            "first line\nsecond line\n"
        );
    }

    #[test]
    fn rolling_log_file_keeps_configured_backup_count() {
        let path = temp_log_path("backup-count");
        let mut file = RollingLogFile::new(RollingLogConfig {
            path: path.clone(),
            max_size_bytes: 12,
            backup_count: 2,
        })
        .unwrap();

        file.write_line("line-one").unwrap();
        file.write_line("line-two").unwrap();
        file.write_line("line-three").unwrap();
        file.write_line("line-four").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "line-four\n");
        assert_eq!(
            fs::read_to_string(backup_path(&path, 1)).unwrap(),
            "line-three\n"
        );
        assert_eq!(
            fs::read_to_string(backup_path(&path, 2)).unwrap(),
            "line-two\n"
        );
        assert!(!backup_path(&path, 3).exists());
    }

    #[test]
    fn recreates_executor_home_when_a_file_blocks_log_directory_creation() {
        let executor_home = temp_executor_home_path("recover-file");
        fs::write(&executor_home, "stale executor home").unwrap();
        let log_path = executor_home.join("logs/executor.log");

        let file = create_rolling_log_file(
            RollingLogConfig {
                path: log_path.clone(),
                max_size_bytes: 0,
                backup_count: 0,
            },
            &executor_home,
        )
        .unwrap();

        assert!(executor_home.is_dir());
        assert!(log_path.exists());
        drop(file);
        fs::remove_dir_all(executor_home).unwrap();
    }

    fn temp_log_path(label: &str) -> PathBuf {
        temp_executor_home_path(label).join("executor.log")
    }

    fn temp_executor_home_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("wegent-executor-rolling-{label}-{nanos}"))
    }
}

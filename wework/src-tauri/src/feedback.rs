use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use zip::write::SimpleFileOptions;

const MAX_LOG_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackExportRequest {
    destination: Option<String>,
    include_runtime_logs: bool,
    include_task_info: bool,
    include_screenshot: bool,
    include_system_info: bool,
    note: String,
    task_context: Option<serde_json::Value>,
    screenshot_data_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackExportResult {
    report_id: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    report_id: String,
    created_at_unix_ms: u128,
    included: Vec<&'static str>,
    log_files: Vec<LogManifestEntry>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogManifestEntry {
    archive_path: String,
    source_bytes: u64,
}

#[tauri::command]
pub fn export_feedback_bundle(
    app: tauri::AppHandle,
    request: FeedbackExportRequest,
) -> Result<FeedbackExportResult, String> {
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Failed to read system time: {error}"))?;
    let report_id = format!("WF-{:X}", created_at.as_millis());
    let destination = match request.destination.as_deref().map(str::trim) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => app
            .path()
            .download_dir()
            .map_err(|error| format!("Failed to locate the downloads directory: {error}"))?
            .join(format!("wework-feedback-{report_id}.zip")),
    };

    let file = File::create(&destination)
        .map_err(|error| format!("Failed to create feedback bundle: {error}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut included = Vec::new();
    let mut log_files = Vec::new();
    let mut warnings = Vec::new();

    write_zip_text(
        &mut zip,
        "report.md",
        &format!(
            "# Wework feedback\n\n- Report ID: {report_id}\n- Created: {}\n\n## Additional information\n\n{}\n",
            created_at.as_millis(),
            request.note.trim()
        ),
        options,
    )?;

    if request.include_runtime_logs {
        included.push("runtimeLogs");
        let log_directories = [
            super::app_log_directory(&app),
            super::local_executor::local_executor_log_dir_path(),
        ];
        let mut seen = HashSet::new();
        for directory in log_directories {
            match directory {
                Ok(directory) => collect_logs(
                    &mut zip,
                    &directory,
                    &mut seen,
                    &mut log_files,
                    &mut warnings,
                    options,
                )?,
                Err(error) => warnings.push(format!("Runtime logs unavailable: {error}")),
            }
        }
    }

    if request.include_task_info {
        included.push("taskInfo");
        if let Some(context) = request.task_context {
            let content = serde_json::to_string_pretty(&context)
                .map_err(|error| format!("Failed to serialize task information: {error}"))?;
            write_zip_text(&mut zip, "context/task.json", &redact(&content), options)?;
        }
    }

    if request.include_system_info {
        included.push("systemInfo");
        let environment = serde_json::json!({
            "weworkVersion": app.package_info().version.to_string(),
            "os": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "debugBuild": cfg!(debug_assertions),
        });
        write_zip_text(
            &mut zip,
            "environment.json",
            &serde_json::to_string_pretty(&environment)
                .map_err(|error| format!("Failed to serialize environment: {error}"))?,
            options,
        )?;
    }

    if request.include_screenshot {
        included.push("screenshot");
        match request
            .screenshot_data_url
            .as_deref()
            .and_then(decode_data_url)
        {
            Some(bytes) => write_zip_bytes(&mut zip, "screenshot.png", &bytes, options)?,
            None => warnings.push("Screenshot was selected but could not be captured".to_string()),
        }
    }

    write_zip_text(
        &mut zip,
        "redaction-report.json",
        &serde_json::to_string_pretty(&serde_json::json!({
            "applied": true,
            "rules": ["authorization", "credentials", "urlUserInfo"]
        }))
        .map_err(|error| format!("Failed to serialize redaction report: {error}"))?,
        options,
    )?;

    let manifest = Manifest {
        schema_version: 1,
        report_id: report_id.clone(),
        created_at_unix_ms: created_at.as_millis(),
        included,
        log_files,
        warnings,
    };
    write_zip_text(
        &mut zip,
        "manifest.json",
        &serde_json::to_string_pretty(&manifest)
            .map_err(|error| format!("Failed to serialize manifest: {error}"))?,
        options,
    )?;
    zip.finish()
        .map_err(|error| format!("Failed to finish feedback bundle: {error}"))?;

    Ok(FeedbackExportResult {
        report_id,
        path: destination.to_string_lossy().to_string(),
    })
}

fn collect_logs(
    zip: &mut zip::ZipWriter<File>,
    directory: &Path,
    seen: &mut HashSet<PathBuf>,
    manifest: &mut Vec<LogManifestEntry>,
    warnings: &mut Vec<String>,
    options: SimpleFileOptions,
) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            warnings.push(format!("Could not read {}: {error}", directory.display()));
            return Ok(());
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("log") {
            continue;
        }
        let identity = path.canonicalize().unwrap_or_else(|_| path.clone());
        if !seen.insert(identity) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                warnings.push(format!("Could not inspect {}: {error}", path.display()));
                continue;
            }
        };
        if metadata.len() > MAX_LOG_BYTES {
            return Err(format!(
                "Log file {} is larger than 200 MB; remove old logs or export it separately",
                path.display()
            ));
        }
        let mut content = String::new();
        match File::open(&path).and_then(|mut file| file.read_to_string(&mut content)) {
            Ok(_) => {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("log.txt");
                let lower_name = name.to_ascii_lowercase();
                let source = if lower_name.contains("executor") {
                    "executor"
                } else if lower_name.contains("frontend") || lower_name.contains("webview") {
                    "webview"
                } else {
                    "app"
                };
                let archive_path = format!("logs/{source}/{name}");
                write_zip_text(zip, &archive_path, &redact(&content), options)?;
                manifest.push(LogManifestEntry {
                    archive_path,
                    source_bytes: metadata.len(),
                });
            }
            Err(error) => warnings.push(format!("Could not read {}: {error}", path.display())),
        }
    }
    Ok(())
}

fn redact(content: &str) -> String {
    let patterns = [
        r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,]+",
        r#"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[\"']?)[^\s,\"']+"#,
        r"(?i)(https?://[^\s/:]+:)[^@\s]+@",
    ];
    let redacted = patterns.iter().fold(content.to_string(), |value, pattern| {
        Regex::new(pattern)
            .map(|regex| regex.replace_all(&value, "${1}[REDACTED]").into_owned())
            .unwrap_or(value)
    });
    dirs::home_dir()
        .map(|home| redacted.replace(&home.to_string_lossy().to_string(), "~"))
        .unwrap_or(redacted)
}

fn decode_data_url(value: &str) -> Option<Vec<u8>> {
    let encoded = value.strip_prefix("data:image/png;base64,")?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
}

fn write_zip_text(
    zip: &mut zip::ZipWriter<File>,
    path: &str,
    content: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    write_zip_bytes(zip, path, content.as_bytes(), options)
}

fn write_zip_bytes(
    zip: &mut zip::ZipWriter<File>,
    path: &str,
    content: &[u8],
    options: SimpleFileOptions,
) -> Result<(), String> {
    zip.start_file(path, options)
        .map_err(|error| format!("Failed to add {path}: {error}"))?;
    zip.write_all(content)
        .map_err(|error| format!("Failed to write {path}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{decode_data_url, redact};

    #[test]
    fn redacts_credentials_without_removing_surrounding_log_context() {
        let log =
            "request failed authorization: Bearer secret-token status=401\napi_key=sk-test retry=2";

        let redacted = redact(log);

        assert!(!redacted.contains("secret-token"));
        assert!(!redacted.contains("sk-test"));
        assert!(redacted.contains("status=401"));
        assert!(redacted.contains("retry=2"));
    }

    #[test]
    fn decodes_png_data_urls() {
        assert_eq!(
            decode_data_url("data:image/png;base64,aGVsbG8="),
            Some(b"hello".to_vec())
        );
        assert_eq!(decode_data_url("https://example.com/image.png"), None);
    }
}

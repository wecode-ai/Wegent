use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
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

#[tauri::command(async)]
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
    let mut incomplete_archive = IncompleteArchive::new(destination.clone());
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
        if let Some(mut context) = request.task_context {
            redact_json_value(&mut context);
            let content = serde_json::to_string_pretty(&context)
                .map_err(|error| format!("Failed to serialize task information: {error}"))?;
            write_zip_text(&mut zip, "context/task.json", &content, options)?;
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
    incomplete_archive.complete();

    Ok(FeedbackExportResult {
        report_id,
        path: destination.to_string_lossy().to_string(),
    })
}

struct IncompleteArchive {
    path: PathBuf,
    completed: bool,
}

impl IncompleteArchive {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            completed: false,
        }
    }

    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for IncompleteArchive {
    fn drop(&mut self) {
        if !self.completed {
            let _ = fs::remove_file(&self.path);
        }
    }
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
    let redacted = redaction_patterns()
        .iter()
        .fold(content.to_string(), |value, regex| {
            regex.replace_all(&value, "${1}[REDACTED]").into_owned()
        });
    dirs::home_dir()
        .map(|home| redact_home_path(&redacted, &home.to_string_lossy()))
        .unwrap_or(redacted)
}

fn redaction_patterns() -> &'static [Regex; 4] {
    static PATTERNS: OnceLock<[Regex; 4]> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            Regex::new(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,]+")
                .expect("authorization redaction regex must compile"),
            Regex::new(
                r#"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[=:]\s*[\"']?)[^\s,\"']+"#,
            )
            .expect("credential redaction regex must compile"),
            Regex::new(r"(?i)(cookie\s*[:=]\s*)[^\r\n]+")
                .expect("cookie redaction regex must compile"),
            Regex::new(r"(?i)(https?://[^\s/:]+:)[^@\s]+@")
                .expect("URL user-info redaction regex must compile"),
        ]
    });
    PATTERNS
        .get()
        .expect("redaction regexes must be initialized")
}

fn redact_home_path(content: &str, home: &str) -> String {
    let escaped_home = home.replace('\\', "\\\\");
    content.replace(&escaped_home, "~").replace(home, "~")
}

fn redact_json_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                let normalized_key = key.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "authorization",
                    "cookie",
                    "apikey",
                    "accesstoken",
                    "refreshtoken",
                    "password",
                ]
                .iter()
                .any(|sensitive| normalized_key.contains(sensitive))
                {
                    *value = serde_json::Value::String("[REDACTED]".to_string());
                } else {
                    redact_json_value(value);
                }
            }
        }
        serde_json::Value::Array(values) => values.iter_mut().for_each(redact_json_value),
        serde_json::Value::String(content) => *content = redact(content),
        _ => {}
    }
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
    use super::{decode_data_url, redact, redact_home_path, redact_json_value};

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

    #[test]
    fn redacts_complete_cookie_headers() {
        let redacted = redact("Cookie: session=secret; csrf=also-secret\nstatus=401");

        assert_eq!(redacted, "Cookie: [REDACTED]\nstatus=401");
    }

    #[test]
    fn redacts_plain_and_json_escaped_windows_home_paths() {
        let home = r"C:\Users\Alice";
        let content = r#"{"plain":"C:\Users\Alice\repo","escaped":"C:\\Users\\Alice\\repo"}"#;

        let redacted = redact_home_path(content, home);

        assert!(!redacted.contains("Alice"));
        assert!(redacted.contains(r#""plain":"~\repo""#));
        assert!(redacted.contains(r#""escaped":"~\\repo""#));
    }

    #[test]
    fn preserves_valid_task_json_while_redacting_sensitive_fields() {
        let mut context = serde_json::json!({
            "messages": [{"content": "Cookie: session=secret; csrf=also-secret"}],
            "authorization": "Bearer secret-token"
        });

        redact_json_value(&mut context);

        assert_eq!(context["authorization"], "[REDACTED]");
        assert_eq!(context["messages"][0]["content"], "Cookie: [REDACTED]");
        assert!(serde_json::to_string(&context).is_ok());
    }
}

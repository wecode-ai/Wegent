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
const MAX_ENTRY_PREVIEW_CHARS: usize = 20_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackExportRequest {
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
pub struct FeedbackEntryPreview {
    category: String,
    archive_path: String,
    size_bytes: u64,
    previewable: bool,
    content: Option<String>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackPreviewResult {
    staging_id: String,
    report_id: String,
    entries: Vec<FeedbackEntryPreview>,
    skipped: Vec<String>,
    warnings: Vec<String>,
    final_file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackBundleDecision {
    staging_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    report_id: String,
    created_at_unix_ms: u128,
    included: Vec<&'static str>,
    skipped: Vec<String>,
    log_files: Vec<LogManifestEntry>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogManifestEntry {
    archive_path: String,
    source_bytes: u64,
}

struct PendingEntry {
    archive_path: String,
    data: Vec<u8>,
    previewable: bool,
}

fn categorize_entry(archive_path: &str) -> &'static str {
    if archive_path == "report.md" || archive_path == "redaction-report.json" {
        "report"
    } else if archive_path.starts_with("logs/") {
        "logs"
    } else if archive_path == "context/task.json" {
        "task"
    } else if archive_path == "environment.json" {
        "system"
    } else if archive_path == "screenshot.png" {
        "screenshot"
    } else {
        "other"
    }
}

struct PendingBundle {
    report_id: String,
    created_at_unix_ms: u128,
    entries: Vec<PendingEntry>,
    warnings: Vec<String>,
    included: Vec<&'static str>,
    skipped: Vec<String>,
    log_files: Vec<LogManifestEntry>,
}

fn empty_task_context(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::Object(fields) => fields.is_empty(),
        serde_json::Value::Array(values) => values.is_empty(),
        _ => false,
    }
}

fn build_pending_bundle(
    app: &tauri::AppHandle,
    request: &FeedbackExportRequest,
) -> Result<PendingBundle, String> {
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Failed to read system time: {error}"))?;
    let report_id = format!("WF-{:X}", created_at.as_millis());
    let mut included = Vec::new();
    let mut skipped = Vec::new();
    let mut log_files = Vec::new();
    let mut warnings = Vec::new();
    let mut entries = vec![
        text_entry(
            "report.md",
            format!(
                "# Wework feedback\n\n- Report ID: {report_id}\n- Created: {}\n\n## Additional information\n\n{}\n",
                created_at.as_millis(),
                request.note.trim()
            ),
        ),
        text_entry(
            "redaction-report.json",
            serde_json::to_string_pretty(&serde_json::json!({
                "applied": true,
                "rules": ["authorization", "credentials", "urlUserInfo"]
            }))
            .map_err(|error| format!("Failed to serialize redaction report: {error}"))?,
        ),
    ];

    if request.include_runtime_logs {
        let entries_before = entries.len();
        let log_directories = [
            super::app_log_directory(app),
            super::local_executor::local_executor_log_dir_path(),
        ];
        let mut seen = HashSet::new();
        for directory in log_directories {
            match directory {
                Ok(directory) => collect_log_entries(
                    &directory,
                    &mut seen,
                    &mut entries,
                    &mut log_files,
                    &mut warnings,
                )?,
                Err(error) => warnings.push(format!("Runtime logs unavailable: {error}")),
            }
        }
        if entries.len() == entries_before {
            skipped.push("runtimeLogs".to_string());
        } else {
            included.push("runtimeLogs");
        }
    }

    if request.include_task_info {
        if let Some(mut context) = request
            .task_context
            .clone()
            .filter(|context| !empty_task_context(context))
        {
            redact_json_value(&mut context);
            entries.push(text_entry(
                "context/task.json",
                serde_json::to_string_pretty(&context)
                    .map_err(|error| format!("Failed to serialize task information: {error}"))?,
            ));
            included.push("taskInfo");
        } else {
            skipped.push("taskInfo".to_string());
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
        entries.push(text_entry(
            "environment.json",
            serde_json::to_string_pretty(&environment)
                .map_err(|error| format!("Failed to serialize environment: {error}"))?,
        ));
    }

    if request.include_screenshot {
        match request
            .screenshot_data_url
            .as_deref()
            .and_then(decode_data_url)
        {
            Some(bytes) if !bytes.is_empty() => {
                entries.push(PendingEntry {
                    archive_path: "screenshot.png".to_string(),
                    data: bytes,
                    previewable: false,
                });
                included.push("screenshot");
            }
            _ => skipped.push("screenshot".to_string()),
        }
    }

    Ok(PendingBundle {
        report_id,
        created_at_unix_ms: created_at.as_millis(),
        entries,
        warnings,
        included,
        skipped,
        log_files,
    })
}

fn text_entry(archive_path: &str, content: String) -> PendingEntry {
    PendingEntry {
        archive_path: archive_path.to_string(),
        data: content.into_bytes(),
        previewable: true,
    }
}

fn write_pending_bundle(
    bundle: &PendingBundle,
    destination: &Path,
) -> Result<(), String> {
    let file = File::create(destination)
        .map_err(|error| format!("Failed to create feedback bundle: {error}"))?;
    let mut incomplete_archive = IncompleteArchive::new(destination.to_path_buf());
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for entry in &bundle.entries {
        write_zip_bytes(&mut zip, &entry.archive_path, &entry.data, options)?;
    }
    let manifest = Manifest {
        schema_version: 1,
        report_id: bundle.report_id.clone(),
        created_at_unix_ms: bundle.created_at_unix_ms,
        included: bundle.included.clone(),
        skipped: bundle.skipped.clone(),
        log_files: bundle
            .log_files
            .iter()
            .map(|entry| LogManifestEntry {
                archive_path: entry.archive_path.clone(),
                source_bytes: entry.source_bytes,
            })
            .collect(),
        warnings: bundle.warnings.clone(),
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
    Ok(())
}

fn feedback_staging_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Failed to locate the cache directory: {error}"))?
        .join("feedback-staging");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create the feedback staging directory: {error}"))?;
    Ok(directory)
}

#[tauri::command(async)]
pub fn preview_feedback_bundle(
    app: tauri::AppHandle,
    request: FeedbackExportRequest,
) -> Result<FeedbackPreviewResult, String> {
    let bundle = build_pending_bundle(&app, &request)?;
    let staging_id = format!(
        "{:x}-{:x}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("Failed to read system time: {error}"))?
            .as_nanos(),
        std::process::id(),
        std::thread::current().name().unwrap_or("feedback")
    );
    let staging_path = feedback_staging_directory(&app)?.join(format!("{staging_id}.zip"));
    write_pending_bundle(&bundle, &staging_path)?;

    let entries = bundle
        .entries
        .iter()
        .map(|entry| {
            let text = entry.previewable.then(|| {
                let raw = String::from_utf8_lossy(&entry.data).into_owned();
                if entry.archive_path == "context/task.json" {
                    redact(&raw)
                } else {
                    raw
                }
            });
            let (content, truncated) = match text {
                Some(text) if text.chars().count() > MAX_ENTRY_PREVIEW_CHARS => (
                    Some(text.chars().take(MAX_ENTRY_PREVIEW_CHARS).collect()),
                    true,
                ),
                other => (other, false),
            };
            FeedbackEntryPreview {
                category: categorize_entry(&entry.archive_path).to_string(),
                archive_path: entry.archive_path.clone(),
                size_bytes: entry.data.len() as u64,
                previewable: entry.previewable,
                content,
                truncated,
            }
        })
        .collect();

    Ok(FeedbackPreviewResult {
        staging_id,
        report_id: bundle.report_id.clone(),
        entries,
        skipped: bundle.skipped.clone(),
        warnings: bundle.warnings,
        final_file_name: format!("wework-feedback-{}.zip", bundle.report_id),
    })
}

fn resolve_staging_path(app: &tauri::AppHandle, staging_id: &str) -> Result<PathBuf, String> {
    if staging_id.is_empty()
        || !staging_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid feedback staging identifier".to_string());
    }
    Ok(feedback_staging_directory(app)?.join(format!("{staging_id}.zip")))
}

#[tauri::command(async)]
pub fn confirm_feedback_bundle(
    app: tauri::AppHandle,
    decision: FeedbackBundleDecision,
) -> Result<FeedbackExportResult, String> {
    let staging_path = resolve_staging_path(&app, &decision.staging_id)?;
    let report_id = report_id_from_staging_archive(&staging_path)?;
    let destination = app
        .path()
        .download_dir()
        .map_err(|error| format!("Failed to locate the downloads directory: {error}"))?
        .join(format!("wework-feedback-{report_id}.zip"));
    if let Err(move_error) = fs::rename(&staging_path, &destination) {
        fs::copy(&staging_path, &destination)
            .and_then(|_| fs::remove_file(&staging_path))
            .map_err(|error| {
                format!("Failed to save the feedback bundle: {move_error}; {error}")
            })?;
    }
    Ok(FeedbackExportResult {
        report_id,
        path: destination.to_string_lossy().to_string(),
    })
}

fn report_id_from_staging_archive(staging_path: &Path) -> Result<String, String> {
    let file = File::open(staging_path)
        .map_err(|_| "The prepared feedback bundle expired; export again".to_string())?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Failed to read the prepared feedback bundle: {error}"))?;
    let mut manifest_file = archive
        .by_name("manifest.json")
        .map_err(|error| format!("The prepared feedback bundle is incomplete: {error}"))?;
    let mut content = String::new();
    manifest_file
        .read_to_string(&mut content)
        .map_err(|error| format!("Failed to read the feedback manifest: {error}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse the feedback manifest: {error}"))?;
    manifest
        .get("reportId")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| "The feedback manifest is missing a report ID".to_string())
}

#[tauri::command(async)]
pub fn discard_feedback_bundle(
    app: tauri::AppHandle,
    decision: FeedbackBundleDecision,
) -> Result<(), String> {
    let staging_path = resolve_staging_path(&app, &decision.staging_id)?;
    match fs::remove_file(&staging_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to discard the feedback bundle: {error}")),
    }
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

fn collect_log_entries(
    directory: &Path,
    seen: &mut HashSet<PathBuf>,
    entries: &mut Vec<PendingEntry>,
    manifest: &mut Vec<LogManifestEntry>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let dir_entries = match fs::read_dir(directory) {
        Ok(dir_entries) => dir_entries,
        Err(error) => {
            warnings.push(format!("Could not read {}: {error}", directory.display()));
            return Ok(());
        }
    };
    for entry in dir_entries.flatten() {
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
                entries.push(text_entry(&archive_path, redact(&content)));
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
    use super::{decode_data_url, empty_task_context, redact, redact_home_path, redact_json_value};

    #[test]
    fn treats_absent_task_context_as_empty() {
        assert!(empty_task_context(&serde_json::Value::Null));
        assert!(empty_task_context(&serde_json::json!({})));
        assert!(empty_task_context(&serde_json::json!([])));
        assert!(!empty_task_context(&serde_json::json!({"task": {"id": "task-1"}})));
    }

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

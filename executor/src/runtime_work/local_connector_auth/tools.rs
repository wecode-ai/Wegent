use std::{
    collections::HashMap,
    env, fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use flate2::read::GzDecoder;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::local::app_ipc::AppIpcError;

use super::validate_relative_arg;

const MAX_TOOL_ARCHIVE_BYTES: usize = 128 * 1024 * 1024;
const MAX_TOOL_BINARY_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(super) struct LocalAuthToolSpec {
    id: String,
    source: String,
    version: Option<String>,
    artifacts: HashMap<String, LocalAuthArtifactSpec>,
}

#[derive(Debug, Clone)]
struct LocalAuthArtifactSpec {
    url: String,
    sha256: String,
    archive: String,
    binary_path: String,
}

pub(super) fn parse_tool_spec(
    value: Option<&Value>,
) -> Result<Option<LocalAuthToolSpec>, AppIpcError> {
    let Some(tool) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let id = required_json_string(tool, "id")?;
    let source = required_json_string(tool, "source")?;
    if !is_safe_identifier(&id) || !matches!(source.as_str(), "bundled" | "managed") {
        return Err(AppIpcError::new(
            "local_auth_tool_invalid",
            "localAuth tool id or source is invalid",
        ));
    }
    let version = tool
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if version
        .as_deref()
        .is_some_and(|value| !is_safe_version(value))
    {
        return Err(AppIpcError::new(
            "local_auth_tool_invalid",
            "localAuth tool version is invalid",
        ));
    }
    let mut artifacts = HashMap::new();
    if let Some(entries) = tool.get("artifacts").and_then(Value::as_object) {
        for (target, value) in entries {
            if !is_supported_target_name(target) {
                return Err(AppIpcError::new(
                    "local_auth_tool_invalid",
                    format!("Unsupported localAuth tool target: {target}"),
                ));
            }
            let artifact = LocalAuthArtifactSpec {
                url: required_json_string(value, "url")?,
                sha256: required_json_string(value, "sha256")?,
                archive: required_json_string(value, "archive")?,
                binary_path: required_json_string(value, "binaryPath")?,
            };
            validate_artifact_spec(&artifact)?;
            artifacts.insert(target.clone(), artifact);
        }
    }
    if source == "managed" && (version.is_none() || artifacts.is_empty()) {
        return Err(AppIpcError::new(
            "local_auth_tool_invalid",
            "Managed localAuth tools require a version and platform artifacts",
        ));
    }
    Ok(Some(LocalAuthToolSpec {
        id,
        source,
        version,
        artifacts,
    }))
}

pub(super) async fn resolve_auth_tool(
    tool: Option<&LocalAuthToolSpec>,
    prepare: bool,
) -> Result<Option<PathBuf>, AppIpcError> {
    let Some(tool) = tool else {
        return Ok(None);
    };
    match tool.source.as_str() {
        "bundled" => resolve_bundled_tool(tool).map(Some),
        "managed" => resolve_managed_tool(tool, prepare).await.map(Some),
        _ => Err(AppIpcError::new(
            "local_auth_tool_invalid",
            "Unsupported localAuth tool source",
        )),
    }
}

fn required_json_string(value: &Value, field: &str) -> Result<String, AppIpcError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            AppIpcError::new(
                "local_auth_tool_invalid",
                format!("localAuth tool {field} is required"),
            )
        })
}

fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
}

fn is_safe_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
}

fn is_supported_target_name(value: &str) -> bool {
    matches!(
        value,
        "darwin-x64"
            | "darwin-arm64"
            | "linux-x64"
            | "linux-arm64"
            | "windows-x64"
            | "windows-arm64"
    )
}

fn validate_artifact_spec(artifact: &LocalAuthArtifactSpec) -> Result<(), AppIpcError> {
    let parsed_url = url::Url::parse(&artifact.url).map_err(|error| {
        AppIpcError::new(
            "local_auth_tool_invalid",
            format!("Invalid tool URL: {error}"),
        )
    })?;
    if parsed_url.scheme() != "https"
        || parsed_url.host_str() != Some("gitlab.com")
        || !parsed_url.path().starts_with("/gitlab-org/cli/-/releases/")
    {
        return Err(AppIpcError::new(
            "local_auth_tool_invalid",
            "Managed tool URL is not an approved GitLab CLI release URL",
        ));
    }
    if artifact.sha256.len() != 64
        || !artifact
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || !matches!(artifact.archive.as_str(), "tar_gz" | "zip")
    {
        return Err(AppIpcError::new(
            "local_auth_tool_invalid",
            "Managed tool checksum or archive type is invalid",
        ));
    }
    validate_relative_arg(&artifact.binary_path)
}

fn resolve_bundled_tool(tool: &LocalAuthToolSpec) -> Result<PathBuf, AppIpcError> {
    if tool.id != "dws" {
        return Err(AppIpcError::new(
            "local_auth_tool_invalid",
            format!("Unsupported bundled localAuth tool: {}", tool.id),
        ));
    }
    if let Some(path) = env::var_os("DWS_BINARY_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(executable) = env::current_exe() {
        let sibling = executable.with_file_name(if cfg!(windows) { "dws.exe" } else { "dws" });
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    Err(AppIpcError::new(
        "local_auth_tool_missing",
        "The bundled DWS CLI is unavailable in this Wework installation",
    ))
}

async fn resolve_managed_tool(
    tool: &LocalAuthToolSpec,
    prepare: bool,
) -> Result<PathBuf, AppIpcError> {
    if tool.id != "glab" {
        return Err(AppIpcError::new(
            "local_auth_tool_invalid",
            format!("Unsupported managed localAuth tool: {}", tool.id),
        ));
    }
    let version = tool.version.as_deref().ok_or_else(|| {
        AppIpcError::new(
            "local_auth_tool_invalid",
            "Managed tool version is required",
        )
    })?;
    let target = current_tool_target()?;
    let artifact = tool.artifacts.get(&target).ok_or_else(|| {
        AppIpcError::new(
            "local_auth_tool_unsupported",
            format!("{} {version} does not support {target}", tool.id),
        )
    })?;
    let binary_name = Path::new(&artifact.binary_path)
        .file_name()
        .ok_or_else(|| {
            AppIpcError::new(
                "local_auth_tool_invalid",
                "Managed tool binaryPath is invalid",
            )
        })?;
    let install_dir = executor_home()?
        .join("tools")
        .join(&tool.id)
        .join(version)
        .join(&target);
    let installed = install_dir.join(binary_name);
    if installed.is_file() {
        return Ok(installed);
    }
    if !prepare {
        return Err(AppIpcError::new(
            "local_auth_tool_missing",
            format!("{} {version} has not been prepared", tool.id),
        ));
    }
    download_managed_tool(artifact, &install_dir, &installed).await?;
    Ok(installed)
}

fn executor_home() -> Result<PathBuf, AppIpcError> {
    if let Some(path) = env::var_os("WEGENT_EXECUTOR_HOME") {
        return Ok(PathBuf::from(path));
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".wegent-executor"))
        .ok_or_else(|| AppIpcError::new("internal_error", "HOME is not set"))
}

fn current_tool_target() -> Result<String, AppIpcError> {
    let os = match env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        other => {
            return Err(AppIpcError::new(
                "local_auth_tool_unsupported",
                format!("Unsupported operating system: {other}"),
            ))
        }
    };
    let arch = match env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => {
            return Err(AppIpcError::new(
                "local_auth_tool_unsupported",
                format!("Unsupported CPU architecture: {other}"),
            ))
        }
    };
    Ok(format!("{os}-{arch}"))
}

async fn download_managed_tool(
    artifact: &LocalAuthArtifactSpec,
    install_dir: &Path,
    installed: &Path,
) -> Result<(), AppIpcError> {
    validate_artifact_spec(artifact)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| AppIpcError::new("local_auth_tool_download_failed", error.to_string()))?
        .get(&artifact.url)
        .send()
        .await
        .map_err(|error| AppIpcError::new("local_auth_tool_download_failed", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppIpcError::new("local_auth_tool_download_failed", error.to_string()))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_TOOL_ARCHIVE_BYTES as u64)
    {
        return Err(AppIpcError::new(
            "local_auth_tool_too_large",
            "Managed tool archive is too large",
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppIpcError::new("local_auth_tool_download_failed", error.to_string()))?;
    if bytes.len() > MAX_TOOL_ARCHIVE_BYTES {
        return Err(AppIpcError::new(
            "local_auth_tool_too_large",
            "Managed tool archive is too large",
        ));
    }
    let actual_sha = format!("{:x}", Sha256::digest(&bytes));
    if actual_sha != artifact.sha256.to_ascii_lowercase() {
        return Err(AppIpcError::new(
            "local_auth_tool_checksum_failed",
            "Managed tool archive failed SHA-256 verification",
        ));
    }
    fs::create_dir_all(install_dir)
        .map_err(|error| AppIpcError::new("local_auth_tool_install_failed", error.to_string()))?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".download-")
        .tempfile_in(install_dir)
        .map_err(|error| AppIpcError::new("local_auth_tool_install_failed", error.to_string()))?;
    let binary = extract_managed_binary(&bytes, artifact)?;
    temporary
        .as_file_mut()
        .write_all(&binary)
        .map_err(|error| AppIpcError::new("local_auth_tool_install_failed", error.to_string()))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| AppIpcError::new("local_auth_tool_install_failed", error.to_string()))?;
    mark_executable(temporary.path())?;
    match temporary.persist(installed) {
        Ok(_) => Ok(()),
        Err(_error) if installed.is_file() => Ok(()),
        Err(error) => Err(AppIpcError::new(
            "local_auth_tool_install_failed",
            error.error.to_string(),
        )),
    }
}

fn extract_managed_binary(
    bytes: &[u8],
    artifact: &LocalAuthArtifactSpec,
) -> Result<Vec<u8>, AppIpcError> {
    match artifact.archive.as_str() {
        "tar_gz" => extract_tar_gz_binary(bytes, &artifact.binary_path),
        "zip" => extract_zip_binary(bytes, &artifact.binary_path),
        _ => Err(AppIpcError::new(
            "local_auth_tool_invalid",
            "Unsupported managed tool archive",
        )),
    }
}

fn extract_tar_gz_binary(bytes: &[u8], binary_path: &str) -> Result<Vec<u8>, AppIpcError> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| AppIpcError::new("local_auth_tool_archive_invalid", error.to_string()))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| {
            AppIpcError::new("local_auth_tool_archive_invalid", error.to_string())
        })?;
        let path = entry.path().map_err(|error| {
            AppIpcError::new("local_auth_tool_archive_invalid", error.to_string())
        })?;
        if path == Path::new(binary_path) {
            if !entry.header().entry_type().is_file()
                || entry.header().size().unwrap_or(u64::MAX) > MAX_TOOL_BINARY_BYTES
            {
                break;
            }
            let mut output = Vec::new();
            entry.read_to_end(&mut output).map_err(|error| {
                AppIpcError::new("local_auth_tool_archive_invalid", error.to_string())
            })?;
            return Ok(output);
        }
    }
    Err(AppIpcError::new(
        "local_auth_tool_binary_missing",
        format!("Managed tool archive does not contain {binary_path}"),
    ))
}

fn extract_zip_binary(bytes: &[u8], binary_path: &str) -> Result<Vec<u8>, AppIpcError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| AppIpcError::new("local_auth_tool_archive_invalid", error.to_string()))?;
    let mut entry = archive.by_name(binary_path).map_err(|_| {
        AppIpcError::new(
            "local_auth_tool_binary_missing",
            format!("Managed tool archive does not contain {binary_path}"),
        )
    })?;
    if entry.size() > MAX_TOOL_BINARY_BYTES
        || entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
    {
        return Err(AppIpcError::new(
            "local_auth_tool_archive_invalid",
            "Managed tool binary is invalid",
        ));
    }
    let mut output = Vec::new();
    entry
        .read_to_end(&mut output)
        .map_err(|error| AppIpcError::new("local_auth_tool_archive_invalid", error.to_string()))?;
    Ok(output)
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> Result<(), AppIpcError> {
    let mut permissions = fs::metadata(path)
        .map_err(|error| AppIpcError::new("local_auth_tool_install_failed", error.to_string()))?
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions)
        .map_err(|error| AppIpcError::new("local_auth_tool_install_failed", error.to_string()))
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> Result<(), AppIpcError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    #[test]
    fn maps_supported_tool_targets() {
        let target = current_tool_target().expect("current development target should be supported");
        assert!(is_supported_target_name(&target));
    }

    #[test]
    fn rejects_unapproved_managed_tool_urls() {
        let artifact = LocalAuthArtifactSpec {
            url: "https://example.com/glab.tar.gz".to_owned(),
            sha256: "a".repeat(64),
            archive: "tar_gz".to_owned(),
            binary_path: "bin/glab".to_owned(),
        };
        assert!(validate_artifact_spec(&artifact).is_err());
    }

    #[test]
    fn extracts_only_declared_tar_gz_binary() {
        let mut compressed = Vec::new();
        {
            let encoder = GzEncoder::new(&mut compressed, Compression::default());
            let mut archive = tar::Builder::new(encoder);
            let contents = b"managed glab";
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive
                .append_data(&mut header, "bin/glab", contents.as_slice())
                .expect("tar fixture should be writable");
            archive.finish().expect("tar fixture should finish");
        }

        assert_eq!(
            extract_tar_gz_binary(&compressed, "bin/glab").expect("binary should extract"),
            b"managed glab"
        );
        assert!(extract_tar_gz_binary(&compressed, "../glab").is_err());
    }

    #[test]
    fn extracts_only_declared_zip_binary() {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file("bin/glab.exe", zip::write::FileOptions::default())
            .expect("zip fixture entry should start");
        archive
            .write_all(b"managed glab")
            .expect("zip fixture should be writable");
        let bytes = archive
            .finish()
            .expect("zip fixture should finish")
            .into_inner();

        assert_eq!(
            extract_zip_binary(&bytes, "bin/glab.exe").expect("binary should extract"),
            b"managed glab"
        );
        assert!(extract_zip_binary(&bytes, "bin/missing.exe").is_err());
    }
}

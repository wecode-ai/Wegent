use flate2::read::GzDecoder;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tar::Archive;
use tauri::{Manager, State};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DIRECTORY: &str = "harness-apps";
const REGISTRY: &str = "installations.json";
const BUNDLED_RUNTIME_DIRECTORY: &str = "bundled-deepseek-harness";
const BUNDLED_RUNTIME_ARCHIVE: &str = "runtime.tar.gz";
const BUNDLED_RUNTIME_METADATA: &str = "runtime.json";
const MAX_ARCHIVE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 250 * 1024 * 1024;
const MAX_ENTRIES: usize = 8_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessAppEntry {
    install_package: String,
    profile: String,
    web_url: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct HarnessAppRequirements {
    dsh: String,
    node: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessAppManifest {
    name: String,
    display_name: String,
    version: String,
    #[serde(rename = "type")]
    package_type: String,
    description: String,
    entry: HarnessAppEntry,
    requirements: HarnessAppRequirements,
    #[serde(default)]
    default_model: Option<Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessAppInstallation {
    id: String,
    manifest: HarnessAppManifest,
    package_path: String,
    sha256: String,
    model_key: Option<String>,
    #[serde(default)]
    resident: bool,
    runtime_version: Option<String>,
    state: String,
    web_url: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessAppPreview {
    valid: bool,
    archive_path: String,
    sha256: String,
    manifest: Option<HarnessAppManifest>,
    issues: Vec<String>,
}

pub struct HarnessAppRuntimeState {
    children: Mutex<HashMap<String, Child>>,
    registry: Mutex<()>,
    runtime: Mutex<()>,
}

impl Default for HarnessAppRuntimeState {
    fn default() -> Self {
        Self {
            children: Mutex::new(HashMap::new()),
            registry: Mutex::new(()),
            runtime: Mutex::new(()),
        }
    }
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(DIRECTORY))
        .map_err(|error| format!("Failed to resolve Harness app directory: {error}"))
}

fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.join(REGISTRY))
}

fn read_registry(app: &tauri::AppHandle) -> Result<Vec<HarnessAppInstallation>, String> {
    let path = registry_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Harness app registry is invalid: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("Failed to read Harness app registry: {error}")),
    }
}

fn write_registry(
    app: &tauri::AppHandle,
    installations: &[HarnessAppInstallation],
) -> Result<(), String> {
    let path = registry_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Harness app registry path is invalid".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create Harness app directory: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(installations)
            .map_err(|error| format!("Failed to serialize Harness app registry: {error}"))?,
    )
    .map_err(|error| format!("Failed to write Harness app registry: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Failed to replace Harness app registry: {error}"))
}

fn safe_relative(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
}

fn inspect_archive(
    path: &Path,
    destination: Option<&Path>,
) -> Result<(HarnessAppManifest, String), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect Harness app ZIP: {error}"))?;
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("Harness app ZIP exceeds 50 MB".to_string());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read Harness app ZIP: {error}"))?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("Harness app ZIP is invalid: {error}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err("Harness app ZIP contains too many entries".to_string());
    }
    let mut total = 0_u64;
    let mut manifest = None;
    let mut prefix = None::<String>;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect Harness app ZIP entry: {error}"))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "Harness app ZIP contains an unsafe path".to_string())?;
        if !safe_relative(&enclosed) {
            return Err("Harness app ZIP contains an unsafe path".to_string());
        }
        total = total.saturating_add(entry.size());
        if total > MAX_EXTRACTED_BYTES {
            return Err("Harness app ZIP expands beyond 250 MB".to_string());
        }
        let normalized = enclosed.to_string_lossy().replace('\\', "/");
        if normalized.ends_with("/plugin-manifest.json") || normalized == "plugin-manifest.json" {
            if manifest.is_some() {
                return Err(
                    "Harness app ZIP contains multiple plugin-manifest.json files".to_string(),
                );
            }
            prefix = normalized
                .strip_suffix("plugin-manifest.json")
                .map(|value| value.trim_end_matches('/').to_string());
            let mut content = String::new();
            entry
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read plugin-manifest.json: {error}"))?;
            manifest = Some(
                serde_json::from_str::<HarnessAppManifest>(&content)
                    .map_err(|error| format!("plugin-manifest.json is invalid: {error}"))?,
            );
        }
    }
    let manifest = manifest.ok_or_else(|| "plugin-manifest.json is missing".to_string())?;
    validate_manifest(&manifest)?;
    if let Some(destination) = destination {
        let _ = fs::remove_dir_all(destination);
        fs::create_dir_all(destination)
            .map_err(|error| format!("Failed to create Harness app staging directory: {error}"))?;
        let mut written = 0_u64;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("Failed to extract Harness app entry: {error}"))?;
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| "Harness app ZIP contains an unsafe path".to_string())?;
            let relative = if let Some(prefix) = prefix.as_deref() {
                enclosed
                    .strip_prefix(prefix)
                    .map_err(|_| "Harness app ZIP root is inconsistent".to_string())?
            } else {
                enclosed.as_path()
            };
            if relative.as_os_str().is_empty() {
                continue;
            }
            let output = destination.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&output)
                    .map_err(|error| format!("Failed to create Harness app directory: {error}"))?;
            } else {
                if let Some(parent) = output.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        format!("Failed to create Harness app parent directory: {error}")
                    })?;
                }
                let mut file = fs::File::create(&output)
                    .map_err(|error| format!("Failed to create Harness app file: {error}"))?;
                let remaining = MAX_EXTRACTED_BYTES.saturating_sub(written);
                let copied = std::io::copy(&mut entry.by_ref().take(remaining + 1), &mut file)
                    .map_err(|error| format!("Failed to extract Harness app file: {error}"))?;
                if copied > remaining {
                    return Err("Harness app ZIP expands beyond 250 MB".to_string());
                }
                written += copied;
            }
        }
    }
    Ok((manifest, sha256))
}

fn validate_manifest(manifest: &HarnessAppManifest) -> Result<(), String> {
    if manifest.package_type != "deepseek-harness-plugin-bundle" {
        return Err("Unsupported Harness app package type".to_string());
    }
    Version::parse(&manifest.version)
        .map_err(|error| format!("Harness app version is invalid: {error}"))?;
    dsh_version_requirement(&manifest.requirements.dsh)
        .map_err(|error| format!("DeepSeek Harness version requirement is invalid: {error}"))?;
    if manifest.name.trim().is_empty()
        || !manifest
            .name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || manifest.entry.profile.trim().is_empty()
        || manifest.entry.install_package.trim().is_empty()
    {
        return Err("Harness app manifest has incomplete identity or entry fields".to_string());
    }
    if !safe_relative(Path::new(&manifest.entry.install_package)) {
        return Err("Harness app installPackage must stay inside the package".to_string());
    }
    Ok(())
}

fn dsh_version_requirement(raw: &str) -> Result<VersionReq, semver::Error> {
    let raw = raw.trim();
    if let Ok(version) = Version::parse(raw) {
        return VersionReq::parse(&format!("={version}"));
    }
    VersionReq::parse(raw)
}

#[tauri::command]
pub async fn preview_harness_app(archive_path: String) -> HarnessAppPreview {
    match inspect_archive(Path::new(&archive_path), None) {
        Ok((manifest, sha256)) => HarnessAppPreview {
            valid: true,
            archive_path,
            sha256,
            manifest: Some(manifest),
            issues: Vec::new(),
        },
        Err(error) => HarnessAppPreview {
            valid: false,
            archive_path,
            sha256: String::new(),
            manifest: None,
            issues: vec![error],
        },
    }
}

#[tauri::command]
pub fn list_harness_apps(
    app: tauri::AppHandle,
    state: State<'_, HarnessAppRuntimeState>,
) -> Result<Vec<HarnessAppInstallation>, String> {
    let mut children = state
        .children
        .lock()
        .map_err(|_| "Harness app runtime lock failed")?;
    children.retain(|_, child| child.try_wait().ok().flatten().is_none());
    let _registry = state
        .registry
        .lock()
        .map_err(|_| "Harness app registry lock failed")?;
    let mut installations = read_registry(&app)?;
    let mut changed = false;
    for installation in &mut installations {
        let running = children.contains_key(&installation.id);
        let next_state = if running { "running" } else { "installed" };
        if installation.state != next_state || (!running && installation.web_url.is_some()) {
            installation.state = next_state.to_string();
            if !running {
                installation.web_url = None;
            }
            changed = true;
        }
    }
    drop(children);
    if changed {
        write_registry(&app, &installations)?;
    }
    Ok(installations)
}

#[tauri::command]
pub async fn install_harness_app(
    app: tauri::AppHandle,
    state: State<'_, HarnessAppRuntimeState>,
    archive_path: String,
    expected_sha256: String,
    model_key: Option<String>,
) -> Result<HarnessAppInstallation, String> {
    let staging = root(&app)?.join(format!(
        ".install-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let (manifest, sha256) = inspect_archive(Path::new(&archive_path), Some(&staging))?;
    if sha256 != expected_sha256 {
        let _ = fs::remove_dir_all(&staging);
        return Err("Harness app ZIP changed after preview".to_string());
    }
    let _registry = state
        .registry
        .lock()
        .map_err(|_| "Harness app registry lock failed")?;
    let id = manifest.name.clone();
    let target = root(&app)?
        .join("packages")
        .join(&manifest.name)
        .join(&manifest.version);
    if target.exists() {
        let existing = read_registry(&app)?.into_iter().find(|item| {
            item.manifest.name == manifest.name && item.manifest.version == manifest.version
        });
        if existing.as_ref().is_none_or(|item| item.sha256 != sha256) {
            let _ = fs::remove_dir_all(&staging);
            return Err(
                "This Harness app version is already installed with different contents".to_string(),
            );
        }
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("Failed to remove Harness app staging directory: {error}"))?;
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Failed to create Harness app package directory: {error}")
            })?;
        }
        fs::rename(&staging, &target)
            .map_err(|error| format!("Failed to activate Harness app package: {error}"))?;
    }
    let installation = HarnessAppInstallation {
        id: id.clone(),
        manifest,
        package_path: target.display().to_string(),
        sha256,
        model_key: model_key
            .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string())),
        resident: false,
        runtime_version: None,
        state: "installed".to_string(),
        web_url: None,
        error: None,
    };
    let mut installations = read_registry(&app)?;
    installations.retain(|item| item.id != id);
    installations.push(installation.clone());
    write_registry(&app, &installations)?;
    Ok(installation)
}

#[tauri::command]
pub fn update_harness_app(
    app: tauri::AppHandle,
    state: State<'_, HarnessAppRuntimeState>,
    installation_id: String,
    model_key: Option<String>,
    resident: Option<bool>,
) -> Result<HarnessAppInstallation, String> {
    if model_key.is_some() {
        let mut children = state
            .children
            .lock()
            .map_err(|_| "Harness app runtime lock failed")?;
        if let Some(child) = children.get_mut(&installation_id) {
            if child
                .try_wait()
                .map_err(|error| format!("Failed to inspect Smart app process: {error}"))?
                .is_none()
            {
                return Err("Stop the Smart app before changing its model".to_string());
            }
            children.remove(&installation_id);
        }
    }
    let _registry = state
        .registry
        .lock()
        .map_err(|_| "Harness app registry lock failed")?;
    let mut installations = read_registry(&app)?;
    let installation = installations
        .iter_mut()
        .find(|item| item.id == installation_id)
        .ok_or_else(|| "Harness app installation is missing".to_string())?;
    if let Some(model_key) = model_key {
        let model_key = model_key.trim();
        if model_key.is_empty() {
            return Err("Smart app model cannot be empty".to_string());
        }
        installation.model_key = Some(model_key.to_string());
    }
    if let Some(resident) = resident {
        installation.resident = resident;
    }
    let updated = installation.clone();
    write_registry(&app, &installations)?;
    Ok(updated)
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Failed to allocate Harness app port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Failed to read Harness app port: {error}"))
}

struct DshRuntime {
    root: PathBuf,
    node: PathBuf,
    entry: PathBuf,
    version: Version,
    node_version: Version,
    uses_tsx_loader: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledDshRuntimeMetadata {
    source_fingerprint: String,
}

fn read_package_version(path: &Path) -> Result<Version, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read DSH package version: {error}"))?;
    let package: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("DSH package metadata is invalid: {error}"))?;
    let version = package
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "DSH package metadata has no version".to_string())?;
    Version::parse(version).map_err(|error| format!("DSH runtime version is invalid: {error}"))
}

fn read_node_version(node: &Path) -> Result<Version, String> {
    let output = Command::new(node)
        .arg("--version")
        .output()
        .map_err(|error| format!("Failed to inspect the managed Node runtime: {error}"))?;
    if !output.status.success() {
        return Err("Managed Node runtime did not report its version".to_string());
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    Version::parse(raw.trim().trim_start_matches('v'))
        .map_err(|error| format!("Managed Node runtime version is invalid: {error}"))
}

fn resolve_dsh_runtime(app: &tauri::AppHandle) -> Result<DshRuntime, String> {
    if let Ok(runtime_root) = std::env::var("WEWORK_DEEPSEEK_HARNESS_RUNTIME_ROOT") {
        return resolve_managed_dsh_runtime(PathBuf::from(runtime_root));
    }
    if let Ok(source_root) = std::env::var("WEWORK_DEEPSEEK_HARNESS_ROOT") {
        let root = fs::canonicalize(source_root).map_err(|error| {
            format!("Failed to resolve DeepSeek Harness source runtime: {error}")
        })?;
        let tsx = root.join("node_modules/tsx");
        if !tsx.is_dir() {
            return Err(format!(
                "DeepSeek Harness source runtime is not installed: {} is missing. Run pnpm install \
                 in that checkout or use Wework's managed runtime.",
                tsx.display()
            ));
        }
        let node = PathBuf::from("node");
        return Ok(DshRuntime {
            version: read_package_version(&root.join("package.json"))?,
            node_version: read_node_version(&node)?,
            node,
            entry: root.join("apps/cli/src/bin.ts"),
            root,
            uses_tsx_loader: true,
        });
    }
    let resource_root = bundled_runtime_resource_root(app)?;
    extract_bundled_dsh_runtime(app, &resource_root)
}

fn bundled_runtime_resource_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_root = app
        .path()
        .resource_dir()
        .map(|directory| directory.join(BUNDLED_RUNTIME_DIRECTORY));
    #[cfg(debug_assertions)]
    {
        if let Ok(root) = &resource_root {
            if root.join(BUNDLED_RUNTIME_ARCHIVE).is_file() {
                return Ok(root.clone());
            }
        }
        let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(BUNDLED_RUNTIME_DIRECTORY);
        if source_root.join(BUNDLED_RUNTIME_ARCHIVE).is_file() {
            return Ok(source_root);
        }
    }
    resource_root.map_err(|error| format!("Failed to resolve Wework resources: {error}"))
}

fn extract_bundled_dsh_runtime(
    app: &tauri::AppHandle,
    resource_root: &Path,
) -> Result<DshRuntime, String> {
    let metadata_path = resource_root.join(BUNDLED_RUNTIME_METADATA);
    let metadata: BundledDshRuntimeMetadata =
        serde_json::from_slice(&fs::read(&metadata_path).map_err(|error| {
            format!("Failed to read managed Harness runtime metadata: {error}")
        })?)
        .map_err(|error| format!("Managed Harness runtime metadata is invalid: {error}"))?;
    let fingerprint = metadata.source_fingerprint.trim();
    if fingerprint.len() != 64
        || !fingerprint
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Managed Harness runtime fingerprint is invalid".to_string());
    }

    let runtime_parent = root(app)?.join("runtime");
    let extracted = runtime_parent.join(fingerprint);
    if let Ok(runtime) = resolve_managed_dsh_runtime(extracted.clone()) {
        return Ok(runtime);
    }

    let staging = runtime_parent.join(format!(".extract-{}-{fingerprint}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Failed to create managed Harness runtime staging: {error}"))?;
    let extraction = (|| {
        let archive_path = resource_root.join(BUNDLED_RUNTIME_ARCHIVE);
        let archive_file = fs::File::open(&archive_path)
            .map_err(|error| format!("Failed to open managed Harness runtime archive: {error}"))?;
        let mut archive = Archive::new(GzDecoder::new(archive_file));
        archive
            .unpack(&staging)
            .map_err(|error| format!("Failed to extract managed Harness runtime: {error}"))?;

        let staged_metadata: BundledDshRuntimeMetadata =
            serde_json::from_slice(&fs::read(staging.join(BUNDLED_RUNTIME_METADATA)).map_err(
                |error| format!("Failed to read extracted Harness runtime metadata: {error}"),
            )?)
            .map_err(|error| format!("Extracted Harness runtime metadata is invalid: {error}"))?;
        if staged_metadata.source_fingerprint != fingerprint {
            return Err("Managed Harness runtime archive fingerprint does not match".to_string());
        }
        resolve_managed_dsh_runtime(staging.clone())?;

        fs::create_dir_all(&runtime_parent).map_err(|error| {
            format!("Failed to create managed Harness runtime directory: {error}")
        })?;
        let _ = fs::remove_dir_all(&extracted);
        fs::rename(&staging, &extracted)
            .map_err(|error| format!("Failed to activate managed Harness runtime: {error}"))?;
        resolve_managed_dsh_runtime(extracted)
    })();
    if extraction.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    extraction
}

fn resolve_managed_dsh_runtime(root: PathBuf) -> Result<DshRuntime, String> {
    let package_root = root.join("node_modules/@deepseek-ai/dsh");
    let entry = package_root.join("lib/bin.js");
    if !entry.is_file() {
        return Err("Wework managed DeepSeek Harness runtime is not installed".to_string());
    }
    let node = root
        .join("node/bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    Ok(DshRuntime {
        version: read_package_version(&package_root.join("package.json"))?,
        node_version: read_node_version(&node)?,
        node,
        entry,
        root,
        uses_tsx_loader: false,
    })
}

fn dsh_command(runtime: &DshRuntime, args: &[String], home: &Path) -> Command {
    let mut command = Command::new(&runtime.node);
    let managed_node_bin = runtime.root.join("node/bin");
    let managed_bin = runtime.root.join("node_modules/.bin");
    let path = std::env::var_os("PATH")
        .map(|existing| {
            let mut paths = vec![managed_node_bin.clone(), managed_bin.clone()];
            paths.extend(std::env::split_paths(&existing));
            std::env::join_paths(paths)
        })
        .transpose()
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            std::env::join_paths([managed_node_bin, managed_bin]).unwrap_or_default()
        });
    if runtime.uses_tsx_loader {
        command.arg("--import").arg("tsx/esm");
    }
    command
        .arg(&runtime.entry)
        .args(args)
        .current_dir(&runtime.root)
        .env("DSH_HOME", home)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    command
}

fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        let process_group = child.id() as libc::pid_t;
        let _ = libc::kill(-process_group, libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = libc::kill(-process_group, libc::SIGKILL);
        let _ = child.wait();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
        let _ = child.wait();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Failed to create instance bundle directory: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Failed to inspect Harness app bundle: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("Failed to inspect Harness app bundle entry: {error}"))?;
        let target = destination.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| format!("Failed to inspect Harness app bundle type: {error}"))?
            .is_dir()
        {
            copy_directory(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)
                .map_err(|error| format!("Failed to copy Harness app bundle file: {error}"))?;
        }
    }
    Ok(())
}

fn prepare_instance_bundle(
    installation: &HarnessAppInstallation,
    home: &Path,
    use_wework_model: bool,
) -> Result<PathBuf, String> {
    let source = Path::new(&installation.package_path);
    let destination = home.join("wework-package");
    let _ = fs::remove_dir_all(home.join("wework-bundle"));
    let _ = fs::remove_dir_all(&destination);
    copy_directory(source, &destination)?;
    let install_package = destination.join(&installation.manifest.entry.install_package);
    if use_wework_model {
        let patch_path = install_package.join("cordis.patch.yml");
        let patch = fs::read_to_string(&patch_path)
            .map_err(|error| format!("Failed to read Harness app bundle patch: {error}"))?;
        let mut replaced_provider = false;
        let mut replaced_model = false;
        let patched = patch
            .lines()
            .map(|line| {
                let trimmed = line.trim_start();
                if !replaced_provider && trimmed.starts_with("provider:") {
                    replaced_provider = true;
                    return format!(
                        "{}provider: wework-local",
                        &line[..line.len() - trimmed.len()]
                    );
                }
                if !replaced_model && trimmed.starts_with("model:") {
                    replaced_model = true;
                    return format!(
                        "{}model: wework-selected",
                        &line[..line.len() - trimmed.len()]
                    );
                }
                line.to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !replaced_provider || !replaced_model {
            return Err(
                "Harness app bundle does not expose provider/model fields for Wework binding"
                    .to_string(),
            );
        }
        fs::write(&patch_path, format!("{patched}\n"))
            .map_err(|error| format!("Failed to write instance model patch: {error}"))?;
    }
    Ok(install_package)
}

fn write_wework_model_settings(home: &Path, base_url: &str) -> Result<(), String> {
    let base_url = base_url.trim_end_matches('/');
    let settings = format!(
        "llm-pi-ai:\n  providers:\n    wework-local:\n      displayName: Wework\n      apiKeyEnv: WEWORK_HARNESS_API_KEY\n      api: anthropic-messages\n      baseURL: {base_url}\n      models:\n        - id: wework-selected\n          name: Wework selected model\n"
    );
    fs::write(home.join("settings.yaml"), settings)
        .map_err(|error| format!("Failed to write Wework model settings: {error}"))
}

fn prepare_web_profile(home: &Path, profile: &str) -> Result<(), String> {
    let profile_dir = home.join("profiles").join(profile);
    let _ = fs::remove_dir_all(profile_dir.join("node_modules"));
    let _ = fs::remove_file(profile_dir.join("pnpm-lock.yaml"));
    fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("Failed to create Harness app profile: {error}"))?;
    let package = serde_json::json!({
        "name": format!("dsh-profile-{profile}"),
        "private": true,
        "dependencies": {},
        "dsh": {
            "profile": {
                "bundles": [
                    "@deepseek-ai/dsh-base",
                    "@deepseek-ai/dsh-web-app"
                ]
            }
        }
    });
    fs::write(
        profile_dir.join("package.json"),
        serde_json::to_vec_pretty(&package)
            .map_err(|error| format!("Failed to serialize Harness app profile: {error}"))?,
    )
    .map_err(|error| format!("Failed to write Harness app profile: {error}"))?;
    fs::write(profile_dir.join("cordis.yml"), "[]\n")
        .map_err(|error| format!("Failed to write Harness app profile root: {error}"))?;
    fs::write(profile_dir.join("cordis.patch.yml"), "[]\n")
        .map_err(|error| format!("Failed to write Harness app profile patch: {error}"))?;
    fs::write(
        profile_dir.join("pnpm-workspace.yaml"),
        "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
    )
    .map_err(|error| format!("Failed to write Harness app profile workspace: {error}"))
}

#[tauri::command]
pub async fn start_harness_app(
    app: tauri::AppHandle,
    state: State<'_, HarnessAppRuntimeState>,
    installation_id: String,
    model_base_url: Option<String>,
) -> Result<HarnessAppInstallation, String> {
    {
        let mut children = state
            .children
            .lock()
            .map_err(|_| "Harness app runtime lock failed")?;
        if let Some(child) = children.get_mut(&installation_id) {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return read_registry(&app)?
                    .into_iter()
                    .find(|item| item.id == installation_id)
                    .ok_or_else(|| "Harness app installation is missing".to_string());
            }
            children.remove(&installation_id);
        }
    }
    let runtime = {
        let _runtime = state
            .runtime
            .lock()
            .map_err(|_| "Harness app runtime preparation lock failed")?;
        resolve_dsh_runtime(&app)?
    };
    let installation = {
        let _registry = state
            .registry
            .lock()
            .map_err(|_| "Harness app registry lock failed")?;
        read_registry(&app)?
            .into_iter()
            .find(|item| item.id == installation_id)
            .ok_or_else(|| "Harness app installation is missing".to_string())?
    };
    let requirement = dsh_version_requirement(&installation.manifest.requirements.dsh)
        .map_err(|error| format!("DeepSeek Harness version requirement is invalid: {error}"))?;
    if !requirement.matches(&runtime.version) {
        return Err(format!(
            "Harness app requires DeepSeek Harness {}, but Wework provides {}",
            installation.manifest.requirements.dsh, runtime.version
        ));
    }
    let node_requirement = VersionReq::parse(&installation.manifest.requirements.node)
        .map_err(|error| format!("Node version requirement is invalid: {error}"))?;
    if !node_requirement.matches(&runtime.node_version) {
        return Err(format!(
            "Harness app requires Node {}, but Wework provides {}",
            installation.manifest.requirements.node, runtime.node_version
        ));
    }
    let home = root(&app)?.join("instances").join(&installation.id);
    fs::create_dir_all(&home)
        .map_err(|error| format!("Failed to create Harness app home: {error}"))?;
    let use_wework_model = model_base_url
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let install_package = prepare_instance_bundle(&installation, &home, use_wework_model)?;
    prepare_web_profile(&home, &installation.manifest.entry.profile)?;
    if let Some(base_url) = model_base_url.as_deref() {
        write_wework_model_settings(&home, base_url)?;
    }
    let install_args = vec![
        "plugin".to_string(),
        "--profile".to_string(),
        installation.manifest.entry.profile.clone(),
        "add".to_string(),
        "--ignore-scripts".to_string(),
        format!("file:{}", install_package.display()),
    ];
    let output = dsh_command(&runtime, &install_args, &home)
        .output()
        .map_err(|error| format!("Failed to install Harness app bundle: {error}"))?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "DeepSeek Harness rejected the plugin bundle: {}{}{}",
            stdout.trim(),
            if stdout.trim().is_empty() || stderr.trim().is_empty() {
                ""
            } else {
                "\n"
            },
            stderr.trim()
        ));
    }
    let port = free_port()?;
    let args = vec![
        "--profile".to_string(),
        installation.manifest.entry.profile.clone(),
        "--port".to_string(),
        port.to_string(),
    ];
    let mut command = dsh_command(&runtime, &args, &home);
    let log = fs::File::create(home.join("runtime.log"))
        .map_err(|error| format!("Failed to create Harness app runtime log: {error}"))?;
    let error_log = log
        .try_clone()
        .map_err(|error| format!("Failed to open Harness app runtime log: {error}"))?;
    command
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));
    if use_wework_model {
        command.env("WEWORK_HARNESS_API_KEY", "wework-local-router");
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Harness app: {error}"))?;
    let web_url = format!("http://127.0.0.1:{port}/");
    let deadline = Instant::now() + Duration::from_secs(30);
    let readiness_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("Failed to create Harness readiness client: {error}"))?;
    while Instant::now() < deadline {
        if readiness_client
            .get(&web_url)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            let running = (|| {
                let _registry = state
                    .registry
                    .lock()
                    .map_err(|_| "Harness app registry lock failed")?;
                let mut installations = read_registry(&app)?;
                let installation = installations
                    .iter_mut()
                    .find(|item| item.id == installation_id)
                    .ok_or_else(|| {
                        "Harness app installation was removed while starting".to_string()
                    })?;
                installation.state = "running".to_string();
                installation.web_url = Some(web_url);
                installation.runtime_version = Some(runtime.version.to_string());
                installation.error = None;
                let running = installation.clone();
                write_registry(&app, &installations)?;
                Ok::<_, String>(running)
            })();
            let running = match running {
                Ok(running) => running,
                Err(error) => {
                    terminate_process_tree(&mut child);
                    return Err(error);
                }
            };
            state
                .children
                .lock()
                .map_err(|_| "Harness app runtime lock failed")?
                .insert(installation_id, child);
            return Ok(running);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    terminate_process_tree(&mut child);
    Err("Harness app did not become ready within 30 seconds".to_string())
}

#[tauri::command]
pub fn stop_harness_app(
    app: tauri::AppHandle,
    state: State<'_, HarnessAppRuntimeState>,
    installation_id: String,
) -> Result<(), String> {
    if let Some(mut child) = state
        .children
        .lock()
        .map_err(|_| "Harness app runtime lock failed")?
        .remove(&installation_id)
    {
        terminate_process_tree(&mut child);
    }
    let _registry = state
        .registry
        .lock()
        .map_err(|_| "Harness app registry lock failed")?;
    let mut installations = read_registry(&app)?;
    if let Some(item) = installations
        .iter_mut()
        .find(|item| item.id == installation_id)
    {
        item.state = "installed".to_string();
        item.web_url = None;
    }
    write_registry(&app, &installations)
}

pub fn shutdown(state: &HarnessAppRuntimeState) {
    let Ok(mut children) = state.children.lock() else {
        return;
    };
    for (_, mut child) in children.drain() {
        terminate_process_tree(&mut child);
    }
}

#[tauri::command]
pub fn delete_harness_app(
    app: tauri::AppHandle,
    state: State<'_, HarnessAppRuntimeState>,
    installation_id: String,
    delete_data: bool,
) -> Result<(), String> {
    stop_harness_app(app.clone(), state.clone(), installation_id.clone())?;
    let _registry = state
        .registry
        .lock()
        .map_err(|_| "Harness app registry lock failed")?;
    let mut installations = read_registry(&app)?;
    let removed = installations
        .iter()
        .find(|item| item.id == installation_id)
        .cloned()
        .ok_or_else(|| "Harness app installation is missing".to_string())?;
    installations.retain(|item| item.id != installation_id);
    write_registry(&app, &installations)?;
    let package_path = PathBuf::from(removed.package_path);
    let package_root = package_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(package_path);
    let _ = fs::remove_dir_all(package_root);
    if delete_data {
        let _ = fs::remove_dir_all(root(&app)?.join("instances").join(removed.id));
    }
    Ok(())
}

#[cfg(test)]
mod tests;

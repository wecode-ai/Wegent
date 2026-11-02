// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, File, Metadata},
    io::Read,
    path::{Component, Path, PathBuf},
};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use toml_edit::DocumentMut;

use super::plugin_catalog::{
    local_plugin_manifest_path, managed_plugin_root, marketplace_root_from_path, read_json_file,
    registered_codex_cache, resolve_local_plugin_root,
};

const MAX_IMAGE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const UNAVAILABLE: &str = "Plugin image is unavailable";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPluginImageRequest {
    path: String,
}

pub fn read_plugin_image(request: ReadPluginImageRequest) -> Result<Value, String> {
    read_plugin_image_at(
        Path::new(&request.path),
        &crate::agents::wework_codex_home(),
        &super::capabilities::default_manifest_path(),
        &crate::services::workbench::workbench_root()?.join("shared/plugins"),
    )
    .map_err(|_| UNAVAILABLE.to_owned())
}

fn read_plugin_image_at(
    path: &Path,
    codex_home: &Path,
    manifest_path: &Path,
    shared_plugins: &Path,
) -> Result<Value, String> {
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err(UNAVAILABLE.into());
    }
    let canonical = path.canonicalize().map_err(|_| UNAVAILABLE)?;
    if !fs::metadata(&canonical).map_err(|_| UNAVAILABLE)?.is_file() {
        return Err(UNAVAILABLE.into());
    }
    let root = canonical
        .ancestors()
        .skip(1)
        .find(|candidate| local_plugin_manifest_path(candidate).is_ok())
        .ok_or(UNAVAILABLE)?;
    let root_metadata = fs::metadata(root).map_err(|_| UNAVAILABLE)?;
    let plugin = read_metadata(&local_plugin_manifest_path(root)?)?;
    let name = plugin["name"].as_str().ok_or(UNAVAILABLE)?;
    if !registered_plugin_root(root, name, codex_home, manifest_path, shared_plugins) {
        return Err(UNAVAILABLE.into());
    }
    // Do not allow an image symlink to escape, or even alias, another package.
    if path != canonical || !canonical.starts_with(root) {
        // macOS /var is a system symlink, so compare the package-relative spelling too.
        let lexical_root = path
            .ancestors()
            .find(|ancestor| ancestor.canonicalize().ok().as_deref() == Some(root))
            .ok_or(UNAVAILABLE)?;
        reject_relative_symlinks(lexical_root, path)?;
    }
    let mut file = open_package_file(root, &canonical, &root_metadata)?;
    let metadata = file.metadata().map_err(|_| UNAVAILABLE)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
        return Err(UNAVAILABLE.into());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(UNAVAILABLE.into());
    }
    let mime = image_mime_type(&bytes).ok_or(UNAVAILABLE)?;
    Ok(json!({
        "mimeType": mime,
        "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

fn read_metadata(path: &Path) -> Result<Value, String> {
    read_json_file(path, MAX_METADATA_BYTES).map_err(|_| UNAVAILABLE.into())
}

fn registered_plugin_root(
    root: &Path,
    name: &str,
    codex_home: &Path,
    manifest_path: &Path,
    shared_plugins: &Path,
) -> bool {
    let manifest = read_metadata(manifest_path).unwrap_or(Value::Null);
    let capabilities_root = manifest_path.parent().unwrap_or(Path::new(""));
    for entry in manifest["plugins"]
        .as_object()
        .into_iter()
        .flat_map(|entries| entries.values())
    {
        if entry["name"] != name || entry["managed"] == false {
            continue;
        }
        if managed_plugin_root(capabilities_root, shared_plugins, entry)
            .ok()
            .as_deref()
            == Some(root)
        {
            return true;
        }
        if let Some(marketplace) = entry["marketplace"].as_str() {
            if registered_codex_cache(codex_home, marketplace, name, entry).as_deref() == Some(root)
            {
                return true;
            }
        }
    }
    let config = read_codex_config(codex_home);
    if registered_native_cache(root, name, codex_home, config.as_ref()) {
        return true;
    }
    let mut marketplaces = vec![codex_home.join(".tmp/plugins")];
    if let Ok(entries) = fs::read_dir(codex_home.join("plugins/marketplaces")) {
        marketplaces.extend(
            entries
                .flatten()
                .filter_map(|entry| entry.file_type().ok()?.is_dir().then(|| entry.path())),
        );
    }
    if let Some(config) = config {
        for (_, entry) in config
            .get("marketplaces")
            .and_then(|marketplaces| marketplaces.as_table_like())
            .into_iter()
            .flat_map(|entries| entries.iter())
        {
            if let Some(source) = entry.get("source").and_then(|source| source.as_str()) {
                marketplaces.push(PathBuf::from(source));
            }
        }
    }
    marketplaces.into_iter().any(|marketplace| {
        let Ok(marketplace) = marketplace.canonicalize() else {
            return false;
        };
        let marketplace_root = marketplace_root_from_path(&marketplace);
        resolve_local_plugin_root(&marketplace, &marketplace_root, name, &[])
            .ok()
            .as_deref()
            == Some(root)
    })
}

fn read_codex_config(codex_home: &Path) -> Option<DocumentMut> {
    let mut content = String::new();
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(codex_home.join("config.toml")).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    file.take(MAX_METADATA_BYTES + 1)
        .read_to_string(&mut content)
        .ok()?;
    (content.len() <= MAX_METADATA_BYTES as usize)
        .then(|| content.parse::<DocumentMut>().ok())
        .flatten()
}

fn registered_native_cache(
    root: &Path,
    name: &str,
    codex_home: &Path,
    config: Option<&DocumentMut>,
) -> bool {
    let Some(config) = config else { return false };
    let Ok(cache) = codex_home.join("plugins/cache").canonicalize() else {
        return false;
    };
    let Ok(relative) = root.strip_prefix(&cache) else {
        return false;
    };
    let parts = relative.components().collect::<Vec<_>>();
    if parts.len() != 3 || parts[1].as_os_str() != name {
        return false;
    }
    let Some(marketplace) = parts[0].as_os_str().to_str() else {
        return false;
    };
    let expected = codex_home.join("plugins/cache").join(relative);
    if reject_relative_symlinks(codex_home, &expected).is_err() {
        return false;
    }
    config
        .get("plugins")
        .and_then(|plugins| plugins.get(format!("{name}@{marketplace}")))
        .is_some()
}

fn reject_relative_symlinks(root: &Path, path: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for part in path
        .strip_prefix(root)
        .map_err(|_| UNAVAILABLE)?
        .components()
    {
        current.push(part);
        if fs::symlink_metadata(&current)
            .map_err(|_| UNAVAILABLE)?
            .file_type()
            .is_symlink()
        {
            return Err(UNAVAILABLE.into());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn open_package_file(root: &Path, path: &Path, root_metadata: &Metadata) -> Result<File, String> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{MetadataExt, OpenOptionsExt},
            },
        },
    };
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(root)
        .map_err(|_| UNAVAILABLE)?;
    let opened = file.metadata().map_err(|_| UNAVAILABLE)?;
    if opened.dev() != root_metadata.dev() || opened.ino() != root_metadata.ino() {
        return Err(UNAVAILABLE.into());
    }
    let parts = path
        .strip_prefix(root)
        .map_err(|_| UNAVAILABLE)?
        .components()
        .collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        let name = CString::new(part.as_os_str().as_bytes()).map_err(|_| UNAVAILABLE)?;
        let directory_flag = if index + 1 < parts.len() {
            libc::O_DIRECTORY
        } else {
            0
        };
        // Each component is opened relative to the already-held directory, never via a symlink.
        let fd = unsafe {
            libc::openat(
                file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | directory_flag,
            )
        };
        if fd < 0 {
            return Err(UNAVAILABLE.into());
        }
        file = unsafe { File::from_raw_fd(fd) };
    }
    if !file.metadata().map_err(|_| UNAVAILABLE)?.is_file() {
        return Err(UNAVAILABLE.into());
    }
    Ok(file)
}

#[cfg(windows)]
fn open_package_file(root: &Path, path: &Path, _: &Metadata) -> Result<File, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let file = File::open(path).map_err(|_| UNAVAILABLE)?;
    let mut buffer = vec![0_u16; 32768];
    // Validate the opened handle, so a concurrent reparse-point swap cannot expose another file.
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if size == 0 || size >= buffer.len() {
        return Err(UNAVAILABLE.into());
    }
    let opened = PathBuf::from(String::from_utf16(&buffer[..size]).map_err(|_| UNAVAILABLE)?);
    if opened != path || !opened.starts_with(root) {
        return Err(UNAVAILABLE.into());
    }
    Ok(file)
}

fn image_mime_type(bytes: &[u8]) -> Option<&'static str> {
    match image::guess_format(bytes).ok() {
        Some(image::ImageFormat::Png) => Some("image/png"),
        Some(image::ImageFormat::Jpeg) => Some("image/jpeg"),
        Some(image::ImageFormat::Gif) => Some("image/gif"),
        Some(image::ImageFormat::WebP) => Some("image/webp"),
        Some(image::ImageFormat::Bmp) => Some("image/bmp"),
        _ => {
            let text = std::str::from_utf8(bytes)
                .ok()?
                .trim_start_matches('\u{feff}')
                .trim_start();
            (text.starts_with("<svg") || (text.starts_with("<?xml") && text.contains("<svg")))
                .then_some("image/svg+xml")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"/>";

    fn fixture() -> (TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path().join("personal");
        let plugin = marketplace.join("plugins/test-logo");
        fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
        fs::create_dir_all(plugin.join("assets")).unwrap();
        fs::write(
            plugin.join(".codex-plugin/plugin.json"),
            r#"{"name":"test-logo"}"#,
        )
        .unwrap();
        fs::write(plugin.join("assets/logo.svg"), SVG).unwrap();
        let codex = temp.path().join("codex");
        fs::create_dir_all(&codex).unwrap();
        fs::write(
            codex.join("config.toml"),
            format!(
                "[marketplaces.personal]\nsource = {:?}\nsource_type = 'local'\n",
                marketplace.to_str().unwrap()
            ),
        )
        .unwrap();
        (temp, codex, plugin)
    }

    fn read(temp: &TempDir, codex: &Path, path: &Path) -> Result<Value, String> {
        read_plugin_image_at(
            path,
            codex,
            &temp.path().join("manifest.json"),
            &temp.path().join("shared"),
        )
    }

    #[test]
    fn reads_registered_plugin_image_and_rejects_unregistered_device() {
        let (temp, codex, plugin) = fixture();
        let result = read(&temp, &codex, &plugin.join("assets/logo.svg")).unwrap();
        assert_eq!(result["mimeType"], "image/svg+xml");
        assert_eq!(
            result["bytesBase64"],
            base64::engine::general_purpose::STANDARD.encode(SVG)
        );
        assert!(read(
            &temp,
            &temp.path().join("other-device"),
            &plugin.join("assets/logo.svg")
        )
        .is_err());
    }

    #[test]
    fn rejects_traversal_missing_non_image_and_oversized_files() {
        let (temp, codex, plugin) = fixture();
        fs::write(plugin.join("assets/private.svg"), "credential-shaped text").unwrap();
        fs::write(
            plugin.join("assets/large.svg"),
            vec![b'X'; MAX_IMAGE_BYTES as usize + 1],
        )
        .unwrap();
        for path in [
            plugin.join("assets/../assets/logo.svg"),
            plugin.join("assets/missing.svg"),
            plugin.join("assets/private.svg"),
            plugin.join("assets/large.svg"),
        ] {
            assert!(read(&temp, &codex, &path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn reads_only_configured_native_cache_members() {
        let (temp, codex, plugin) = fixture();
        let cache = codex.join("plugins/cache/personal/test-logo/1.0.0");
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        fs::rename(&plugin, &cache).unwrap();
        fs::write(
            codex.join("config.toml"),
            "[plugins.'test-logo@personal']\nenabled = true\n",
        )
        .unwrap();
        assert!(read(&temp, &codex, &cache.join("assets/logo.svg")).is_ok());
        fs::write(codex.join("config.toml"), "[plugins]\n").unwrap();
        assert!(read(&temp, &codex, &cache.join("assets/logo.svg")).is_err());
    }

    #[test]
    fn reads_exact_registered_shared_package_and_rejects_wrong_digest() {
        let (temp, codex, plugin) = fixture();
        let shared = temp.path().join("shared");
        fs::create_dir(&shared).unwrap();
        let digest = "a".repeat(64);
        let package = shared.join(&digest);
        fs::rename(plugin, &package).unwrap();
        let manifest = temp.path().join("manifest.json");
        let entry = |checksum: &str| {
            json!({"plugins": {"test-logo@personal": {
                "name":"test-logo", "marketplace":"personal", "managed":true,
                "store_path":package, "checksum":checksum
            }}})
        };
        fs::write(&manifest, entry(&digest).to_string()).unwrap();
        assert!(read(&temp, &codex, &package.join("assets/logo.svg")).is_ok());
        fs::write(&manifest, entry(&"b".repeat(64)).to_string()).unwrap();
        assert!(read(&temp, &codex, &package.join("assets/logo.svg")).is_err());
    }

    #[test]
    fn stale_store_path_authorizes_only_the_current_shared_package() {
        let (temp, codex, plugin) = fixture();
        fs::write(codex.join("config.toml"), "[plugins]\n").unwrap();
        let shared = temp.path().join("shared");
        let digest = "a".repeat(64);
        let package = shared.join(&digest);
        fs::create_dir(&shared).unwrap();
        fs::rename(plugin, &package).unwrap();
        let old_package = temp.path().join("old-home/shared/plugins").join(&digest);
        fs::create_dir_all(old_package.join(".codex-plugin")).unwrap();
        fs::create_dir_all(old_package.join("assets")).unwrap();
        fs::write(
            old_package.join(".codex-plugin/plugin.json"),
            r#"{"name":"test-logo"}"#,
        )
        .unwrap();
        fs::write(old_package.join("assets/logo.svg"), SVG).unwrap();
        fs::write(
            temp.path().join("manifest.json"),
            json!({"plugins": {"test-logo@personal": {
                "name":"test-logo", "marketplace":"personal", "managed":true,
                "store_path":old_package, "checksum":format!("sha256:{digest}")
            }}})
            .to_string(),
        )
        .unwrap();

        let image = read(&temp, &codex, &package.join("assets/logo.svg")).unwrap();
        assert_eq!(
            image["bytesBase64"],
            base64::engine::general_purpose::STANDARD.encode(SVG)
        );
        assert!(read(&temp, &codex, &old_package.join("assets/logo.svg")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_and_directory_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let (temp, codex, plugin) = fixture();
        let external = temp.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("logo.svg"), SVG).unwrap();
        symlink(external.join("logo.svg"), plugin.join("assets/escape.svg")).unwrap();
        symlink(&external, plugin.join("assets/escape-dir")).unwrap();
        symlink(
            plugin.join("assets/logo.svg"),
            plugin.join("assets/alias.svg"),
        )
        .unwrap();
        for path in [
            plugin.join("assets/escape.svg"),
            plugin.join("assets/escape-dir/logo.svg"),
            plugin.join("assets/alias.svg"),
        ] {
            assert!(read(&temp, &codex, &path).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_regular_files_without_blocking() {
        use std::{
            ffi::CString,
            os::unix::ffi::OsStrExt,
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        const CHILD_ENV: &str = "WEWORK_PLUGIN_IMAGE_FIFO_CHILD";
        if std::env::var(CHILD_ENV).as_deref() == Ok("1") {
            let (temp, codex, plugin) = fixture();
            let fifo = plugin.join("assets/fifo.svg");
            let create_fifo = |path: &Path| {
                let name = CString::new(path.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            };
            create_fifo(&fifo);
            assert!(read(&temp, &codex, &fifo).is_err());
            let root = plugin.canonicalize().unwrap();
            assert!(open_package_file(
                &root,
                &fifo.canonicalize().unwrap(),
                &fs::metadata(&root).unwrap()
            )
            .is_err());
            assert!(read_metadata(&fifo).is_err());
            fs::remove_file(codex.join("config.toml")).unwrap();
            create_fifo(&codex.join("config.toml"));
            assert!(read_codex_config(&codex).is_none());
            return;
        }
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "local::plugin_images::tests::rejects_non_regular_files_without_blocking",
            ])
            .env(CHILD_ENV, "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "FIFO checks failed in isolated child");
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("Plugin image FIFO read blocked for five seconds");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

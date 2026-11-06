// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Bounded ZIP scanning, plugin selection and immutable tree equivalence.

use anyhow::{Result, bail};
use rustpython_ast::{Fold, text_size::TextRange};
use rustpython_parser::Parse;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read, Write},
};
use unicode_normalization::UnicodeNormalization;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const MAXIMUM: usize = 50 * 1024 * 1024;
const MANIFESTS: [&str; 2] = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"];
#[derive(Clone)]
pub struct File {
    pub bytes: Vec<u8>,
    pub mode: u32,
    pub directory: bool,
    pub modified: Option<zip::DateTime>,
}
pub struct Package {
    pub bytes: Vec<u8>,
    pub manifest: Value,
    pub name: String,
    pub version: String,
    pub display: String,
    pub description: String,
    pub interface: Value,
    pub components: Value,
    pub scan: Value,
}

pub fn prepare(bytes: Vec<u8>, remote: &str) -> Result<Package> {
    let (files, _) = scan(&bytes)?;
    let selected = files
        .iter()
        .filter(|(name, _)| MANIFESTS.iter().any(|suffix| name.ends_with(suffix)))
        .filter_map(|(path, file)| {
            let value: Value = serde_json::from_slice(&file.bytes).ok()?;
            (value["name"].as_str() == Some(remote)).then(|| {
                let suffix = MANIFESTS
                    .iter()
                    .find(|suffix| path.ends_with(**suffix))
                    .unwrap();
                path[..path.len() - suffix.len()].to_owned()
            })
        })
        .min_by_key(String::len);
    let bytes = if let Some(root) = selected {
        select(&files, &root)?
    } else {
        bytes
    };
    let (files, scan) = scan(&bytes)?;
    let (path, suffix) = files
        .keys()
        .flat_map(|path| {
            MANIFESTS
                .iter()
                .filter(move |suffix| path.ends_with(**suffix))
                .map(move |suffix| (path, *suffix))
        })
        .min_by_key(|(path, suffix)| {
            let root = &path[..path.len() - suffix.len()];
            (
                root.split('/').filter(|v| !v.is_empty()).count(),
                usize::from(*suffix != MANIFESTS[0]),
                path.len(),
            )
        })
        .ok_or_else(|| anyhow::anyhow!("Plugin manifest is missing"))?;
    let root = path[..path.len() - suffix.len()].to_owned();
    let manifest =
        read_json(&files, path)?.ok_or_else(|| anyhow::anyhow!("Plugin manifest is missing"))?;
    let name = text(&manifest["name"]).unwrap_or_default();
    if name.is_empty() || name != remote {
        bail!("Upstream package does not contain the selected plugin")
    }
    let version = manifest
        .get("version")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string())
        })
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Upstream plugin version is required"))?;
    if !regex::Regex::new(
        r"\A(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\z",
    )
    .expect("source version pattern")
    .is_match(&version)
    {
        bail!("Plugin version must be SemVer")
    }
    if version.len() > 50 {
        bail!("Plugin version is too long")
    }
    let display = text(&manifest["displayName"])
        .or_else(|| text(&manifest["interface"]["displayName"]))
        .unwrap_or_else(|| name.clone());
    let description = text(&manifest["description"])
        .or_else(|| text(&manifest["interface"]["shortDescription"]))
        .or_else(|| text(&manifest["interface"]["longDescription"]))
        .unwrap_or_default();
    let interface = super::metadata::interface(&files, &root, &manifest["interface"])?;
    let components = super::metadata::components(&files, &root, &manifest)?;
    validate_source(&files, &root)?;
    Ok(Package {
        bytes,
        manifest,
        name,
        version,
        display,
        description,
        interface,
        components,
        scan,
    })
}

pub fn scan(bytes: &[u8]) -> Result<(BTreeMap<String, File>, Value)> {
    if bytes.len() > MAXIMUM {
        bail!("Plugin package is too large")
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    if archive.len() > 10000 {
        bail!("Plugin package contains too many files")
    }
    let (mut files, mut normalized, mut expanded, mut executable) =
        (BTreeMap::new(), BTreeSet::new(), 0_u64, Vec::new());
    for index in 0..archive.len() {
        let mut member = archive.by_index(index)?;
        let name = member.name().to_owned();
        let normalized_path = normalize(&name)?;
        if !normalized.insert(normalized_path.clone()) {
            bail!("Duplicate path in plugin ZIP")
        }
        let mode = member.unix_mode().unwrap_or(0);
        if mode & 0o170000 == 0o120000 {
            bail!("Symbolic links are not allowed")
        }
        if member.encrypted() {
            bail!("Encrypted plugin files are not allowed")
        }
        expanded = expanded
            .checked_add(member.size())
            .ok_or_else(|| anyhow::anyhow!("Expanded plugin package is too large"))?;
        if expanded > 200 * 1024 * 1024 {
            bail!("Expanded plugin package is too large")
        }
        let basename = normalized_path
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_lowercase();
        if [
            ".env",
            ".netrc",
            "credentials",
            "credentials.json",
            "id_dsa",
            "id_ed25519",
            "id_rsa",
            "session.json",
        ]
        .contains(&basename.as_str())
            || [".key", ".p12", ".pfx", ".pem"]
                .iter()
                .any(|suffix| basename.ends_with(suffix))
        {
            bail!("Sensitive file is not allowed in plugin package")
        }
        if mode & 0o170000 == 0o100000 && mode & 0o111 != 0 && executable.len() < 200 {
            executable.push(name.clone());
        }
        let directory = member.is_dir();
        let modified = member.last_modified();
        let mut content = Vec::new();
        member
            .by_ref()
            .take(200 * 1024 * 1024 + 1)
            .read_to_end(&mut content)?;
        if content.len() as u64 != member.size() {
            bail!("Invalid plugin ZIP entry size")
        }
        files.insert(
            name,
            File {
                bytes: content,
                mode,
                directory,
                modified,
            },
        );
    }
    let report = json!({"entryCount":archive.len(),"expandedSizeBytes":expanded,"executablePaths":executable});
    Ok((files, report))
}

fn select(files: &BTreeMap<String, File>, root: &str) -> Result<Vec<u8>> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, file) in files {
        if file.directory {
            continue;
        }
        let Some(relative) = name.strip_prefix(root).filter(|v| !v.is_empty()) else {
            continue;
        };
        let mut options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(file.mode);
        if let Some(modified) = file.modified {
            options = options.last_modified_time(modified);
        }
        writer.start_file(relative, options)?;
        writer.write_all(&file.bytes)?;
    }
    Ok(writer.finish()?.into_inner())
}

pub fn read_json(files: &BTreeMap<String, File>, name: &str) -> Result<Option<Value>> {
    files
        .get(name)
        .map(|file| {
            let value: Value = serde_json::from_slice(&file.bytes)?;
            if !value.is_object() {
                bail!("Plugin JSON declaration must be an object")
            }
            Ok(value)
        })
        .transpose()
}
pub fn text(value: &Value) -> Option<String> {
    let raw = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| (!value.is_null()).then(|| value.to_string()))?;
    let raw = raw.trim();
    (!raw.is_empty()).then(|| raw.to_owned())
}
pub fn normalize(path: &str) -> Result<String> {
    if path.starts_with('/') || path.contains('\0') || path.split('/').any(|part| part == "..") {
        bail!("Unsafe path in plugin ZIP")
    }
    Ok(path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/"))
}

fn validate_source(files: &BTreeMap<String, File>, root: &str) -> Result<()> {
    let mut normalized = BTreeSet::new();
    for (name, file) in files {
        if file.directory {
            continue;
        }
        let Some(relative) = name.strip_prefix(root) else {
            bail!("Release artifact contains a file outside plugin root")
        };
        if relative.is_empty()
            || relative.contains('\\')
            || normalize(relative)? != relative
            || !normalized.insert(relative.nfc().collect::<String>())
        {
            bail!("Release artifact contains an invalid or colliding source path")
        }
        if relative.split('/').any(|part| {
            [
                ".git",
                ".pytest_cache",
                "__pycache__",
                "node_modules",
                ".DS_Store",
            ]
            .contains(&part)
        }) {
            bail!("Release artifact contains a non-source path")
        }
        if ![0, 0o100000].contains(&(file.mode & 0o170000)) {
            bail!("Release artifact contains a non-regular source file")
        }
    }
    if let Some(file) = files.get(&format!("{root}.wework-build.json")) {
        if file.bytes.len() > 16384 {
            bail!("Plugin build declaration is too large")
        }
        let value: Value = serde_json::from_slice(&file.bytes)?;
        if value.as_object().is_none_or(|v| v.len() != 3) || value["schemaVersion"] != 1 {
            bail!("Invalid plugin build declaration")
        }
        let entry = value["entrypoint"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid plugin build entrypoint"))?;
        if !entry.starts_with(".wework-build/")
            || !entry.ends_with(".py")
            || normalize(entry)? != entry
            || !files.contains_key(&format!("{root}{entry}"))
        {
            bail!("Invalid plugin build entrypoint")
        }
        let outputs = value["outputs"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 16)
            .ok_or_else(|| anyhow::anyhow!("Invalid plugin build outputs"))?;
        let mut unique = BTreeSet::new();
        for output in outputs {
            let output = output
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid plugin build output"))?;
            if normalize(output)? != output
                || output.starts_with('.')
                || ["scripts", "skills", "assets"].contains(&output)
                || !unique.insert(output)
            {
                bail!("Invalid plugin build output")
            }
            if !files
                .keys()
                .any(|path| path.starts_with(&format!("{root}{output}/")))
            {
                bail!("Plugin build output is missing")
            }
        }
        if unique.iter().any(|a| {
            unique
                .iter()
                .any(|b| a != b && a.starts_with(&format!("{b}/")))
        }) {
            bail!("Plugin build output directories overlap")
        }
    }
    Ok(())
}

pub fn equivalent(left: &[u8], right: &[u8]) -> Result<bool> {
    let (left, _) = scan(left)?;
    let (right, _) = scan(right)?;
    Ok(tree(left)? == tree(right)?)
}
fn tree(files: BTreeMap<String, File>) -> Result<Vec<u8>> {
    let mut hash = Sha256::new();
    for (name, file) in files {
        if file.directory || ["UPSTREAM.md", "upstream.lock.json"].contains(&name.as_str()) {
            continue;
        }
        hash.update(name.as_bytes());
        hash.update([0]);
        let canonical = name.ends_with(".py").then(|| python(&file.bytes)).flatten();
        hash.update(canonical.as_deref().unwrap_or(&file.bytes));
        hash.update([0]);
    }
    Ok(hash.finalize().to_vec())
}
struct EraseLocations;
impl Fold<TextRange> for EraseLocations {
    type TargetU = ();
    type Error = std::convert::Infallible;
    type UserContext = ();
    fn will_map_user(&mut self, _: &TextRange) {}
    fn map_user(&mut self, _: TextRange, _: ()) -> std::result::Result<(), Self::Error> {
        Ok(())
    }
}
fn python(bytes: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let parsed = rustpython_parser::ast::Suite::parse(text, "<plugin>").ok()?;
    let mapped = EraseLocations.fold(parsed).ok()?;
    Some(format!("{mapped:?}").into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    const MANIFEST: &[u8] =
        br#"{"name":"selected","version":"1.0.0-rc.1","interface":{"logo":"assets/logo.svg"}}"#;
    #[test]
    fn multi_plugin_selection_keeps_only_selected_root_and_inlines_its_asset() {
        let bytes = archive(&[
            (
                "catalog/one/.codex-plugin/plugin.json",
                br#"{"name":"other","version":"1"}"#,
            ),
            ("catalog/two/.codex-plugin/plugin.json", MANIFEST),
            ("catalog/two/assets/logo.svg", b"<svg/>"),
            ("catalog/two/commands/run.md", b"run"),
        ]);
        let parsed = prepare(bytes, "selected").unwrap();
        assert_eq!(parsed.name, "selected");
        assert_eq!(parsed.components["commands"][0]["path"], "commands/run.md");
        assert!(
            parsed.interface["logo"]
                .as_str()
                .unwrap()
                .starts_with("data:image/svg+xml;base64,")
        );
        let (files, _) = scan(&parsed.bytes).unwrap();
        assert!(!files.keys().any(|key| key.contains("catalog")));
    }
    #[test]
    fn scans_reject_sensitive_files_and_nfc_colliding_source_paths() {
        assert!(
            prepare(
                archive(&[
                    (".codex-plugin/plugin.json", MANIFEST),
                    ("secrets/session.json", b"{}")
                ]),
                "selected"
            )
            .is_err()
        );
        assert!(
            prepare(
                archive(&[
                    (".codex-plugin/plugin.json", MANIFEST),
                    ("caf\u{e9}.txt", b"one"),
                    ("cafe\u{301}.txt", b"two")
                ]),
                "selected"
            )
            .is_err()
        );
    }
    #[test]
    fn upstream_immutability_ignores_zip_metadata_and_review_notes_but_rejects_changed_code() {
        let one = archive(&[
            (".codex-plugin/plugin.json", MANIFEST),
            ("auth.py", b"x=1 # before\n"),
            ("UPSTREAM.md", b"old"),
        ]);
        let same = archive(&[
            (".codex-plugin/plugin.json", MANIFEST),
            ("auth.py", b"\nx = 1\n"),
            ("UPSTREAM.md", b"new"),
        ]);
        let changed = archive(&[
            (".codex-plugin/plugin.json", MANIFEST),
            ("auth.py", b"x=2\n"),
        ]);
        assert!(equivalent(&one, &same).unwrap());
        assert!(!equivalent(&one, &changed).unwrap());
    }
    #[test]
    fn python_equivalence_removes_locations_without_modifying_literal_content() {
        assert_eq!(python(b"x=1 # comment\n"), python(b"\n\nx = 1\n"));
        assert_ne!(python(b"x='range: 1..2'"), python(b"x='range: 3..4'"));
        assert_ne!(python(b"x=1"), python(b"x=True"));
    }
    #[test]
    fn unsafe_relative_paths_are_rejected() {
        assert!(normalize("a/../b").is_err());
        assert!(normalize("/a").is_err());
        assert_eq!(normalize("./a//b/").unwrap(), "a/b");
    }
}

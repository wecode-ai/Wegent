// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Source-tree identity for protected plugin release artifacts
//! (`app.services.plugin_publication_artifact`).
//!
//! The release key is derived from the validated envelope with
//! `expected_release_idempotency_key`; the GitLab attestation compares the
//! uploaded package with the reviewed source tree through
//! `release_source_tree`. Both hashes keep reviewed bytes exact and normalize
//! only the ZIP root, modes, and path spelling.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};

use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use zip::ZipArchive;

use crate::http_compat::FastApiError;

/// `SOURCE_TREE_HASH_PREFIX`
const SOURCE_TREE_HASH_PREFIX: &[u8] = b"wework-plugin-source-tree-v1\0";
/// `GENERATED_PUBLICATION_FILES`
const GENERATED_PUBLICATION_FILES: [&str; 2] = [".wework-publication.json", "plugin-risk.json"];
/// `IGNORED_SOURCE_DIRECTORY_NAMES`
const IGNORED_SOURCE_DIRECTORY_NAMES: [&str; 4] =
    [".git", ".pytest_cache", "__pycache__", "node_modules"];
/// `IGNORED_SOURCE_FILE_NAMES`
const IGNORED_SOURCE_FILE_NAMES: [&str; 1] = [".DS_Store"];
/// `PLUGIN_MANIFEST_PATHS`
const PLUGIN_MANIFEST_PATHS: [(&str, &str); 2] = [
    (".codex-plugin", "plugin.json"),
    (".claude-plugin", "plugin.json"),
];
/// `shared.plugin_build.DECLARATION`
const BUILD_DECLARATION: &str = ".wework-build.json";

/// One canonical plugin-root-relative source file.
#[derive(Debug, Clone)]
pub struct CanonicalPluginFile {
    pub content: Vec<u8>,
    pub mode: u32,
}

/// `_safe_zip_parts`: reject unsafe segments without erasing them.
fn safe_zip_parts(filename: &str) -> Result<Vec<&str>, FastApiError> {
    if filename.starts_with('/') || filename.contains('\\') || filename.contains('\0') {
        return Err(unsafe_source_path());
    }
    let parts: Vec<&str> = filename.split('/').collect();
    if parts.is_empty() || parts.iter().any(|part| matches!(*part, "" | "." | "..")) {
        return Err(unsafe_source_path());
    }
    Ok(parts)
}

fn unsafe_source_path() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
        "Release artifact contains an unsafe source path",
    )
}

fn unprocessable(detail: impl Into<String>) -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
        detail.into(),
    )
}

/// `_plugin_root_parts`: the manifest-relative root shared by every file.
fn plugin_root_parts(paths: &[Vec<&str>]) -> Result<Vec<String>, FastApiError> {
    let mut candidates: Vec<(usize, usize, Vec<String>)> = Vec::new();
    for parts in paths {
        for (preference, (directory, file)) in PLUGIN_MANIFEST_PATHS.iter().enumerate() {
            let suffix_len = 2;
            if parts.len() < suffix_len {
                continue;
            }
            if parts[parts.len() - 2] == *directory && parts[parts.len() - 1] == *file {
                let root = parts[..parts.len() - suffix_len]
                    .iter()
                    .map(|part| (*part).to_owned())
                    .collect::<Vec<_>>();
                candidates.push((root.len(), preference, root));
            }
        }
    }
    if candidates.is_empty() {
        return Err(unprocessable(
            "Plugin must include .codex-plugin/plugin.json or .claude-plugin/plugin.json",
        ));
    }
    let distinct: BTreeSet<&Vec<String>> =
        candidates.iter().map(|candidate| &candidate.2).collect();
    if distinct.len() != 1 {
        return Err(unprocessable(
            "Release artifact contains multiple plugin roots",
        ));
    }
    candidates.sort();
    Ok(candidates.remove(0).2)
}

/// `canonical_complete_plugin_files(package)`: every regular source file,
/// normalized to the plugin root, NFC paths, and `0o644`/`0o755` modes.
pub fn canonical_complete_plugin_files(
    package: &[u8],
) -> Result<BTreeMap<String, CanonicalPluginFile>, FastApiError> {
    let mut archive =
        ZipArchive::new(Cursor::new(package)).map_err(|_| unprocessable("Invalid plugin ZIP"))?;
    let mut members = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let member = archive
            .by_index_raw(index)
            .map_err(|_| unprocessable("Invalid plugin ZIP"))?;
        if member.is_dir() {
            continue;
        }
        let name = member.name().to_owned();
        let mode = member.unix_mode().unwrap_or(0);
        let size = member.size();
        let data_start = member.data_start();
        let index_id = index;
        members.push((name, mode, size, data_start, index_id));
    }
    let raw_paths = members
        .iter()
        .map(|(name, ..)| safe_zip_parts(name))
        .collect::<Result<Vec<_>, _>>()?;
    let root_parts = plugin_root_parts(&raw_paths)?;
    let mut files = BTreeMap::new();
    let mut normalized_paths: BTreeSet<Vec<u8>> = BTreeSet::new();
    for ((name, mode, _size, _data_start, index), parts) in members.iter().zip(&raw_paths) {
        if parts.len() < root_parts.len()
            || parts[..root_parts.len()]
                .iter()
                .zip(&root_parts)
                .any(|(left, right)| *left != right.as_str())
        {
            return Err(unprocessable(
                "Release artifact contains a regular file outside the plugin root",
            ));
        }
        let relative_parts = &parts[root_parts.len()..];
        let relative = relative_parts.join("/");
        let relative = relative.nfc().collect::<String>();
        if relative.is_empty() {
            continue;
        }
        if relative_parts[..relative_parts.len() - 1]
            .iter()
            .any(|part| IGNORED_SOURCE_DIRECTORY_NAMES.contains(part))
            || IGNORED_SOURCE_FILE_NAMES.contains(&relative_parts[relative_parts.len() - 1])
        {
            return Err(unprocessable(format!(
                "Release artifact contains a non-source path that must be excluded: {relative}"
            )));
        }
        let path_bytes = relative.as_bytes().to_vec();
        if normalized_paths.contains(&path_bytes) {
            return Err(unprocessable(
                "Release artifact contains source paths that collide after NFC normalization",
            ));
        }
        normalized_paths.insert(path_bytes);
        let file_type = mode & 0o170000;
        if !matches!(file_type, 0 | 0o100000) {
            return Err(unprocessable(
                "Release artifact contains a non-regular source file",
            ));
        }
        let normalized_mode = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
        let member = archive
            .by_index(*index)
            .map_err(|_| unprocessable("Invalid plugin ZIP"))?;
        let member_name = member.name().to_owned();
        let mut content = Vec::new();
        member
            .take(200 * 1024 * 1024 + 1)
            .read_to_end(&mut content)
            .map_err(|_| unprocessable("Invalid plugin ZIP"))?;
        debug_assert_eq!(member_name, name.as_str());
        files.insert(
            relative,
            CanonicalPluginFile {
                content,
                mode: normalized_mode,
            },
        );
    }
    Ok(files)
}

/// `read_plugin_root_member`: exactly one generated root file.
pub fn read_plugin_root_member(package: &[u8], filename: &str) -> Result<Vec<u8>, FastApiError> {
    let mut archive =
        ZipArchive::new(Cursor::new(package)).map_err(|_| unprocessable("Invalid plugin ZIP"))?;
    let mut paths = Vec::new();
    let mut matches = Vec::new();
    for index in 0..archive.len() {
        let member = archive
            .by_index(index)
            .map_err(|_| unprocessable("Invalid plugin ZIP"))?;
        if member.is_dir() {
            continue;
        }
        let parts = safe_zip_parts(member.name())?;
        let parts = parts.into_iter().map(str::to_owned).collect::<Vec<_>>();
        if !parts.is_empty() && parts[parts.len() - 1] == filename {
            matches.push(index);
        }
        paths.push(parts);
    }
    let root = plugin_root_parts(
        &paths
            .iter()
            .map(|parts| parts.iter().map(String::as_str).collect())
            .collect::<Vec<_>>(),
    )?;
    let expected = {
        let mut expected = root;
        expected.push(filename.to_owned());
        expected
    };
    let matching = paths.iter().filter(|parts| **parts == expected).count();
    if matching != 1 {
        return Err(unprocessable(format!(
            "Release artifact must contain exactly one root {filename}"
        )));
    }
    let index = matches
        .into_iter()
        .find(|index| {
            archive
                .by_index(*index)
                .map(|member| {
                    let parts = member
                        .name()
                        .split('/')
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    parts == expected
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| {
            unprocessable(format!(
                "Release artifact must contain exactly one root {filename}"
            ))
        })?;
    let mut member = archive
        .by_index(index)
        .map_err(|_| unprocessable("Invalid plugin ZIP"))?;
    let mut content = Vec::new();
    member
        .read_to_end(&mut content)
        .map_err(|_| unprocessable("Invalid plugin ZIP"))?;
    Ok(content)
}

/// `canonical_source_tree_sha256_from_files`.
pub fn canonical_source_tree_sha256_from_files(
    files: &BTreeMap<String, CanonicalPluginFile>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(SOURCE_TREE_HASH_PREFIX);
    let mut records: Vec<(&String, &CanonicalPluginFile)> = files.iter().collect();
    records.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    for (path, file) in records {
        let path_bytes = path.as_bytes();
        digest.update((path_bytes.len() as u32).to_be_bytes());
        digest.update(path_bytes);
        digest.update((file.mode as u16).to_be_bytes());
        digest.update((file.content.len() as u64).to_be_bytes());
        digest.update(&file.content);
    }
    format!("{:x}", digest.finalize())
}

/// `release_source_tree(package, include_metadata=True)`.
///
/// Returns the reviewed source-tree digest and whether the package declares a
/// plugin build (generated outputs require the GitLab attestation).
pub fn release_source_tree(
    package: &[u8],
    include_metadata: bool,
) -> Result<(String, bool), FastApiError> {
    let files = canonical_complete_plugin_files(package)?;
    let contents: BTreeMap<String, Vec<u8>> = files
        .iter()
        .map(|(path, file)| (path.clone(), file.content.clone()))
        .collect();
    let declaration = build_declaration(&contents)?;
    let built = declaration.is_some();
    let mut paths = source_paths(&contents, &declaration, built)?;
    if !include_metadata {
        for generated in GENERATED_PUBLICATION_FILES {
            paths.remove(generated);
        }
    }
    let selected: BTreeMap<String, CanonicalPluginFile> = paths
        .into_iter()
        .filter_map(|path| files.get(&path).map(|file| (path, file.clone())))
        .collect();
    Ok((canonical_source_tree_sha256_from_files(&selected), built))
}

/// `shared.plugin_build.declaration`: validate the optional build declaration.
fn build_declaration(
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<Option<BuildDeclaration>, FastApiError> {
    let Some(raw) = files.get(BUILD_DECLARATION) else {
        return Ok(None);
    };
    if raw.len() > 16384 {
        return Err(unprocessable("Plugin build declaration is too large"));
    }
    let value: serde_json::Value = serde_json::from_slice(raw)
        .map_err(|_| unprocessable("Invalid plugin build declaration"))?;
    let Some(object) = value.as_object() else {
        return Err(unprocessable("Invalid plugin build declaration"));
    };
    if object.len() != 3
        || !object.contains_key("schemaVersion")
        || !object.contains_key("entrypoint")
        || !object.contains_key("outputs")
    {
        return Err(unprocessable("Invalid plugin build declaration"));
    }
    if object["schemaVersion"].as_i64() != Some(1) {
        return Err(unprocessable("Unsupported plugin build schema"));
    }
    let entry = relative_build_path(object["entrypoint"].as_str().unwrap_or(""))?;
    if !entry.starts_with(".wework-build/")
        || !entry.ends_with(".py")
        || !files.contains_key(&entry)
    {
        return Err(unprocessable(
            "Plugin build entrypoint must be bundled under .wework-build",
        ));
    }
    let Some(outputs) = object["outputs"].as_array() else {
        return Err(unprocessable(
            "Plugin build outputs must declare 1 to 16 directories",
        ));
    };
    if outputs.is_empty() || outputs.len() > 16 {
        return Err(unprocessable(
            "Plugin build outputs must declare 1 to 16 directories",
        ));
    }
    let mut normalized = Vec::with_capacity(outputs.len());
    for output in outputs {
        let output = relative_build_path(output.as_str().unwrap_or(""))?;
        if output.starts_with('.') || matches!(output.as_str(), "scripts" | "skills" | "assets") {
            return Err(unprocessable(
                "Plugin build output cannot replace source or metadata roots",
            ));
        }
        normalized.push(output);
    }
    let unique: BTreeSet<&String> = normalized.iter().collect();
    if unique.len() != normalized.len()
        || normalized.iter().any(|left| {
            normalized
                .iter()
                .any(|right| left != right && left.starts_with(&format!("{right}/")))
        })
    {
        return Err(unprocessable("Plugin build output directories overlap"));
    }
    Ok(Some(BuildDeclaration {
        outputs: normalized,
    }))
}

fn relative_build_path(value: &str) -> Result<String, FastApiError> {
    if value.is_empty()
        || value.contains('\\')
        || value.starts_with('/')
        || value.split('/').any(|part| part == "..")
    {
        return Err(unprocessable(
            "Plugin build paths must be normalized and contained",
        ));
    }
    let normalized = value
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    if normalized != value {
        return Err(unprocessable(
            "Plugin build paths must be normalized and contained",
        ));
    }
    Ok(normalized)
}

/// `shared.plugin_build.source_paths`.
fn source_paths(
    files: &BTreeMap<String, Vec<u8>>,
    declaration: &Option<BuildDeclaration>,
    require_outputs: bool,
) -> Result<BTreeSet<String>, FastApiError> {
    let Some(declaration) = declaration else {
        return Ok(files.keys().cloned().collect());
    };
    if require_outputs
        && declaration.outputs.iter().any(|output| {
            !files
                .keys()
                .any(|path| path.starts_with(&format!("{output}/")))
        })
    {
        return Err(unprocessable(
            "Plugin build output is missing; publish the completed build",
        ));
    }
    Ok(files
        .keys()
        .filter(|path| {
            !declaration
                .outputs
                .iter()
                .any(|output| *path == output || path.starts_with(&format!("{output}/")))
        })
        .cloned()
        .collect())
}

struct BuildDeclaration {
    outputs: Vec<String>,
}

/// `RELEASE_IDEMPOTENCY_KEY_PATTERN` (`wework-plugin-v1:[0-9a-f]{64}`).
fn is_release_idempotency_key(key: &str) -> bool {
    let Some(digest) = key.strip_prefix("wework-plugin-v1:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// `validate_release_idempotency_key_format`: before database access.
pub fn validate_idempotency_key_format(key: &str) -> Result<(), FastApiError> {
    if !is_release_idempotency_key(key) {
        return Err(unprocessable("Invalid Idempotency-Key format"));
    }
    Ok(())
}

/// `expected_release_idempotency_key`: the key the protected GitLab client
/// derives from the release envelope.
pub fn expected_release_idempotency_key(envelope: &serde_json::Value) -> Option<String> {
    let project_id = envelope["source"]["projectId"].as_str()?;
    let commit_sha = envelope["source"]["sourceCommitSha"].as_str()?;
    let artifact_sha = envelope["artifact"]["sha256"].as_str()?;
    let identity = format!("{project_id}\u{0}{commit_sha}\u{0}{artifact_sha}");
    let digest = Sha256::digest(identity.as_bytes());
    Some(format!("wework-plugin-v1:{digest:x}"))
}

/// `validate_release_idempotency_key`: format, then the envelope-derived key.
pub fn validate_release_idempotency_key(
    key: &str,
    envelope: &serde_json::Value,
) -> Result<(), FastApiError> {
    validate_idempotency_key_format(key)?;
    if expected_release_idempotency_key(envelope).as_deref() != Some(key) {
        return Err(unprocessable(
            "Idempotency-Key does not match the release artifact",
        ));
    }
    Ok(())
}

/// `canonical_release_envelope` plus `release_envelope_sha256`: sorted keys,
/// compact separators, UTF-8.
pub fn release_envelope_sha256(envelope: &serde_json::Value) -> String {
    let mut canonical = String::new();
    write_canonical(envelope, &mut canonical);
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

fn write_canonical(value: &serde_json::Value, output: &mut String) {
    match value {
        serde_json::Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            output.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key).expect("JSON object keys always serialize"),
                );
                output.push(':');
                write_canonical(&object[key], output);
            }
            output.push('}');
        }
        serde_json::Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(item, output);
            }
            output.push(']');
        }
        other => {
            output.push_str(&serde_json::to_string(other).expect("JSON scalars always serialize"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn canonical_files_normalize_the_plugin_root_and_modes() {
        let bytes = archive(&[
            (
                "nested/.codex-plugin/plugin.json",
                br#"{"name":"demo","version":"1.0.0"}"#,
            ),
            ("nested/scripts/run.py", b"print(1)\n"),
        ]);
        let files = canonical_complete_plugin_files(&bytes).unwrap();
        assert_eq!(
            files.keys().cloned().collect::<Vec<_>>(),
            vec![
                ".codex-plugin/plugin.json".to_owned(),
                "scripts/run.py".to_owned()
            ]
        );
        assert!(files.values().all(|file| file.mode == 0o644));
    }

    #[test]
    fn multiple_roots_and_generated_files_are_rejected_or_ignored() {
        let bytes = archive(&[
            ("a/.codex-plugin/plugin.json", b"{}"),
            ("b/.claude-plugin/plugin.json", b"{}"),
        ]);
        assert!(canonical_complete_plugin_files(&bytes).is_err());

        let bytes = archive(&[
            (".codex-plugin/plugin.json", b"{}"),
            ("node_modules/dep/index.js", b""),
        ]);
        assert!(canonical_complete_plugin_files(&bytes).is_err());
    }

    #[test]
    fn release_source_tree_hashes_reviewed_inputs_only() {
        let bytes = archive(&[
            (
                ".codex-plugin/plugin.json",
                br#"{"name":"demo","version":"1.0.0"}"#,
            ),
            ("plugin-risk.json", br#"{"schemaVersion":1}"#),
        ]);
        let (with_metadata, built) = release_source_tree(&bytes, true).unwrap();
        let (without_metadata, _) = release_source_tree(&bytes, false).unwrap();
        assert!(!built);
        assert_ne!(with_metadata, without_metadata);
    }

    #[test]
    fn a_build_declaration_separates_generated_outputs() {
        let bytes = archive(&[
            (".codex-plugin/plugin.json", br#"{"name":"demo"}"#),
            (
                ".wework-build.json",
                br#"{"schemaVersion":1,"entrypoint":".wework-build/build.py","outputs":["dist"]}"#,
            ),
            (".wework-build/build.py", b""),
            ("dist/app.js", b"built"),
        ]);
        let (digest, built) = release_source_tree(&bytes, true).unwrap();
        assert!(built);
        let files = canonical_complete_plugin_files(&bytes).unwrap();
        let reviewed = files
            .iter()
            .filter(|(path, _)| !path.starts_with("dist/"))
            .map(|(path, file)| (path.clone(), file.clone()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(digest, canonical_source_tree_sha256_from_files(&reviewed));
    }
}

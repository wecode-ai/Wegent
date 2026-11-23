// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;

use super::*;

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
fn parses_the_codex_manifest_and_component_inventory() {
    let package = archive(&[
        (
            ".codex-plugin/plugin.json",
            br#"{"name":"pipeline-plugin","version":"1.2.3","description":"Pipeline contract","interface":{"logo":"assets/logo.svg"}}"#,
        ),
        ("commands/run.md", b"run"),
        (
            "skills/demo/SKILL.md",
            b"---\nname: demo-skill\ndescription: Demo\n---\n",
        ),
        ("assets/logo.svg", b"<svg/>"),
    ]);
    let parsed = parse(&package).expect("valid package");
    assert_eq!(parsed.name, "pipeline-plugin");
    assert_eq!(parsed.version.as_deref(), Some("1.2.3"));
    assert_eq!(parsed.description, "Pipeline contract");
    assert_eq!(parsed.components["commands"][0]["name"], "run");
    assert_eq!(parsed.components["skills"][0]["name"], "demo-skill");
    assert!(
        parsed.interface.as_ref().unwrap()["logo"]
            .as_str()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,")
    );
}

#[test]
fn a_package_without_a_manifest_is_rejected() {
    let package = archive(&[("readme.md", b"hello")]);
    let error = parse(&package).unwrap_err();
    assert_eq!(
        error.detail_message(),
        Some("Plugin must include .codex-plugin/plugin.json or .claude-plugin/plugin.json")
    );
}

#[test]
fn version_is_optional_and_name_is_required() {
    let package = archive(&[(".codex-plugin/plugin.json", br#"{"name":"demo"}"#)]);
    let parsed = parse(&package).unwrap();
    assert_eq!(parsed.version, None);

    let package = archive(&[(".codex-plugin/plugin.json", br#"{"version":"1.0.0"}"#)]);
    assert_eq!(
        parse(&package).unwrap_err().detail_message(),
        Some("Plugin manifest must include a non-empty name")
    );
}

#[test]
fn account_auth_adapters_must_be_packaged() {
    let manifest = br#"{"name":"demo","version":"1.0.0","connectors":[{"slug":"demo","accountAuth":{"credentialType":"bearer","adapter":"auth/demo.py"}}]}"#;
    let package = archive(&[(".codex-plugin/plugin.json", manifest)]);
    assert_eq!(
        parse(&package).unwrap_err().detail_message(),
        Some("Account auth adapter is missing from plugin package")
    );
    let package = archive(&[
        (".codex-plugin/plugin.json", manifest),
        ("auth/demo.py", b""),
    ]);
    let parsed = parse(&package).unwrap();
    assert_eq!(parsed.components["connectors"][0]["slug"], "demo");
}

use super::*;

fn write_inventory_file(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn write_inventory_manifest(root: &Path, relative: &str, manifest: Value) {
    write_inventory_file(root, relative, &manifest.to_string());
}

#[test]
fn plugin_inventory_matches_shared_discovery_cases() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../shared/protocol/plugin_skill_discovery_cases.json"
    )))
    .unwrap();
    for case in cases {
        for manifest_path in PLUGIN_MANIFEST_PATHS {
            let temp = tempfile::tempdir().unwrap();
            let plugins = temp.path().join("plugins");
            let plugin = plugins.join("cache/openai-curated-remote/cache-name/1.2.3");
            write_inventory_manifest(&plugin, manifest_path, case["manifest"].clone());
            for directory in case["directories"].as_array().unwrap() {
                fs::create_dir_all(plugin.join(directory.as_str().unwrap())).unwrap();
            }
            for file in case["files"].as_array().unwrap() {
                write_inventory_file(&plugin, file.as_str().unwrap(), "# Skill");
            }

            let entries = scan_plugin_dir(&plugins, "codex-plugin");

            let mut paths = Vec::new();
            for entry in entries {
                let path = Path::new(&entry.path);
                assert!(path.is_absolute() && path.is_file());
                assert_eq!(path.file_name().unwrap(), "SKILL.md");
                let relative = path.parent().unwrap().strip_prefix(&plugin).unwrap();
                paths.push(if relative.as_os_str().is_empty() {
                    ".".to_owned()
                } else {
                    relative.to_string_lossy().replace('\\', "/")
                });
                assert_eq!(entry.source, "codex-plugin");
                if paths.last().unwrap() == "." {
                    assert_eq!(entry.name, "example");
                }
            }
            paths.sort();
            assert_eq!(
                json!(paths),
                case["paths"],
                "{}: {manifest_path}",
                case["name"]
            );
        }
    }
}

#[test]
fn plugin_inventory_uses_codex_manifest_precedence() {
    let temp = tempfile::tempdir().unwrap();
    let plugins = temp.path().join("plugins");
    let plugin = plugins.join("example");
    for (manifest, selection) in PLUGIN_MANIFEST_PATHS.into_iter().zip(["codex", "claude"]) {
        write_inventory_manifest(&plugin, manifest, json!({"skills":selection}));
        write_inventory_file(&plugin, &format!("{selection}/SKILL.md"), "# Skill");
    }
    write_inventory_file(&plugin, "SKILL.md", "# Root");
    write_inventory_file(&plugin, "codex/references/example/SKILL.md", "# Reference");

    let entries = scan_plugin_dir(&plugins, "codex-plugin");

    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].path,
        plugin.join("codex/SKILL.md").to_string_lossy()
    );
    write_inventory_manifest(&plugin, PLUGIN_MANIFEST_PATHS[0], json!({"skills":[]}));
    assert!(scan_plugin_dir(&plugins, "codex-plugin").is_empty());
    fs::remove_file(plugin.join(PLUGIN_MANIFEST_PATHS[0])).unwrap();
    let entries = scan_plugin_dir(&plugins, "codex-plugin");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].path,
        plugin.join("claude/SKILL.md").to_string_lossy()
    );
}

#[test]
fn plugin_inventory_uses_nearest_manifest_root() {
    let temp = tempfile::tempdir().unwrap();
    let plugins = temp.path().join("plugins");
    let parent = plugins.join("cache/provider/package/3.0");
    let child = parent.join("skills/nested");
    write_inventory_manifest(&parent, PLUGIN_MANIFEST_PATHS[0], json!({}));
    write_inventory_file(&parent, "skills/parent/SKILL.md", "# Parent");
    write_inventory_manifest(&child, PLUGIN_MANIFEST_PATHS[1], json!({"skills":"review"}));
    write_inventory_file(&child, "SKILL.md", "# Excluded root");
    write_inventory_file(&child, "review/SKILL.md", "# Review");
    write_inventory_file(&child, "review/references/example/SKILL.md", "# Reference");

    let entries = scan_plugin_dir(&plugins, "codex-plugin");

    let paths: HashSet<_> = entries
        .iter()
        .map(|entry| PathBuf::from(&entry.path))
        .collect();
    assert_eq!(
        paths,
        HashSet::from([
            parent.join("skills/parent/SKILL.md"),
            child.join("review/SKILL.md"),
        ])
    );
    assert_eq!(entries.len(), 2);
    for entry in entries {
        assert_eq!(entry.plugin_name.as_deref(), Some("package"));
        assert_eq!(entry.plugin_provider.as_deref(), Some("provider"));
        assert_eq!(entry.plugin_version.as_deref(), Some("3.0"));
    }
}

#[test]
fn plugin_inventory_resolves_relative_collection_roots_with_parent_components() {
    let current = env::current_dir().unwrap();
    let temp = tempfile::tempdir_in(&current).unwrap();
    fs::create_dir(temp.path().join("working")).unwrap();
    let plugins = temp.path().join("home/plugins");
    let plugin = plugins.join("cache/provider/example/1.2.3");
    write_inventory_manifest(&plugin, PLUGIN_MANIFEST_PATHS[0], json!({}));
    write_inventory_file(&plugin, "SKILL.md", "# Skill");
    let relative = temp
        .path()
        .strip_prefix(&current)
        .unwrap()
        .join("working/../home/plugins");

    let entries = scan_plugin_dir(&relative, "codex-plugin");

    assert_eq!(entries.len(), 1);
    let skill_path = Path::new(&entries[0].path);
    assert!(skill_path.is_absolute());
    assert!(!skill_path
        .components()
        .any(|part| matches!(part, Component::ParentDir)));
    assert_eq!(
        fs::canonicalize(skill_path).unwrap(),
        fs::canonicalize(plugin.join("SKILL.md")).unwrap()
    );
    assert_eq!(entries[0].plugin_provider.as_deref(), Some("provider"));
    assert_eq!(entries[0].plugin_version.as_deref(), Some("1.2.3"));
}

#[cfg(any(unix, windows))]
#[test]
fn plugin_inventory_prunes_child_owned_symlinks_before_scanning_parent() {
    for manifest in [
        json!({}),
        json!({"skills": ["skills/parent", "skills/nested"]}),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let plugins = temp.path().join("plugins");
        let parent = plugins.join("example");
        let child = parent.join("skills/nested");
        let external = temp.path().join("external");
        write_inventory_manifest(&parent, PLUGIN_MANIFEST_PATHS[0], manifest);
        write_inventory_file(&parent, "skills/parent/SKILL.md", "# Parent");
        write_inventory_manifest(
            &child,
            PLUGIN_MANIFEST_PATHS[1],
            json!({"skills": "review"}),
        );
        write_inventory_file(&external, "SKILL.md", "# External");
        crate::directory_link::create(&external, &child.join("review")).unwrap();

        let entries = scan_plugin_dir(&plugins, "codex-plugin");

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].path,
            parent.join("skills/parent/SKILL.md").to_string_lossy()
        );
        assert!(super::super::capabilities::scan_plugin_skills(&child).is_err());
    }
}

#[test]
fn plugin_inventory_keeps_readable_siblings_and_lossy_skill_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let plugins = temp.path().join("plugins");
    let plugin = plugins.join("example");
    write_inventory_manifest(&plugin, PLUGIN_MANIFEST_PATHS[0], json!({}));
    write_inventory_file(&plugin, "skills/alpha/SKILL.md", "---\nname: Alpha\n---\n");
    write_inventory_file(&plugin, "skills/zeta/SKILL.md", "# Placeholder");
    fs::write(
        plugin.join("skills/zeta/SKILL.md"),
        b"---\nname: Zeta\ndescription: bad \xff byte\n---\n",
    )
    .unwrap();

    let entries = scan_plugin_dir(&plugins, "codex-plugin");

    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|entry| entry.name == "Alpha"));
    assert!(entries
        .iter()
        .any(|entry| entry.name == "Zeta" && entry.description == "bad \u{fffd} byte"));
    assert!(super::super::capabilities::scan_plugin_skills(&plugin).is_err());
}

#[test]
fn plugin_inventory_ignores_nested_frontmatter_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let plugins = temp.path().join("plugins");
    let plugin = plugins.join("example");
    write_inventory_manifest(&plugin, PLUGIN_MANIFEST_PATHS[0], json!({}));
    write_inventory_file(&plugin, "SKILL.md", "---\nname: actual-name\ndescription: Public description\nmetadata:\n  name: internal-id\n  description: Internal description\n---\n");

    let entries = scan_plugin_dir(&plugins, "codex-plugin");

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "actual-name");
    assert_eq!(entries[0].description, "Public description");
}

#[test]
fn plugin_inventory_frontmatter_mapping_indent_matches_shared_cases() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../shared/protocol/plugin_skill_frontmatter_cases.json"
    )))
    .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let plugins = temp.path().join("plugins");
    let plugin = plugins.join("example");
    write_inventory_manifest(
        &plugin,
        PLUGIN_MANIFEST_PATHS[0],
        json!({"name": "example"}),
    );
    for case in cases {
        for newline in ["\n", "\r\n"] {
            write_inventory_file(
                &plugin,
                "SKILL.md",
                &case["content"].as_str().unwrap().replace('\n', newline),
            );

            let entries = scan_plugin_dir(&plugins, "codex-plugin");

            assert_eq!(entries.len(), 1);
            assert_eq!(
                entries[0].name,
                case["skill_name"].as_str().unwrap(),
                "{} {newline:?}",
                case["name"]
            );
            assert_eq!(
                entries[0].description,
                case["description"].as_str().unwrap(),
                "{} {newline:?}",
                case["name"]
            );
        }
    }
}

#[test]
fn plugin_inventory_preserves_provider_version_and_priority() {
    let temp = tempfile::tempdir().unwrap();
    let plugins = temp.path().join("plugins");
    for (provider, version) in [
        ("openai-curated-remote", "old"),
        ("openai-curated-remote", "new"),
        ("openai-bundled", "1.0"),
        ("openai-primary-runtime", "2.0"),
        ("openai-curated", "3.0"),
        ("third-party", "4.0"),
    ] {
        let plugin = plugins
            .join("cache")
            .join(provider)
            .join("reviewer")
            .join(version);
        write_inventory_manifest(&plugin, PLUGIN_MANIFEST_PATHS[0], json!({}));
        write_inventory_file(
            &plugin,
            "SKILL.md",
            "---\nname: Shared\ndescription: 'It''s ready.'\n---\n",
        );
        let seconds = if version == "new" { 2000 } else { 1000 };
        fs::OpenOptions::new()
            .write(true)
            .open(plugin.join("SKILL.md"))
            .unwrap()
            .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(seconds))
            .unwrap();
    }

    let entries = scan_plugin_dir(&plugins, "codex-plugin");

    assert_eq!(entries.len(), 6);
    for entry in &entries {
        let provider = entry.plugin_provider.as_deref().unwrap();
        let expected = match provider {
            "openai-curated-remote" => 20,
            "openai-bundled" | "openai-primary-runtime" => 30,
            "openai-curated" => 40,
            "third-party" => 50,
            _ => panic!("Unexpected provider: {provider}"),
        };
        assert_eq!(entry.source_priority, expected);
        assert_eq!(entry.description, "It's ready.");
        assert_eq!(entry.plugin_name.as_deref(), Some("reviewer"));
        assert!(entry.mtime.is_some());
        assert_eq!(
            entry.to_json()["plugin_version"],
            entry.plugin_version.as_deref().unwrap()
        );
    }
    let entries = deduplicate_and_sort(entries);
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].plugin_provider.as_deref(),
        Some("openai-curated-remote")
    );
    assert_eq!(entries[0].plugin_version.as_deref(), Some("new"));
    assert_eq!(entries[0].mtime, Some(2000.0));
}

#[test]
fn standalone_skills_and_manifest_free_nested_defaults_remain_listed() {
    let temp = tempfile::tempdir().unwrap();
    let user = temp.path().join("skills");
    let plugins = temp.path().join("plugins");
    for relative in ["shared/SKILL.md", ".system/system/SKILL.md"] {
        write_inventory_file(&user, relative, "# Standalone");
    }
    let legacy = plugins.join("legacy-folder");
    write_inventory_file(&legacy, "skills/group/SKILL.md", "# Group");
    write_inventory_file(&legacy, "skills/group/child/SKILL.md", "# Child");
    write_inventory_file(&legacy, "skills/group/skills/leaf/SKILL.md", "# Leaf");
    write_inventory_file(&legacy, "vendor/addon/skills/addon/SKILL.md", "# Addon");
    write_inventory_file(&legacy, "skills/shared/SKILL.md", "# Duplicate");
    write_inventory_file(&legacy, "docs/SKILL.md", "# Excluded");
    write_inventory_file(&plugins, "unregistered/SKILL.md", "# Excluded");
    let mut entries = scan_skill_dir(&user, "codex", "user", CODEX_USER_PRIORITY);
    entries.extend(scan_skill_dir(
        &user.join(".system"),
        "codex",
        "system",
        CODEX_SYSTEM_PRIORITY,
    ));
    entries.extend(scan_plugin_dir(&plugins, "codex-plugin"));

    let entries = deduplicate_and_sort(entries);

    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["shared", "system", "addon", "child", "group", "leaf"]
    );
    assert_eq!(
        entries[0].path,
        user.join("shared/SKILL.md").to_string_lossy()
    );
    assert_eq!(entries[0].scope, "user");
    assert_eq!(entries[1].scope, "system");
    assert!(entries[0].plugin_name.is_none() && entries[1].plugin_name.is_none());
    assert_eq!(
        entries[3].path,
        legacy.join("skills/group/child/SKILL.md").to_string_lossy()
    );
    assert_eq!(entries[2].plugin_name.as_deref(), Some("legacy-folder"));
    assert!(entries[2].plugin_provider.is_none() && entries[2].plugin_version.is_none());
    assert_eq!(entries[2].source_priority, 50);
}

#[cfg(any(unix, windows))]
#[test]
fn plugin_inventory_keeps_linked_roots_and_cache_alias_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let plugins = temp.path().join("plugins");
    let external = temp.path().join("external");
    write_inventory_manifest(&external, PLUGIN_MANIFEST_PATHS[0], json!({}));
    write_inventory_file(&external, "SKILL.md", "# Root");
    write_inventory_file(&external, "docs/SKILL.md", "# Excluded");
    for provider in ["openai-curated-remote", "third-party"] {
        let alias = plugins
            .join("cache")
            .join(provider)
            .join("linked")
            .join("7.0");
        fs::create_dir_all(alias.parent().unwrap()).unwrap();
        crate::directory_link::create(&external, &alias).unwrap();
    }

    let entries = scan_plugin_dir(&plugins, "codex-plugin");

    assert_eq!(entries.len(), 2);
    for entry in &entries {
        assert!(entry.path.starts_with(plugins.to_str().unwrap()));
        assert_eq!(entry.plugin_name.as_deref(), Some("linked"));
        assert_eq!(entry.plugin_version.as_deref(), Some("7.0"));
    }
    assert_eq!(
        deduplicate_and_sort(entries)[0].plugin_provider.as_deref(),
        Some("openai-curated-remote")
    );
    let legacy = plugins.join("legacy-link");
    fs::remove_file(external.join(PLUGIN_MANIFEST_PATHS[0])).unwrap();
    write_inventory_file(&external, "skills/group/child/SKILL.md", "# Child");
    crate::directory_link::create(&external, &legacy).unwrap();
    assert!(scan_plugin_dir(&plugins, "codex-plugin")
        .iter()
        .any(|entry| {
            entry.path == legacy.join("skills/group/child/SKILL.md").to_string_lossy()
        }));
}

#[cfg(any(unix, windows))]
#[test]
fn plugin_inventory_rejects_directory_link_escapes_and_cycles() {
    for relative in [
        "skills",
        "skills/escape",
        "skills/loop",
        "custom",
        ".codex-plugin",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let plugins = temp.path().join("plugins");
        let unsafe_plugin = plugins.join("unsafe");
        let external = temp.path().join("external");
        write_inventory_manifest(&external, PLUGIN_MANIFEST_PATHS[0], json!({}));
        write_inventory_file(&external, "skills/external/SKILL.md", "# External");
        write_inventory_manifest(
            &unsafe_plugin,
            PLUGIN_MANIFEST_PATHS[0],
            json!({"skills":"custom"}),
        );
        write_inventory_file(&unsafe_plugin, "skills/valid/SKILL.md", "# Valid");
        write_inventory_file(
            &plugins.join("healthy"),
            "skills/healthy/SKILL.md",
            "# Healthy",
        );
        let link = unsafe_plugin.join(relative);
        if link.exists() {
            fs::remove_dir_all(&link).unwrap();
        }
        let destination = if relative == "skills/loop" {
            unsafe_plugin.join("skills")
        } else if relative == ".codex-plugin" {
            external.join(".codex-plugin")
        } else {
            external
        };
        crate::directory_link::create(&destination, &link).unwrap();
        crate::directory_link::create(&plugins, &plugins.join("collection-cycle")).unwrap();

        let entries = scan_plugin_dir(&plugins, "codex-plugin");

        assert_eq!(entries.len(), 1, "{relative}");
        assert_eq!(entries[0].name, "healthy", "{relative}");
    }
}

#[test]
fn parse_frontmatter_decodes_quoted_scalars_with_legacy_fallback() {
    for (value, expected) in [
        (
            r#""Use \"USB attach\" at C:\\tools.""#,
            r#"Use "USB attach" at C:\tools."#,
        ),
        (
            "'Use ''USB attach''; it''s ready.'",
            "Use 'USB attach'; it's ready.",
        ),
        (r#""Legacy \q USB trigger""#, r#"Legacy \q USB trigger"#),
    ] {
        let content = format!("---\ndescription: {value}\n---\n");

        let metadata = parse_frontmatter_content(&content);

        assert_eq!(
            metadata.get("description").map(String::as_str),
            Some(expected),
            "value={value}",
        );
    }
}

#[test]
fn parse_frontmatter_handles_literal_block_scalar() {
    let dir = temp_dir("frontmatter-literal");
    let path = dir.join("SKILL.md");
    for newline in ["\n", "\r\n"] {
        let content = "---\ndescription: |\n  line one\n  line two\nname: after\n---\n"
            .replace('\n', newline);
        fs::write(&path, content).unwrap();
        let metadata = parse_frontmatter(&path);
        assert_eq!(
            metadata.get("description").map(String::as_str),
            Some("line one\nline two"),
            "newline={newline:?}"
        );
        assert_eq!(metadata.get("name").map(String::as_str), Some("after"));
    }
    fs::remove_dir_all(dir).ok();
}

#[test]
fn parse_frontmatter_folds_folded_block_scalar() {
    let dir = temp_dir("frontmatter-folded");
    let path = dir.join("SKILL.md");
    fs::write(
        &path,
        "---\ndescription: >\n  first paragraph\n  still first\n\n  second paragraph\n---\n",
    )
    .unwrap();

    let metadata = parse_frontmatter(&path);
    assert_eq!(
        metadata.get("description").map(String::as_str),
        Some("first paragraph still first\nsecond paragraph")
    );
    fs::remove_dir_all(dir).ok();
}

fn temp_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!(
        "wegent-local-skills-{}-{}-{}",
        std::process::id(),
        label,
        nanos
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

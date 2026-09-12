use super::*;

fn tempdir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("skill-install-")
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}

fn fixture(root: &Path, name: &str) {
    fs::create_dir_all(root.join(name).join("scripts")).unwrap();
    fs::write(
        root.join(name).join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Example workflow\n---\nRead scripts/example.sh"),
    )
    .unwrap();
    fs::write(root.join(name).join("scripts/example.sh"), "echo example").unwrap();
}
fn request(value: Value) -> Request {
    serde_json::from_value(value).unwrap()
}

#[test]
fn removes_expired_import_stages_before_creating_a_new_preview() {
    let home = tempdir();
    let imports = home.path().join("skill-imports");
    let expired = imports.join(Uuid::new_v4().to_string());
    let recent = imports.join(Uuid::new_v4().to_string());
    let unrelated = imports.join("keep-me");
    for stage in [&expired, &recent, &unrelated] {
        fs::create_dir_all(stage.join("content")).unwrap();
    }
    fs::write(expired.join(STAGE_CREATED_AT_FILE), "0").unwrap();
    fs::write(
        recent.join(STAGE_CREATED_AT_FILE),
        unix_timestamp(SystemTime::now()).to_string(),
    )
    .unwrap();

    let (_, created) = new_stage(home.path()).unwrap();

    assert!(!expired.exists());
    assert!(recent.exists());
    assert!(unrelated.exists());
    assert!(created.exists());
}

#[test]
fn previews_installs_and_removes_a_complete_skill_without_plugins() {
    let home = tempdir();
    let source = tempdir();
    fixture(source.path(), "example");
    let preview = dispatch(
        request(json!({"action":"preview","source":source.path(),"sourceKind":"local"})),
        home.path(),
    )
    .unwrap();
    assert_eq!(preview["skills"][0]["name"], "example");
    dispatch(
        request(json!({"action":"install","token":preview["token"],"paths":["example"]})),
        home.path(),
    )
    .unwrap();
    let installed = home.path().join("skills/example");
    assert!(installed.join("scripts/example.sh").is_file());
    assert!(!installed.join(".codex-plugin").exists());
    dispatch(
        request(json!({"action":"remove","path":installed.join("SKILL.md")})),
        home.path(),
    )
    .unwrap();
    assert!(!installed.exists());
}
#[test]
fn conflicting_batch_does_not_overwrite_or_partially_install() {
    let home = tempdir();
    let source = tempdir();
    fixture(source.path(), "one");
    fixture(source.path(), "two");
    fixture(&home.path().join("skills"), "two");
    let preview = preview_local(
        &request(json!({"action":"preview","source":source.path()})),
        home.path(),
    )
    .unwrap();
    let result = install(
        &request(json!({"action":"install","token":preview["token"],"paths":["one","two"]})),
        home.path(),
    );
    assert!(result.unwrap_err().contains("already exists"));
    assert!(!home.path().join("skills/one").exists());
    assert!(home.path().join("skills/two/SKILL.md").exists());
}
#[test]
fn rejects_forged_tokens_paths_and_protected_removal() {
    let home = tempdir();
    assert!(stage_path(home.path(), "../../outside").is_err());
    assert!(remove(&request(json!({"action":"remove","path":home.path().join("plugins/test/skills/example/SKILL.md")})), home.path()).is_err());
    assert!(validate_git_source("https://token@github.com/company/skills").is_err());
    assert!(validate_git_source("--upload-pack=evil").is_err());
    assert!(validate_git_source("git@git.example.test:company/skills.git").is_ok());
}
#[test]
fn installs_selected_project_scope_only() {
    let home = tempdir();
    let source = tempdir();
    let project = tempdir();
    fixture(source.path(), "example");
    let preview = preview_local(
        &request(json!({"action":"preview","source":source.path()})),
        home.path(),
    )
    .unwrap();
    install(&request(json!({"action":"install","token":preview["token"],"paths":["example"],"projectPath":project.path()})),home.path()).unwrap();
    assert!(project
        .path()
        .join(".agents/skills/example/SKILL.md")
        .is_file());
    assert!(!home.path().join("skills/example").exists());
}
#[test]
fn imports_zip_with_scripts_and_discards_preview() {
    use std::io::Write;
    let home = tempdir();
    let source = tempdir();
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("example/SKILL.md", zip::write::FileOptions::default())
        .unwrap();
    writer
        .write_all(b"---\nname: example\ndescription: Example\n---\nRun scripts/check.sh")
        .unwrap();
    writer
        .start_file(
            "example/scripts/check.sh",
            zip::write::FileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
    writer.write_all(b"#!/bin/sh\necho example").unwrap();
    let archive = source.path().join("skills.zip");
    fs::write(&archive, writer.finish().unwrap().into_inner()).unwrap();
    let preview = dispatch(
        request(json!({"action":"preview","source":archive,"sourceKind":"local"})),
        home.path(),
    )
    .unwrap();
    install(
        &request(json!({"token":preview["token"],"action":"install","paths":["example"]})),
        home.path(),
    )
    .unwrap();
    let script = home.path().join("skills/example/scripts/check.sh");
    assert!(script.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(script).unwrap().permissions().mode() & 0o111,
            0o111
        );
    }
    let preview = dispatch(
        request(json!({"action":"preview","source":archive,"sourceKind":"local"})),
        home.path(),
    )
    .unwrap();
    let stage = stage_path(home.path(), preview["token"].as_str().unwrap()).unwrap();
    dispatch(
        request(json!({"action":"discard","token":preview["token"]})),
        home.path(),
    )
    .unwrap();
    assert!(!stage.exists());
}
#[test]
fn rejects_overly_nested_preview_directories() {
    let source = tempdir();
    let nested = (0..21).fold(source.path().to_path_buf(), |path, _| path.join("a"));
    fs::create_dir_all(nested).unwrap();
    assert!(discover(source.path(), source.path(), &mut Vec::new())
        .unwrap_err()
        .contains("nesting"));
}
#[test]
fn rejects_zip_path_traversal() {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("../outside/SKILL.md", zip::write::FileOptions::default())
        .unwrap();
    writer.write_all(b"bad").unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let dir = tempdir();
    assert!(extract_capability_archive(&bytes, dir.path()).is_err());
}
#[cfg(unix)]
#[test]
fn rejects_symlink_sources_and_destinations() {
    use std::os::unix::fs::symlink;
    let home = tempdir();
    let source = tempdir();
    let external = tempdir();
    fixture(source.path(), "example");
    symlink(external.path(), source.path().join("example/escape")).unwrap();
    assert!(preview_local(
        &request(json!({"action":"preview","source":source.path()})),
        home.path()
    )
    .is_err());
    symlink(external.path(), home.path().join("skills")).unwrap();
    assert!(destination_root(home.path(), &None).is_err());
}

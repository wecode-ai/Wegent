// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn request(task: &str) -> ExecutionRequest {
    serde_json::from_value(
        json!({"task_id": task, "subtask_id": format!("{task}-turn"),
        "team_id": 12, "team_name": "shared-agent", "team_namespace": "default",
        "user": {"id": 7}, "user_name": "user1", "new_session": true,
        "bot": [{"id": 23, "shell_type": "ClaudeCode"}]}),
    )
    .unwrap()
}

fn prepare_skills(execution: &ExecutionHome, name: Option<&str>) {
    let skills = execution.snapshot.join("skills");
    fs::create_dir_all(&skills).unwrap();
    let records = name
        .map(|name| json!({name: {"skill_id": 1, "namespace": "default"}}))
        .unwrap_or_else(|| json!({}));
    if let Some(name) = name {
        fs::create_dir_all(skills.join(name)).unwrap();
        fs::write(skills.join(name).join("SKILL.md"), name).unwrap();
    }
    fs::write(skills.join(".wegent-skills.json"), records.to_string()).unwrap();
    let mut entries = vec![".wegent-skills.json"];
    entries.extend(name);
    fs::write(
        execution.snapshot.join("capabilities.json"),
        json!({"schema_version": 2, "current": "skills", "skills": records, "entries": entries} )
            .to_string(),
    )
    .unwrap();
}

#[test]
fn concurrent_executions_share_history_and_isolate_configuration() {
    let root = tempfile::tempdir().unwrap();
    let first = request("task-1");
    let home = named_home_at(root.path(), &first).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("settings.json"), r#"{"custom":true}"#).unwrap();
    let mut one = create_at(&first, root.path(), &home).unwrap();
    let mut two = create_at(&request("task-2"), root.path(), &home).unwrap();
    assert_ne!(one.snapshot, two.snapshot);
    for execution in [&one, &two] {
        fs::create_dir_all(execution.snapshot.join("skills")).unwrap();
        assert_eq!(
            fs::canonicalize(execution.snapshot.join("projects")).unwrap(),
            fs::canonicalize(home.join("projects")).unwrap()
        );
        assert_eq!(
            fs::read(execution.snapshot.join("settings.json")).unwrap(),
            fs::read(home.join("settings.json")).unwrap()
        );
    }
    prepare_skills(&one, Some("one"));
    prepare_skills(&two, Some("two"));
    fs::write(one.snapshot.join("settings.json"), r#"{"one":true}"#).unwrap();
    fs::write(two.snapshot.join("settings.json"), r#"{"two":true}"#).unwrap();
    one.activate().unwrap();
    two.activate().unwrap();
    assert_eq!(
        task_skills_directory_at(root.path(), "task-1", "7")
            .unwrap()
            .path,
        one.snapshot.join("skills")
    );
    assert_eq!(
        task_skills_directory_at(root.path(), "task-2", "7")
            .unwrap()
            .path,
        two.snapshot.join("skills")
    );
    assert!(task_skills_directory_at(root.path(), "task-1", "8").is_err());
    assert_eq!(
        fs::read_to_string(home.join("settings.json")).unwrap(),
        r#"{
  "two": true
}"#
    );
    assert!(!home.join("runtime/active-task.json").exists());
    let archive = open_home_lock(&home, root.path()).unwrap();
    assert!(archive.try_lock_exclusive().is_err());
    drop(one);
    assert!(archive.try_lock_exclusive().is_err());
    drop(two);
    archive.try_lock_exclusive().unwrap();
    FileExt::unlock(&archive).unwrap();
    let skills = task_skills_directory_at(root.path(), "task-1", "7")
        .unwrap()
        .path;
    assert_eq!(
        fs::read_to_string(skills.join("one/SKILL.md")).unwrap(),
        "one"
    );
}

#[test]
fn failed_preparation_removes_only_its_private_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let request = request("task-1");
    let home = named_home_at(root.path(), &request).unwrap();
    let first = create_at(&request, root.path(), &home).unwrap();
    let snapshot = first.snapshot.clone();
    fs::write(home.join("projects/session.jsonl"), "durable").unwrap();
    drop(first);
    assert!(!snapshot.exists());
    assert_eq!(
        fs::read_to_string(home.join("projects/session.jsonl")).unwrap(),
        "durable"
    );
    let archive = open_home_lock(&home, root.path()).unwrap();
    archive.try_lock_exclusive().unwrap();
}

#[test]
fn failed_task_never_resolves_another_tasks_shared_skill_selection() {
    let root = tempfile::tempdir().unwrap();
    let home = named_home_at(root.path(), &request("task-1")).unwrap();
    let mut first = create_at(&request("task-1"), root.path(), &home).unwrap();
    prepare_skills(&first, Some("one"));
    first.activate().unwrap();
    let second = create_at(&request("task-2"), root.path(), &home).unwrap();
    drop(second);
    assert!(home.join("skills/one/SKILL.md").is_file());
    assert!(task_skills_directory_at(root.path(), "task-2", "7")
        .unwrap_err()
        .contains("no activated"));
    assert_eq!(
        task_skills_directory_at(root.path(), "task-1", "7")
            .unwrap()
            .path,
        first.snapshot.join("skills")
    );
}

#[test]
fn next_turn_preserves_mcp_templates_and_prunes_completed_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let task = request("task-1");
    let home = named_home_at(root.path(), &task).unwrap();
    let mut first = create_at(&task, root.path(), &home).unwrap();
    prepare_skills(&first, None);
    fs::write(
        first.snapshot.join("mcp.json"),
        r#"{"mcpServers":{"one":{}}}"#,
    )
    .unwrap();
    first.activate().unwrap();
    let previous = first.snapshot.clone();
    drop(first);
    let unrelated = create_at(&request("task-2"), root.path(), &home).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(unrelated.snapshot.join("mcp.json")).unwrap())
            .unwrap(),
        serde_json::from_slice::<Value>(&fs::read(previous.join("mcp.json")).unwrap()).unwrap()
    );
    let mut next = create_at(&task, root.path(), &home).unwrap();
    assert_eq!(
        fs::read(next.snapshot.join("mcp.json")).unwrap(),
        fs::read(previous.join("mcp.json")).unwrap()
    );
    prepare_skills(&next, None);
    next.activate().unwrap();
    assert!(!previous.exists());
    assert!(unrelated.snapshot.exists());
}

#[test]
fn different_tasks_cannot_write_the_same_native_conversation_concurrently() {
    let root = tempfile::tempdir().unwrap();
    let home = named_home_at(root.path(), &request("task-1")).unwrap();
    let mut first = create_at(&request("task-1"), root.path(), &home).unwrap();
    let mut second = create_at(&request("task-2"), root.path(), &home).unwrap();
    let resume = || {
        CommandSpec::new("claude")
            .arg("--resume")
            .arg("shared-session")
    };
    first.configure(resume()).unwrap();
    assert!(second
        .configure(resume())
        .unwrap_err()
        .contains("Conversation already"));
    drop(first);
    assert!(second.configure(resume()).is_ok());
}

#[test]
fn same_task_remains_exclusive_while_other_tasks_share_the_agent() {
    let root = tempfile::tempdir().unwrap();
    let task = request("task-1");
    let home = named_home_at(root.path(), &task).unwrap();
    let _first = create_at(&task, root.path(), &home).unwrap();
    assert!(create_at(&task, root.path(), &home)
        .err()
        .unwrap()
        .contains("Task already"));
    assert!(create_at(&request("task-2"), root.path(), &home).is_ok());
}

#[test]
fn completed_skill_snapshot_is_not_pruned_while_an_extension_reads_it() {
    let root = tempfile::tempdir().unwrap();
    let task = request("task-1");
    let home = named_home_at(root.path(), &task).unwrap();
    let mut first = create_at(&task, root.path(), &home).unwrap();
    prepare_skills(&first, Some("one"));
    first.activate().unwrap();
    let path = first.snapshot.clone();
    drop(first);
    let reader = pin_skills(&path.join("skills")).unwrap();
    let mut next = create_at(&task, root.path(), &home).unwrap();
    prepare_skills(&next, Some("two"));
    next.activate().unwrap();
    assert!(path.join("skills/one/SKILL.md").is_file());
    drop(reader);
    drop(next);
    assert!(!path.exists());
    assert!(home.join("projects").is_dir());
}

#[test]
fn resolving_task_skills_pins_the_snapshot_before_the_next_turn_can_prune_it() {
    let root = tempfile::tempdir().unwrap();
    let task = request("task-1");
    let home = named_home_at(root.path(), &task).unwrap();
    let mut first = create_at(&task, root.path(), &home).unwrap();
    prepare_skills(&first, Some("one"));
    first.activate().unwrap();
    let previous = first.snapshot.clone();
    drop(first);

    let selection = task_skills_directory_at(root.path(), "task-1", "7").unwrap();
    let mut next = create_at(&task, root.path(), &home).unwrap();
    prepare_skills(&next, Some("two"));
    next.activate().unwrap();

    assert!(
        previous.join("skills/one/SKILL.md").is_file(),
        "The resolved snapshot must remain readable before the consumer starts"
    );
    drop(selection);
    drop(next);
    assert!(!previous.exists());
}

#[test]
fn pruning_failure_does_not_reject_an_already_activated_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let task = request("task-1");
    let home = named_home_at(root.path(), &task).unwrap();
    let mut first = create_at(&task, root.path(), &home).unwrap();
    prepare_skills(&first, Some("one"));
    first.activate().unwrap();
    let previous = first.snapshot.clone();
    drop(first);
    fs::remove_file(previous.join(".read.lock")).unwrap();

    let mut next = create_at(&task, root.path(), &home).unwrap();
    prepare_skills(&next, Some("two"));
    next.activate().unwrap();

    assert_eq!(
        task_skills_directory_at(root.path(), "task-1", "7")
            .unwrap()
            .path,
        next.snapshot.join("skills")
    );
    assert!(previous.join("skills/one/SKILL.md").is_file());
    assert_eq!(
        read_marker(&next.snapshot.join("execution.json")).unwrap()["ready"],
        true
    );
}

#[test]
fn pipeline_lookup_keeps_legacy_and_snapshot_execution_ownership_checks() {
    let root = tempfile::tempdir().unwrap();
    let mut task = request("task-1");
    task.extra
        .insert("collaboration_model".to_owned(), json!("pipeline"));
    let legacy_home = named_home_at(root.path(), &task).unwrap();
    let legacy = acquire_at(&task, root.path(), &legacy_home).unwrap();
    fs::create_dir_all(legacy_home.join("skills")).unwrap();
    task.bot[0]["id"] = json!(24);
    let home = named_home_at(root.path(), &task).unwrap();
    let mut execution = create_at(&task, root.path(), &home).unwrap();
    prepare_skills(&execution, None);
    execution.activate().unwrap();
    assert!(task_skills_directory_at(root.path(), "task-1", "7")
        .unwrap_err()
        .contains("multiple"));
    drop(legacy);
    assert_eq!(
        task_skills_directory_at(root.path(), "task-1", "7")
            .unwrap()
            .path,
        execution.snapshot.join("skills")
    );
    assert!(task_skills_directory_at(root.path(), "task-1", "8").is_err());
}

#[cfg(unix)]
#[test]
fn execution_snapshot_rejects_symlinked_configuration_and_runtime_directories() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let task = request("task-1");
    let home = named_home_at(root.path(), &task).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(outside.path().join("settings.json"), "{}").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("settings.json"),
        home.join("settings.json"),
    )
    .unwrap();
    assert!(create_at(&task, root.path(), &home)
        .err()
        .unwrap()
        .contains("regular file"));
    fs::remove_file(home.join("settings.json")).unwrap();
    fs::remove_dir_all(home.join("runtime/executions")).unwrap();
    std::os::unix::fs::symlink(outside.path(), home.join("runtime/executions")).unwrap();
    assert!(create_at(&task, root.path(), &home)
        .err()
        .unwrap()
        .contains("symlink"));
    assert_eq!(
        fs::read_to_string(outside.path().join("settings.json")).unwrap(),
        "{}"
    );
}

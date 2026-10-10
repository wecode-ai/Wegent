// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn request() -> ExecutionRequest {
    serde_json::from_value(
        json!({"task_id":"task-1", "team_id":12, "backend_url":"https://backend.example",
        "team_name":"wegent-design", "team_namespace":"wecode-ai", "user":{"id":1}, "user_name":"user1", "new_session":true,
        "team_owner":{"kind":"group","id":5,"name":"wecode-ai"},
        "bot":[{"id":23,"name":"reviewer","shell_type":"Codex"}]}),
    )
    .unwrap()
}

#[test]
fn pipeline_stages_have_independent_homes_and_route_skills_to_the_active_task() {
    let root = tempfile::tempdir().unwrap();
    let mut first = request();
    first
        .extra
        .insert("collaboration_model".to_owned(), json!("pipeline"));
    let first_home = named_home_at(root.path(), &first).unwrap();
    assert_eq!(
        first_home,
        root.path()
            .join("agents/user1/wecode-ai/wegent-design/bots/23")
    );
    let first_lease = acquire_at(&first, root.path(), &first_home).unwrap();
    fs::create_dir_all(first_home.join("skills")).unwrap();
    fs::write(first_home.join("session"), "first-stage-session").unwrap();
    let mut second = first.clone();
    second.bot[0]["id"] = json!(24);
    second.bot[0]["shell_type"] = json!("ClaudeCode");
    let second_home = named_home_at(root.path(), &second).unwrap();
    assert_ne!(first_home, second_home);
    let second_lease = acquire_at(&second, root.path(), &second_home).unwrap();
    fs::create_dir_all(second_home.join("skills")).unwrap();
    let lookup = || task_skills_directory_at(root.path(), "task-1", "https://backend.example", "1");
    assert!(lookup().unwrap_err().contains("multiple"));
    drop(first_lease);
    assert_eq!(lookup().unwrap(), second_home.join("skills"));
    assert!(acquire_at(&second, root.path(), &second_home)
        .unwrap_err()
        .contains("active"));
    assert!(task_skills_directory_at(root.path(), "task-1", "https://other.example", "1").is_err());
    drop(second_lease);
    assert!(lookup().unwrap_err().contains("multiple"));
    // An execution for another task must not select a historical pipeline stage.
    second.task_id = "task-2".to_owned();
    let unrelated_lease = acquire_at(&second, root.path(), &second_home).unwrap();
    assert!(lookup().unwrap_err().contains("multiple"));
    drop(unrelated_lease);
    first.new_session = false;
    let resumed = acquire_at(&first, root.path(), &first_home).unwrap();
    assert_eq!(lookup().unwrap(), first_home.join("skills"));
    assert_eq!(
        fs::read_to_string(first_home.join("session")).unwrap(),
        "first-stage-session"
    );
    drop(resumed);
    first.bot[0]["id"] = Value::Null;
    assert!(named_home_at(root.path(), &first)
        .unwrap_err()
        .contains("Bot identity"));
}

#[test]
fn backend_requests_use_executing_user_independently_of_resource_owner() {
    for shell in ["Codex", "ClaudeCode"] {
        for owner in [
            None,
            Some(Value::Null),
            Some(json!({})),
            Some(json!("ignored")),
            Some(json!({"kind":"user","id":2,"name":"other-user"})),
            Some(json!({"kind":"group","id":5,"name":"shared-group"})),
        ] {
            let root = tempfile::tempdir().unwrap();
            let mut request = request();
            request.bot[0]["shell_type"] = json!(shell);
            request.extra.remove("team_owner");
            if let Some(owner) = &owner {
                request.extra.insert("team_owner".to_owned(), owner.clone());
            }
            let home = root.path().join("agents/user1/wecode-ai/wegent-design");
            assert_eq!(named_home_at(root.path(), &request).unwrap(), home);
            drop(acquire_at(&request, root.path(), &home).unwrap());
            request.new_session = false;
            drop(acquire_at(&request, root.path(), &home).unwrap());
        }
    }
}

#[test]
fn executing_user_name_is_required_for_bot_home() {
    for user in [None, Some(""), Some("../escape")] {
        let mut request = request();
        request.user_name = user.map(str::to_owned);
        assert!(request_home(&request).is_some());
        assert!(acquire(&request).is_err());
    }
}

#[test]
fn shared_agent_owner_can_differ_from_executing_user() {
    let root = tempfile::tempdir().unwrap();
    let mut request = request();
    request.team_namespace = Some("default".to_owned());
    request.extra["team_owner"] = json!({"kind":"user","id":2,"name":"agent-author"});
    let home = named_home_at(root.path(), &request).unwrap();
    assert_eq!(home, root.path().join("agents/user1/default/wegent-design"));
    drop(acquire_at(&request, root.path(), &home).unwrap());
    assert_eq!(
        read_marker(&home.join("agent.json")).unwrap()["user_id"],
        "1"
    );
}

#[test]
fn compact_records_keep_identity_once_and_do_not_rewrite_on_followup() {
    let root = tempfile::tempdir().unwrap();
    let request = request();
    let home = named_home_at(root.path(), &request).unwrap();
    drop(acquire_at(&request, root.path(), &home).unwrap());
    let agent_path = home.join("agent.json");
    let task_path = task_binding(&home, &request.task_id).unwrap();
    assert_eq!(
        read_marker(&agent_path).unwrap(),
        json!({"schema_version":5, "backend_url":"https://backend.example",
            "user_id":"1", "user_name":"user1", "team_id":"12", "bot_id":"23", "shell_type":"codex"})
    );
    assert_eq!(
        read_marker(&task_path).unwrap(),
        json!({"task_id":"task-1", "migrated_session":null})
    );
    let before = [
        fs::metadata(&agent_path).unwrap(),
        fs::metadata(&task_path).unwrap(),
    ];
    drop(acquire_at(&request, root.path(), &home).unwrap());
    for (path, before) in [agent_path, task_path].iter().zip(before) {
        let after = fs::metadata(path).unwrap();
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(before.ino(), after.ino());
            assert_eq!(after.mode() & 0o777, 0o600);
        }
    }
}

#[test]
fn expanded_records_upgrade_without_reimporting_or_losing_other_tasks() {
    let root = tempfile::tempdir().unwrap();
    let mut request = request();
    request.new_session = false;
    let home = named_home_at(root.path(), &request).unwrap();
    fs::create_dir_all(home.join("runtime/tasks")).unwrap();
    fs::create_dir_all(home.join("skills")).unwrap();
    fs::create_dir_all(home.join("sessions")).unwrap();
    let session_path = home.join("sessions/remembered.jsonl");
    fs::write(&session_path, "synthetic-session-preserved\n").unwrap();
    let session = json!({"id":"remembered", "path":"sessions/remembered.jsonl"});
    let mut agent = request_identity(&request).unwrap();
    agent["schema_version"] = json!(4);
    fs::write(home.join("agent.json"), agent.to_string()).unwrap();
    let mut expanded = request_identity(&request).unwrap();
    expanded["migrated_session"] = session.clone();
    expanded["skills_path"] = json!("skills");
    for id in ["task-1", "task-2"] {
        expanded["task_id"] = json!(id);
        fs::write(task_binding(&home, id).unwrap(), expanded.to_string()).unwrap();
    }
    let lookup = |id| task_skills_directory_at(root.path(), id, "https://backend.example", "1");
    assert_eq!(lookup("task-1").unwrap(), home.join("skills"));
    let untouched = fs::read(task_binding(&home, "task-2").unwrap()).unwrap();
    drop(acquire_at(&request, root.path(), &home).unwrap());
    assert_eq!(
        read_marker(&home.join("agent.json")).unwrap()["schema_version"],
        5
    );
    assert_eq!(
        read_marker(&task_binding(&home, "task-1").unwrap()).unwrap(),
        json!({"task_id":"task-1", "migrated_session":session})
    );
    assert_eq!(
        fs::read(task_binding(&home, "task-2").unwrap()).unwrap(),
        untouched
    );
    // This also represents interruption after upgrading agent.json but before its task.
    assert_eq!(lookup("task-2").unwrap(), home.join("skills"));
    request.task_id = "task-2".to_owned();
    drop(acquire_at(&request, root.path(), &home).unwrap());
    drop(acquire_at(&request, root.path(), &home).unwrap());
    assert_eq!(
        read_marker(&task_binding(&home, "task-2").unwrap()).unwrap(),
        json!({"task_id":"task-2", "migrated_session":session})
    );
    assert_eq!(
        fs::read_to_string(session_path).unwrap(),
        "synthetic-session-preserved\n"
    );
}

#[test]
fn invalid_expanded_binding_is_not_pruned_or_reimported() {
    let root = tempfile::tempdir().unwrap();
    let request = request();
    let home = named_home_at(root.path(), &request).unwrap();
    fs::create_dir_all(home.join("runtime/tasks")).unwrap();
    let mut agent = request_identity(&request).unwrap();
    agent["schema_version"] = json!(4);
    let agent_path = home.join("agent.json");
    fs::write(&agent_path, agent.to_string()).unwrap();
    let mut task = request_identity(&request).unwrap();
    task["task_id"] = json!(request.task_id);
    task["migrated_session"] = Value::Null;
    let task_path = task_binding(&home, &request.task_id).unwrap();
    for field in [
        "backend_url",
        "user_id",
        "team_id",
        "bot_id",
        "shell_type",
        "team_namespace",
        "user_name",
    ] {
        let mut wrong = task.clone();
        wrong.as_object_mut().unwrap().remove(field);
        fs::write(&task_path, wrong.to_string()).unwrap();
        assert!(acquire_at(&request, root.path(), &home).is_err());
        assert_eq!(read_marker(&agent_path).unwrap(), agent);
        assert_eq!(read_marker(&task_path).unwrap(), wrong);
    }
    fs::write(
        &task_path,
        json!({"task_id":"task-1", "migrated_session":null}).to_string(),
    )
    .unwrap();
    assert!(acquire_at(&request, root.path(), &home).is_err());
    assert_eq!(read_marker(&agent_path).unwrap(), agent);
    fs::write(&task_path, task.to_string()).unwrap();
    drop(acquire_at(&request, root.path(), &home).unwrap());
}

#[cfg(unix)]
#[test]
fn compact_binding_does_not_allow_a_symlinked_skills_directory() {
    let root = tempfile::tempdir().unwrap();
    let request = request();
    let home = named_home_at(root.path(), &request).unwrap();
    drop(acquire_at(&request, root.path(), &home).unwrap());
    assert!(
        task_skills_directory_at(root.path(), "task-1", "https://backend.example", "1").is_err()
    );
    let external = root.path().join("unmanaged");
    fs::create_dir_all(&external).unwrap();
    fs::write(external.join("keep"), "untouched").unwrap();
    std::os::unix::fs::symlink(&external, home.join("skills")).unwrap();
    assert!(
        task_skills_directory_at(root.path(), "task-1", "https://backend.example", "1")
            .unwrap_err()
            .contains("symlink")
    );
    assert_eq!(
        fs::read_to_string(external.join("keep")).unwrap(),
        "untouched"
    );
}

#[test]
fn agent_home_uses_executing_user_namespace_and_name_not_ids() {
    let root = tempfile::tempdir().unwrap();
    let original = request();
    let home = named_home_at(root.path(), &original).unwrap();
    assert_eq!(
        home,
        root.path().join("agents/user1/wecode-ai/wegent-design")
    );
    let mut changed = original.clone();
    changed.subtask_id = "next-turn".to_owned();
    changed.task_id = "task-2".to_owned();
    assert_eq!(named_home_at(root.path(), &changed).unwrap(), home);
    changed.bot[0]["shell_type"] = json!("ClaudeCode");
    assert_eq!(named_home_at(root.path(), &changed).unwrap(), home);
    changed.team_namespace = Some("default".to_owned());
    changed.extra.insert(
        "team_owner".to_owned(),
        json!({"kind":"user","id":1,"name":"user1"}),
    );
    assert_eq!(
        named_home_at(root.path(), &changed).unwrap(),
        root.path().join("agents/user1/default/wegent-design")
    );
}

#[test]
fn internal_spaces_are_preserved_without_aliasing_other_names() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().join("workbench with spaces");
    let mut request = request();
    let names = ["design team", "design  team", "design-team", "design_team"];
    let mut homes = std::collections::HashSet::new();
    for owner in names {
        request.user_name = Some(owner.to_owned());
        for namespace in names {
            request.team_namespace = Some(namespace.to_owned());
            for name in names {
                request.extra["team_name"] = json!(name);
                let home = named_home_at(&root, &request).unwrap();
                assert_eq!(
                    home,
                    root.join("agents").join(owner).join(namespace).join(name)
                );
                assert!(homes.insert(home));
            }
        }
    }
    request.user_name = Some("design team".to_owned());
    request.team_namespace = Some("design  space".to_owned());
    request.extra["team_name"] = json!("agent name");
    let home = named_home_at(&root, &request).unwrap();
    drop(acquire_at(&request, &root, &home).unwrap());
    let skills = home.join("skills");
    fs::create_dir_all(&skills).unwrap();
    assert_eq!(
        task_skills_directory_at(&root, "task-1", "https://backend.example", "1").unwrap(),
        skills
    );
    drop(acquire_at(&request, &root, &home).unwrap());
}

#[test]
fn releasing_home_lease_unlocks_inherited_file_description() {
    let root = tempfile::tempdir().unwrap();
    let request = request();
    let home = named_home_at(root.path(), &request).unwrap();
    let lease = acquire_at(&request, root.path(), &home).unwrap();
    // A fork before exec can retain the same open file description, even with CLOEXEC.
    let inherited = lease.0.try_clone().unwrap();
    drop(lease);
    let next = acquire_at(&request, root.path(), &home)
        .expect("ending the execution must release its lease despite an inherited descriptor");
    drop(next);
    drop(inherited);
}

#[test]
fn shared_agent_home_keeps_task_bindings_and_rejects_identity_conflicts() {
    let root = tempfile::tempdir().unwrap();
    let original = request();
    let home = named_home_at(root.path(), &original).unwrap();
    let lease = acquire_at(&original, root.path(), &home).unwrap();
    assert!(acquire_at(&original, root.path(), &home)
        .unwrap_err()
        .contains("active execution"));
    drop(lease);
    let mut next = original.clone();
    next.task_id = "task-2".to_owned();
    drop(acquire_at(&next, root.path(), &home).unwrap());
    drop(acquire_at(&original, root.path(), &home).unwrap());
    assert!(task_binding(&home, "task-1").unwrap().is_file());
    assert!(task_binding(&home, "task-2").unwrap().is_file());
    let first = home.join("skills");
    let second = home.join("skills");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    for (task, expected) in [("task-1", first), ("task-2", second)] {
        assert_eq!(
            task_skills_directory_at(root.path(), task, "https://backend.example", "1").unwrap(),
            expected
        );
    }
    assert!(read_marker(&home.join("agent.json"))
        .unwrap()
        .get("task_id")
        .is_none());
    for (key, value) in [
        ("user", json!({"id":2})),
        ("team_id", json!(13)),
        ("team_namespace", json!("other")),
        ("user_name", json!("other-user")),
        ("backend_url", json!("https://other.example")),
        ("bot", json!([{"id":24,"shell_type":"Codex"}])),
        ("bot", json!([{"id":23,"shell_type":"ClaudeCode"}])),
    ] {
        let mut raw = serde_json::to_value(&original).unwrap();
        raw[key] = value;
        let changed = serde_json::from_value(raw).unwrap();
        let error = acquire_at(&changed, root.path(), &home).unwrap_err();
        assert!(error.contains("identity"), "changed {key}: {error}");
    }
}

#[test]
fn invalid_or_missing_names_do_not_select_another_home() {
    let root = tempfile::tempdir().unwrap();
    for name in ["", ".", "..", "../escape", "a/b", "a\\b", "a:", "a\n", "a."] {
        let mut request = request();
        request.extra.insert("team_name".to_owned(), json!(name));
        assert!(named_home_at(root.path(), &request).is_err());
        request
            .extra
            .insert("team_name".to_owned(), json!("design"));
        request.user_name = Some(name.to_owned());
        assert!(named_home_at(root.path(), &request).is_err());
    }
    let mut request = request();
    request.extra.remove("team_name");
    assert!(named_home_at(root.path(), &request).is_err());
}

#[test]
fn namespaces_and_executing_users_never_share_a_directory() {
    let root = tempfile::tempdir().unwrap();
    let mut request = request();
    let mut homes = std::collections::HashSet::new();
    for user in ["alice", "bob", "charlie"] {
        request.user_name = Some(user.to_owned());
        for namespace in ["default", "development", "org/design", "org%2Fdesign"] {
            request.team_namespace = Some(namespace.to_owned());
            let home = named_home_at(root.path(), &request).unwrap();
            assert_eq!(
                home.strip_prefix(root.path().join("agents"))
                    .unwrap()
                    .components()
                    .count(),
                3
            );
            assert!(homes.insert(home.clone()));
            drop(acquire_at(&request, root.path(), &home).unwrap());
        }
    }
    for namespace in ["", "/default", "a//b", "a/../b", "a/./b", "a/b/"] {
        request.team_namespace = Some(namespace.to_owned());
        assert!(named_home_at(root.path(), &request).is_err());
    }
    request.user_name = None;
    assert!(named_home_at(root.path(), &request).is_err());
}

#[test]
fn prefixed_user_home_requires_matching_owner_and_task() {
    let root = tempfile::tempdir().unwrap();
    let mut request = request();
    request.team_namespace = Some("default".to_owned());
    request.extra["team_owner"] = json!({"kind":"user","id":1,"name":"test-user"});
    let old = root
        .path()
        .join("agents/user-test-user/default/wegent-design");
    fs::create_dir_all(old.join("runtime/tasks")).unwrap();
    fs::write(old.join(".execution.lock"), "").unwrap();
    let mut identity = request_identity(&request).unwrap();
    identity["schema_version"] = json!(4);
    fs::write(old.join("agent.json"), identity.to_string()).unwrap();
    identity["task_id"] = json!(request.task_id);
    fs::write(
        task_binding(&old, &request.task_id).unwrap(),
        identity.to_string(),
    )
    .unwrap();
    request.new_session = false;
    let (source, lock) = verified_legacy_home(root.path(), &request)
        .unwrap()
        .unwrap();
    assert_eq!(source, old);
    drop(lock);
    let binding = task_binding(&old, &request.task_id).unwrap();
    let mut task = read_marker(&binding).unwrap();
    task["user_id"] = json!("2");
    fs::write(binding, task.to_string()).unwrap();
    assert!(verified_legacy_home(root.path(), &request)
        .unwrap_err()
        .contains("binding"));
}

#[test]
fn different_same_named_agents_cannot_overwrite_existing_home() {
    let root = tempfile::tempdir().unwrap();
    let mut request = request();
    request.team_namespace = Some("default".to_owned());
    request.extra["team_owner"] = json!({"kind":"public","id":0,"name":"public"});
    let home = named_home_at(root.path(), &request).unwrap();
    drop(acquire_at(&request, root.path(), &home).unwrap());
    request.extra["team_owner"] = json!({"kind":"user","id":1,"name":"public"});
    request.extra["team_id"] = json!(13);
    assert_eq!(named_home_at(root.path(), &request).unwrap(), home);
    assert!(acquire_at(&request, root.path(), &home)
        .unwrap_err()
        .contains("identity"));
}

#[test]
fn named_legacy_home_requires_namespace_and_task_binding_before_import() {
    let root = tempfile::tempdir().unwrap();
    let mut request = request();
    request.new_session = false;
    let legacy = legacy_named_home_at(root.path(), &request).unwrap();
    fs::create_dir_all(legacy.join("runtime/tasks")).unwrap();
    fs::write(legacy.join(".execution.lock"), "").unwrap();
    let mut marker = legacy_identity(&request).unwrap();
    marker["schema_version"] = json!(3);
    marker["team_namespace"] = json!(request.team_namespace);
    marker["team_name"] = request.extra["team_name"].clone();
    let mut task = legacy_identity(&request).unwrap();
    task["task_id"] = json!(request.task_id);
    let binding = task_binding(&legacy, &request.task_id).unwrap();
    fs::write(legacy.join("agent.json"), marker.to_string()).unwrap();
    fs::write(&binding, task.to_string()).unwrap();
    let (_, lock) = verified_legacy_home(root.path(), &request)
        .unwrap()
        .unwrap();
    assert!(verified_legacy_home(root.path(), &request)
        .unwrap_err()
        .contains("active"));
    drop(lock);
    for key in ["user_id", "team_id", "bot_id", "task_id"] {
        let mut wrong = task.clone();
        wrong[key] = json!("999");
        fs::write(&binding, wrong.to_string()).unwrap();
        assert!(verified_legacy_home(root.path(), &request).is_err());
    }
    fs::write(&binding, task.to_string()).unwrap();
    marker["team_namespace"] = json!("other");
    fs::write(legacy.join("agent.json"), marker.to_string()).unwrap();
    assert!(verified_legacy_home(root.path(), &request)
        .unwrap_err()
        .contains("identity"));
}

#[test]
fn skills_lookup_requires_matching_backend_and_account_even_for_unique_task() {
    let root = tempfile::tempdir().unwrap();
    let home = named_home_at(root.path(), &request()).unwrap();
    drop(acquire_at(&request(), root.path(), &home).unwrap());
    let skills = home.join("skills");
    fs::create_dir_all(&skills).unwrap();
    assert_eq!(
        task_skills_directory_at(root.path(), "task-1", "https://backend.example/", "1").unwrap(),
        skills
    );
    assert!(task_skills_directory_at(root.path(), "task-1", "https://other.example", "1").is_err());
    assert!(
        task_skills_directory_at(root.path(), "task-1", "https://backend.example", "2").is_err()
    );
    let path = task_binding(&home, "task-1").unwrap();
    let mut marker = read_marker(&path).unwrap();
    marker["task_id"] = json!("another-task");
    fs::write(path, marker.to_string()).unwrap();
    assert!(
        task_skills_directory_at(root.path(), "task-1", "https://backend.example", "1").is_err()
    );
}

#[test]
fn skills_lookup_prefers_current_user_home_after_session_migration() {
    let root = tempfile::tempdir().unwrap();
    let request = request();
    let old = root
        .path()
        .join("agents/group-wecode-ai/wecode-ai/wegent-design");
    fs::create_dir_all(old.join("runtime/tasks")).unwrap();
    let mut identity = legacy_identity(&request).unwrap();
    identity["schema_version"] = json!(5);
    fs::write(old.join("agent.json"), identity.to_string()).unwrap();
    fs::write(
        task_binding(&old, &request.task_id).unwrap(),
        json!({"task_id":"task-1","migrated_session":null}).to_string(),
    )
    .unwrap();
    let home = named_home_at(root.path(), &request).unwrap();
    drop(acquire_at(&request, root.path(), &home).unwrap());
    fs::create_dir_all(home.join("skills")).unwrap();
    assert_eq!(
        task_skills_directory_at(root.path(), "task-1", "https://backend.example", "1").unwrap(),
        home.join("skills")
    );
    assert!(old.join("agent.json").is_file());
}

#[test]
fn shell_only_desktop_request_does_not_create_an_agent_instance() {
    let mut request = ExecutionRequest {
        bot: json!([{"shell_type":"Codex"}]),
        ..Default::default()
    };
    assert!(request_home(&request).is_none());
    request.extra.insert("team_id".to_owned(), json!(0));
    request.bot[0]["id"] = json!(23);
    request
        .extra
        .insert("team_name".to_owned(), json!("Wework"));
    request
        .extra
        .insert("skill_names".to_owned(), json!(["interactive"]));
    assert!(request_home(&request).is_none());
    assert!(acquire(&request).unwrap().is_none());
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::{json, Value};

use super::{
    scan,
    store::{SessionContext, Store},
    subscribed_plugins, CodexRolloutObserver, HookUser,
};

const TIME: &str = "2026-09-09T00:00:00Z";

fn session(cwd: &Path) -> SessionContext {
    SessionContext {
        user: HookUser {
            id: Some("7".into()),
            name: "alice".into(),
        },
        cwd: cwd.into(),
        model: None,
        git_url: None,
        since: 0,
    }
}

fn append(path: &Path, records: &[Value]) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    for record in records {
        writeln!(file, "{record}").unwrap();
    }
}

fn metadata(id: &str) -> Value {
    json!({"type":"session_meta","payload":{"id":id}})
}

fn child_metadata(id: &str, parent: &str) -> Value {
    json!({"type":"session_meta","payload":{
        "id":id,
        "parent_thread_id":parent,
        "thread_source":"subagent",
        "source":{"subagent":{"thread_spawn":{"parent_thread_id":parent}}}}})
}

/// One completed edit writing the given files, in the shape Codex persists.
fn file_change(call_id: &str, files: &[&str]) -> Value {
    let changes = files
        .iter()
        .map(|path| {
            (
                (*path).to_owned(),
                json!({"type":"add","content":"hello\n"}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    json!({"type":"event_msg","timestamp":TIME,"payload":{"type":"item_completed","item":{
        "type":"FileChange","id":call_id,"status":"completed","changes":changes}}})
}

fn scan_home(store: &mut Store, home: &Path) -> scan::ScanOutcome {
    scan::scan(store, home, true, &BTreeSet::new()).unwrap()
}

fn drain(store: &Store) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    while let Some((id, input)) = store.next(i64::MAX).unwrap() {
        out.push((
            input.session_id.clone(),
            input.tool_use_id.clone(),
            input.tool_input["changes"][0]["path"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        ));
        store.complete(id).unwrap();
    }
    out
}

#[test]
fn registers_the_identity_of_a_routed_thread() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("reports.db");
    let observer = CodexRolloutObserver::new(database.clone(), temp.path().into());
    observer
        .register_root(
            "root",
            HookUser {
                id: Some("42".to_owned()),
                name: "alice".to_owned(),
            },
            temp.path().to_path_buf(),
            Some("gpt-5.4".to_owned()),
        )
        .unwrap();

    let thread = Store::open(&database)
        .unwrap()
        .thread("root")
        .unwrap()
        .expect("the routed thread should be registered");
    assert_eq!(thread.root, "root");
    assert_eq!(thread.context.user.id.as_deref(), Some("42"));
    assert_eq!(thread.context.user.name, "alice");
    assert_eq!(thread.context.cwd, temp.path());
    assert_eq!(thread.context.model.as_deref(), Some("gpt-5.4"));
}

#[test]
fn ignores_a_blank_thread_id() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("reports.db");
    let observer = CodexRolloutObserver::new(database.clone(), temp.path().into());
    observer
        .register_root(
            "  ",
            HookUser {
                id: Some("7".to_owned()),
                name: "alice".to_owned(),
            },
            temp.path().to_path_buf(),
            None,
        )
        .unwrap();

    assert!(Store::open(&database)
        .unwrap()
        .thread("root")
        .unwrap()
        .is_none());
}

#[test]
fn only_plugins_subscribed_to_the_rollout_feed_are_served() {
    let temp = tempfile::tempdir().unwrap();
    let plugins_dir = temp.path().join("hooks/plugins");
    write_plugin(&plugins_dir.join("subscriber"), &["codex_rollout"], true);
    write_plugin(&plugins_dir.join("live"), &[], true);
    write_plugin(&plugins_dir.join("disabled"), &["codex_rollout"], false);

    let registry = crate::hooks::registry::HookRegistryStore::new(temp.path().to_path_buf());
    let subscribers = subscribed_plugins(&registry);

    assert!(subscribers.installed);
    assert!(subscribers.enabled);
    assert_eq!(
        subscribers
            .delivering
            .iter()
            .map(|plugin| plugin.manifest.id.as_str())
            .collect::<Vec<_>>(),
        vec!["subscriber"]
    );
}

#[test]
fn a_registry_without_a_subscriber_has_nothing_to_observe() {
    let temp = tempfile::tempdir().unwrap();
    let plugins_dir = temp.path().join("hooks/plugins");
    write_plugin(&plugins_dir.join("live"), &[], true);

    let registry = crate::hooks::registry::HookRegistryStore::new(temp.path().to_path_buf());
    let subscribers = subscribed_plugins(&registry);

    assert!(!subscribers.installed);
    assert!(!subscribers.enabled);
    assert!(subscribers.delivering.is_empty());
}

fn write_plugin(directory: &Path, subscriptions: &[&str], enabled: bool) {
    fs::create_dir_all(directory).unwrap();
    let id = directory.file_name().unwrap().to_string_lossy();
    fs::write(
        directory.join("plugin.json"),
        json!({
            "schemaVersion": 1,
            "id": id,
            "name": id,
            "version": "1.0.0",
            "subscriptions": subscriptions,
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        directory.join("hooks.json"),
        json!({"PostToolUse":[{"matcher":"^apply_patch$","hooks":[
            {"type":"command","command":"reporter"}]}]})
        .to_string(),
    )
    .unwrap();
    let registry_path = directory
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("registry.json");
    let mut registry: Value = fs::read_to_string(&registry_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_else(|| json!({"schemaVersion": 1, "plugins": {}}));
    registry["plugins"][id.as_ref()] = json!({
        "enabled": enabled,
        "source": "user",
        "installPath": directory,
        "policy": {"canDisable": true, "canEdit": true, "canDelete": true},
    });
    fs::write(&registry_path, registry.to_string()).unwrap();
}

#[test]
fn reports_every_written_file_once_and_keeps_offsets_across_restarts() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let path = temp.path().join("sessions/rollout-root.jsonl");
    append(
        &path,
        &[metadata("root"), file_change("call-1", &["a.rs", "b.rs"])],
    );

    let database = temp.path().join("reports.db");
    {
        let mut store = Store::open(&database).unwrap();
        store.register_root("root", &session(temp.path())).unwrap();
        let outcome = scan_home(&mut store, temp.path());
        assert_eq!(outcome.reports, 2);
        let reports = drain(&store);
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().all(|(session, _, _)| session == "root"));
        assert_eq!(reports[0].1, "call-1");
        assert!(reports[0].2.ends_with("a.rs"));
        assert!(reports[1].2.ends_with("b.rs"));
    }

    // Restarting the executor must not replay acknowledged edits.
    let mut store = Store::open(&database).unwrap();
    assert_eq!(scan_home(&mut store, temp.path()).reports, 0);
    append(&path, &[file_change("call-2", &["a.rs"])]);
    let outcome = scan_home(&mut store, temp.path());
    assert_eq!(outcome.reports, 1);
    assert_eq!(drain(&store).len(), 1);
}

#[test]
fn subagent_writes_are_attributed_to_the_task_but_only_counted_once() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("sessions/2026/09/09")).unwrap();
    let root = temp.path().join("sessions/rollout-root.jsonl");
    let child = temp.path().join("sessions/2026/09/09/rollout-child.jsonl");
    let file = temp.path().join("shared.rs");
    let file = file.to_string_lossy().into_owned();
    append(&root, &[metadata("root")]);
    // The subagent rollout mirrors the parent's history prefix, so the same
    // call id can show up in both files; it is still one edit.
    append(&root, &[file_change("call-shared", &[file.as_str()])]);
    append(
        &child,
        &[
            child_metadata("child", "root"),
            json!({"type":"response_item","timestamp":TIME,"payload":{
                "type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}),
            file_change("call-shared", &[file.as_str()]),
            file_change("call-child", &[file.as_str()]),
        ],
    );

    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    let outcome = scan_home(&mut store, temp.path());
    assert_eq!(outcome.reports, 2, "one mirrored edit plus one own edit");
    let mut inputs = Vec::new();
    while let Some((id, input)) = store.next(i64::MAX).unwrap() {
        inputs.push(input);
        store.complete(id).unwrap();
    }
    assert_eq!(inputs.len(), 2);
    assert!(inputs.iter().all(|input| input.session_id == "root"));
    // The subagent edit keeps the task session but records its own thread.
    let subagent_edit = inputs
        .iter()
        .find(|input| input.tool_use_id == "call-child")
        .expect("the subagent edit must be reported");
    assert_eq!(subagent_edit.agent_id.as_deref(), Some("child"));
    assert_eq!(subagent_edit.agent_type.as_deref(), Some("subagent"));
    assert_eq!(
        inputs
            .iter()
            .map(|input| input.tool_use_id.as_str())
            .collect::<Vec<_>>(),
        vec!["call-shared", "call-child"]
    );
}

#[test]
fn repeated_edits_of_one_file_are_counted_every_time() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let path = temp.path().join("sessions/rollout-root.jsonl");
    append(
        &path,
        &[
            metadata("root"),
            file_change("call-1", &["a.rs"]),
            file_change("call-2", &["a.rs"]),
            file_change("call-3", &["a.rs"]),
        ],
    );
    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    assert_eq!(scan_home(&mut store, temp.path()).reports, 3);
    assert_eq!(drain(&store).len(), 3);
}

#[test]
fn subagent_with_an_unregistered_parent_is_left_for_a_later_pass() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let child = temp.path().join("sessions/rollout-child.jsonl");
    append(
        &child,
        &[
            child_metadata("child", "root"),
            file_change("call-child", &["a.rs"]),
        ],
    );
    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    let outcome = scan_home(&mut store, temp.path());
    assert_eq!(outcome.reports, 0);
    assert_eq!(outcome.unresolved, 1);
    assert_eq!(store.report_counts().unwrap(), (0, 0));

    // Once the task thread is registered the pending subagent edits flow in.
    store.register_root("root", &session(temp.path())).unwrap();
    assert_eq!(scan_home(&mut store, temp.path()).reports, 1);
    assert_eq!(drain(&store).len(), 1);
}

#[test]
fn disabled_plugin_window_is_consumed_without_reporting_history() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let path = temp.path().join("sessions/rollout-root.jsonl");
    append(&path, &[metadata("root"), file_change("off", &["a.rs"])]);
    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    let outcome = scan::scan(&mut store, temp.path(), false, &BTreeSet::new()).unwrap();
    assert_eq!(outcome.reports, 0);
    let (rows, pending) = store.report_counts().unwrap();
    assert_eq!(
        (rows, pending),
        (1, 0),
        "disabled edits are consumed, not queued"
    );

    append(&path, &[file_change("on", &["b.rs"])]);
    assert_eq!(scan_home(&mut store, temp.path()).reports, 1);
    assert_eq!(drain(&store).len(), 1);
}

#[test]
fn rollouts_that_predate_the_observer_are_not_replayed() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let path = temp.path().join("sessions/rollout-root.jsonl");
    append(&path, &[metadata("root"), file_change("old", &["a.rs"])]);
    let startup: BTreeSet<PathBuf> = [path.clone()].into_iter().collect();
    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    let outcome = scan::scan(&mut store, temp.path(), true, &startup).unwrap();
    assert_eq!(outcome.reports, 0);
    assert_eq!(store.report_counts().unwrap(), (0, 0));

    append(&path, &[file_change("new", &["b.rs"])]);
    assert_eq!(
        scan::scan(&mut store, temp.path(), true, &startup)
            .unwrap()
            .reports,
        1
    );
    assert_eq!(drain(&store).len(), 1);
}

#[test]
fn custom_tool_call_apply_patch_uses_the_exec_output_contract() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let path = temp.path().join("sessions/rollout-root.jsonl");
    append(
        &path,
        &[
            metadata("root"),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch",
                "call_id":"call-1","input":"*** Begin Patch\n*** Update File: a.rs\n@@\n-old\n+new\n*** End Patch"}}),
            json!({"type":"response_item","timestamp":TIME,"payload":{"type":"custom_tool_call_output",
                "call_id":"call-1","output":"Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM a.rs"}}),
        ],
    );
    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    assert_eq!(scan_home(&mut store, temp.path()).reports, 1);
    let reports = drain(&store);
    assert_eq!(reports.len(), 1);
    assert!(reports[0].2.ends_with("a.rs"));
}

#[test]
fn nested_subagent_sources_and_deep_chains_resolve_to_the_root() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("sessions/2026/09/09")).unwrap();
    // 0.149 rollouts only carry the parent link inside the nested source.
    append(
        &temp.path().join("sessions/2026/09/09/rollout-child.jsonl"),
        &[
            json!({"type":"session_meta","payload":{
                "id":"child",
                "source":{"subagent":{"thread_spawn":{"parent_thread_id":"root"}}}}}),
            file_change("call-child", &["a.rs"]),
        ],
    );
    // Grandchildren resolve through the chain, in either file order.
    append(
        &temp
            .path()
            .join("sessions/2026/09/09/rollout-grandchild.jsonl"),
        &[
            json!({"type":"session_meta","payload":{
                "id":"grandchild",
                "source":{"subagent":{"thread_spawn":{"parent_thread_id":"child"}}}}}),
            file_change("call-grandchild", &["b.rs"]),
        ],
    );
    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    let outcome = scan_home(&mut store, temp.path());
    assert_eq!(outcome.reports, 2);
    assert_eq!(outcome.unresolved, 0);
    let reports = drain(&store);
    assert_eq!(reports.len(), 2);
    assert!(reports.iter().all(|(session, _, _)| session == "root"));
}

#[test]
fn a_malformed_record_does_not_block_later_edits() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let path = temp.path().join("sessions/rollout-root.jsonl");
    append(&path, &[metadata("root")]);
    // A torn write: Codex flushed part of a record before the newline arrived.
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(file, "{{\"type\":\"event_msg\",\"payload\":{{").unwrap();
    drop(file);
    append(&path, &[file_change("call-1", &["a.rs"])]);

    let database = temp.path().join("reports.db");
    let mut store = Store::open(&database).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    let outcome = scan_home(&mut store, temp.path());
    assert_eq!(outcome.errors, 0);
    assert_eq!(outcome.reports, 1);
    let reports = drain(&store);
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].1, "call-1");

    // The cursor moved past the bad record, so a later pass reads only new data.
    append(&path, &[file_change("call-2", &["b.rs"])]);
    assert_eq!(scan_home(&mut store, temp.path()).reports, 1);
    assert_eq!(drain(&store).len(), 1);
}

#[test]
fn a_change_without_a_usable_timestamp_does_not_block_later_edits() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let path = temp.path().join("sessions/rollout-root.jsonl");
    let mut undated = file_change("call-1", &["a.rs"]);
    undated["timestamp"] = json!("not-a-timestamp");
    let mut unstamped = file_change("call-2", &["b.rs"]);
    unstamped.as_object_mut().unwrap().remove("timestamp");
    append(
        &path,
        &[
            metadata("root"),
            undated,
            unstamped,
            file_change("call-3", &["c.rs"]),
        ],
    );

    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    let outcome = scan_home(&mut store, temp.path());
    assert_eq!(outcome.errors, 0);
    assert_eq!(outcome.reports, 1);
    let reports = drain(&store);
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].1, "call-3");
}

#[test]
fn an_unknown_file_change_shape_does_not_block_later_edits() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let path = temp.path().join("sessions/rollout-root.jsonl");
    // A completed file change whose payload carries no shape this parser knows.
    let unknown = json!({"type":"event_msg","timestamp":TIME,"payload":{
        "type":"item_completed",
        "item":{"type":"FileChange","id":"call-1","status":"completed"}}});
    append(
        &path,
        &[metadata("root"), unknown, file_change("call-2", &["a.rs"])],
    );

    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    let outcome = scan_home(&mut store, temp.path());
    assert_eq!(outcome.errors, 0);
    assert_eq!(outcome.reports, 1);
    let reports = drain(&store);
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].1, "call-2");
}

#[test]
fn a_rollout_without_a_session_meta_header_is_never_adopted() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("sessions")).unwrap();
    let path = temp.path().join("sessions/rollout-root.jsonl");
    append(
        &path,
        &[
            json!({"type":"event_msg","payload":{}}),
            file_change("call-1", &["a.rs"]),
        ],
    );

    let mut store = Store::open(&temp.path().join("reports.db")).unwrap();
    store.register_root("root", &session(temp.path())).unwrap();
    // A file we cannot adopt is left unresolved instead of failing the scan
    // forever with an error.
    let outcome = scan_home(&mut store, temp.path());
    assert_eq!(outcome.errors, 0);
    assert_eq!(outcome.reports, 0);
    assert_eq!(outcome.unresolved, 1);
}

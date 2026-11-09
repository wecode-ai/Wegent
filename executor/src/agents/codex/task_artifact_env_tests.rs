// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

const LOCAL_DELIVERY_KEYS: &[&str] = &[
    "WEGENT_EXECUTOR_BINARY",
    "WEGENT_TASK_ID",
    "WEGENT_TASK_WORKSPACE",
];

#[test]
fn external_work_receives_only_local_delivery_metadata() {
    let _environment = super::tests::environment::LaunchEnvironment::new();
    let workspace = tempfile::tempdir().unwrap();
    for kind in [
        None,
        Some("stand_in_task"),
        Some("connection_work"),
        Some("dingtalk_work"),
        Some("issue_dispatch"),
    ] {
        for ask in [false, true] {
            let mut request: ExecutionRequest = serde_json::from_value(json!({
                "task_id":"123",
                "project_workspace_path":workspace.path(),
                "auth_token":"private-task-credential",
                "runtime_auth_token":"private-runtime-credential",
                "skill_identity_token":"private-skill-credential",
                "user_name":"private-user",
                "runtimeLocalTaskId":"local-delegated-task",
                "standInDelegation":{"sourceTaskId":"primary","userId":7,"askBeforeAct":ask}
            }))
            .unwrap();
            if let Some(kind) = kind {
                request.extra.insert(
                    "origin".into(),
                    json!({
                        "type":kind,"initiatedBy":"stand_in","askBeforeAct":ask
                    }),
                );
                if kind != "stand_in_task" {
                    request.extra.remove("standInDelegation");
                }
                if kind == "issue_dispatch" {
                    let origin = request.extra.get_mut("origin").unwrap();
                    origin["dispatchRole"] = json!("executor");
                    origin["cloudProjectId"] = json!("project-1");
                    origin["loopItemId"] = json!("issue-1");
                }
            }
            let launch = build_codex_launch_config(&request).unwrap();
            for params in [
                thread_start_params(&request, &launch),
                thread_resume_params("thread", &request, &launch),
                thread_fork_params("thread", None, &request, &launch),
            ] {
                let config = params["config"].as_object().unwrap();
                let task_keys: BTreeSet<_> = config
                    .keys()
                    .filter_map(|key| key.strip_prefix("shell_environment_policy.set."))
                    .filter(|key| TASK_SCOPED_ENV_KEYS.contains(key))
                    .collect();
                assert_eq!(task_keys, LOCAL_DELIVERY_KEYS.iter().copied().collect());
                assert_eq!(
                    config["shell_environment_policy.set.WEGENT_TASK_ID"],
                    "local-delegated-task"
                );
                assert_eq!(
                    Path::new(
                        config["shell_environment_policy.set.WEGENT_TASK_WORKSPACE"]
                            .as_str()
                            .unwrap()
                    ),
                    workspace.path()
                );
                assert_eq!(
                    config["shell_environment_policy.set.WEGENT_EXECUTOR_BINARY"],
                    std::env::current_exe().unwrap().to_string_lossy().as_ref()
                );
                assert_eq!(
                    params["permissions"],
                    external_work::profile(&request).unwrap()
                );
                assert_eq!(
                    params["approvalsReviewer"],
                    external_work::reviewer(&request)
                );
                assert_eq!(config["default_permissions"], params["permissions"]);
            }
            for key in TASK_SCOPED_ENV_KEYS {
                assert!(!launch.env.contains_key(*key));
                assert!(!launch
                    .config_overrides
                    .iter()
                    .any(|item| item.starts_with(&format!("shell_environment_policy.set.{key}="))));
            }
        }
    }
}

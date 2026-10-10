// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn with_agent_identity(mut request: ExecutionRequest) -> ExecutionRequest {
    request.bot[0]["id"] = json!(23);
    request.new_session = true;
    request.user_name = Some("test-user".to_owned());
    request.team_namespace = Some("default".to_owned());
    request.extra.extend(serde_json::Map::from_iter([
        ("team_id".to_owned(), json!(12)),
        ("team_name".to_owned(), json!("skill-test-agent")),
        (
            "team_owner".to_owned(),
            json!({"kind":"user", "id":7, "name":"test-user"}),
        ),
        ("user_id".to_owned(), json!(7)),
    ]));
    request
}

#[tokio::test]
async fn prepare_codex_runtime_leaves_native_plugin_skills_to_codex() {
    let workspace = tempfile::tempdir().unwrap();
    let request = ExecutionRequest {
        project_workspace_path: Some(workspace.path().display().to_string()),
        extra: serde_json::Map::from_iter([
            (
                "preload_skills".to_owned(),
                json!(["wework-plugin-creator"]),
            ),
            (
                "additional_skills".to_owned(),
                json!([{"name": "wework-plugin-creator", "namespace": "codex"}]),
            ),
        ]),
        ..ExecutionRequest::default()
    };

    prepare_codex_runtime(&request).await.unwrap();

    assert!(!workspace.path().join(".codex/skills").exists());
}

#[tokio::test]
async fn shell_only_bot_does_not_materialize_repository_skills() {
    let workspace = tempfile::tempdir().unwrap();
    let request = ExecutionRequest {
        bot: json!([{"shell_type":"Codex"}]),
        project_workspace_path: Some(workspace.path().display().to_string()),
        ..Default::default()
    };
    prepare_codex_runtime(&request).await.unwrap();
    assert!(!workspace.path().join(".codex").exists());
}

#[test]
fn immutable_prewarmed_package_is_reused_without_network() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _workbench = EnvGuard::set("WEGENT_WORKBENCH_HOME", root.path().to_str().unwrap());
    let package = crate::services::workbench::publish_skill_archive(
        root.path(),
        &skill_zip_bytes("cached"),
        None,
    )
    .unwrap();
    let selection = root.path().join("selection");
    fs::create_dir_all(&selection).unwrap();
    let plan = SkillDeploymentPlan {
        skills: vec!["cached".to_owned()],
        skill_namespaces: BTreeMap::new(),
        auth_token: "test".to_owned(),
        team_namespace: "default".to_owned(),
        task_id: Some(123),
        skills_dir: selection,
        clear_cache: false,
        skip_existing: false,
        resolved_skill_map: BTreeMap::new(),
    };
    let reference = SkillRef {
        skill_id: 12,
        namespace: "default".to_owned(),
        is_public: false,
        content_hash: Some(package.archive_hash),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = runtime
        .block_on(download_skill(
            &reqwest::Client::new(),
            &plan,
            "cached",
            Some(&reference),
            "http://127.0.0.1:1",
        ))
        .unwrap();
    assert!(result.success);
    assert!(result.installed.is_some());
    assert!(!root.path().join("agents").exists());
}

#[test]
fn prepare_codex_runtime_rejects_missing_required_skill_plan() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _workbench = EnvGuard::set("WEGENT_WORKBENCH_HOME", root.path().to_str().unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let request = with_agent_identity(ExecutionRequest {
        task_id: "missing-required-plan".to_owned(),
        bot: json!([{"shell_type": "Codex", "skills": ["required-skill"]}]),
        extra: serde_json::Map::from_iter([(
            "preload_skills".to_owned(),
            json!(["required-skill"]),
        )]),
        ..ExecutionRequest::default()
    });

    let error = runtime
        .block_on(prepare_codex_runtime_locked(&request))
        .unwrap_err();

    assert_eq!(
        error,
        "required Skills are missing from the deployment plan: required-skill"
    );
}

#[test]
fn prepare_codex_runtime_enforces_required_skill_archive() {
    let _lock = crate::test_env::lock();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let _backend = EnvGuard::remove("WEGENT_BACKEND_URL");
        let _mode = EnvGuard::set("EXECUTOR_MODE", "local");
        for valid_archive in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let _workbench = EnvGuard::set("WEGENT_WORKBENCH_HOME", temp.path().to_str().unwrap());
            let archive = if valid_archive {
                skill_zip_bytes("required-skill")
            } else {
                skill_zip_entries(&[("required-skill/README.md", "Incomplete Skill")])
            };
            let (api_base_url, server) =
                serve_skill_archive_responses(BTreeMap::from([(42, archive)])).await;
            let _api = EnvGuard::set("TASK_API_DOMAIN", &api_base_url);
            let request = with_agent_identity(ExecutionRequest {
                task_id: "required-archive".to_owned(),
                backend_url: Some(api_base_url.clone()),
                bot: json!([{"shell_type": "Codex", "skills": ["required-skill"]}]),
                project_workspace_path: Some(temp.path().display().to_string()),
                auth_token: Some("test-token".to_owned()),
                extra: serde_json::Map::from_iter([
                    ("user_id".to_owned(), json!(7)),
                    ("preload_skills".to_owned(), json!(["required-skill"])),
                    (
                        "skill_refs".to_owned(),
                        json!({
                            "required-skill": {"skill_id": 42, "namespace": "default"}
                        }),
                    ),
                ]),
                ..ExecutionRequest::default()
            });

            let result = prepare_codex_runtime(&request).await;
            let requested = tokio::time::timeout(Duration::from_secs(5), server)
                .await
                .expect("mock Skill archive server timed out")
                .unwrap();
            assert_eq!(requested, vec![42]);

            if valid_archive {
                result.unwrap();
                assert_eq!(
                    fs::read_to_string(crate::agents::instance_home::request_home(&request).unwrap().join("skills/required-skill/SKILL.md"))
                        .unwrap(),
                    "# Skill"
                );
            } else {
                assert_eq!(
                    result.unwrap_err(),
                    "required Skill deployment failed: required-skill (downloaded Skill ZIP is missing required SKILL.md)"
                );
            }
        }
    });
}

#[test]
fn prepare_codex_runtime_deploys_skills_only_under_selected_home() {
    assert_codex_skill_deployment(true, false);
}

#[test]
fn older_backend_request_prepares_user_home_skills_without_owner() {
    assert_codex_skill_deployment(false, false);
}

#[test]
fn direct_profile_deploys_selected_backend_skills_in_its_workspace() {
    assert_codex_skill_deployment(false, true);
}

fn assert_codex_skill_deployment(with_owner: bool, direct_profile: bool) {
    let _lock = crate::test_env::lock();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let temp = tempfile::tempdir().unwrap();
        let _workbench = EnvGuard::set("WEGENT_WORKBENCH_HOME", temp.path().to_str().unwrap());
        let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
        let _root = EnvGuard::remove("WORKSPACE_ROOT");
        let _projects = EnvGuard::set(
            "WEGENT_EXECUTOR_PROJECTS_DIR",
            temp.path().to_str().unwrap(),
        );
        let _legacy = EnvGuard::set(
            "WEGENT_WORKSPACE_ROOT",
            temp.path().join("legacy").to_str().unwrap(),
        );
        let _backend = EnvGuard::remove("WEGENT_BACKEND_URL");
        let (api, server) = serve_skill_archive_responses(BTreeMap::from([(
            42,
            skill_zip_bytes("required-skill"),
        )]))
        .await;
        let _api = EnvGuard::set("TASK_API_DOMAIN", &api);
        let mut request = with_agent_identity(ExecutionRequest {
            task_id: "502".to_owned(),
            project_workspace_path: Some(temp.path().join("workspace").display().to_string()),
            backend_url: Some(api.clone()),
            bot: json!([{"shell_type": "Codex", "skills": ["required-skill"]}]),
            auth_token: Some("test-token".to_owned()),
            extra: serde_json::Map::from_iter([
                ("user_id".to_owned(), json!(7)),
                ("preload_skills".to_owned(), json!(["required-skill"])),
                (
                    "skill_refs".to_owned(),
                    json!({"required-skill": {"skill_id": 42, "namespace": "default"}}),
                ),
            ]),
            ..ExecutionRequest::default()
        });
        if !with_owner {
            request.extra.remove("team_owner");
        }
        let skills_dir = if direct_profile {
            request.extra.insert("team_id".to_owned(), json!(0));
            temp.path().join("workspace/.codex/skills")
        } else {
            temp.path()
                .join("agents/test-user/default/skill-test-agent/skills")
        };

        prepare_codex_runtime(&request).await.unwrap();
        let requested = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("mock Skill archive server timed out")
            .unwrap();
        assert_eq!(requested, vec![42]);

        assert_eq!(
            fs::read_to_string(skills_dir.join("required-skill/SKILL.md")).unwrap(),
            "# Skill"
        );
        assert!(!temp.path().join("legacy").exists());
        if direct_profile {
            assert!(!temp.path().join("agents").exists());
            assert!(!temp.path().join("codex/skills").exists());
        } else {
            assert!(!temp.path().join("workspace/.codex").exists());
        }
    });
}

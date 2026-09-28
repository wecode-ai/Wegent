// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

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
async fn prepare_codex_runtime_rejects_missing_required_skill_plan() {
    let request = ExecutionRequest {
        bot: json!([{"shell_type": "Codex", "skills": ["required-skill"]}]),
        extra: serde_json::Map::from_iter([(
            "preload_skills".to_owned(),
            json!(["required-skill"]),
        )]),
        ..ExecutionRequest::default()
    };

    let error = prepare_codex_runtime(&request).await.unwrap_err();

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
            let archive = if valid_archive {
                skill_zip_bytes("required-skill")
            } else {
                skill_zip_entries(&[("required-skill/README.md", "Incomplete Skill")])
            };
            let api_base_url = serve_skill_archive_responses(BTreeMap::from([(42, archive)])).await;
            let _api = EnvGuard::set("TASK_API_DOMAIN", &api_base_url);
            let request = ExecutionRequest {
                bot: json!([{"shell_type": "Codex", "skills": ["required-skill"]}]),
                project_workspace_path: Some(temp.path().display().to_string()),
                auth_token: Some("test-token".to_owned()),
                extra: serde_json::Map::from_iter([
                    ("preload_skills".to_owned(), json!(["required-skill"])),
                    (
                        "skill_refs".to_owned(),
                        json!({
                            "required-skill": {"skill_id": 42, "namespace": "default"}
                        }),
                    ),
                ]),
                ..ExecutionRequest::default()
            };

            let result = prepare_codex_runtime(&request).await;

            if valid_archive {
                result.unwrap();
                assert_eq!(
                    fs::read_to_string(temp.path().join(".codex/skills/required-skill/SKILL.md"))
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
fn prepare_codex_runtime_deploys_skills_under_canonical_workspace() {
    let _lock = crate::test_env::lock();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let temp = tempfile::tempdir().unwrap();
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
        let api = serve_skill_archive_responses(BTreeMap::from([(
            42,
            skill_zip_bytes("required-skill"),
        )]))
        .await;
        let _api = EnvGuard::set("TASK_API_DOMAIN", &api);
        let request = ExecutionRequest {
            task_id: "502".to_owned(),
            bot: json!([{"shell_type": "Codex", "skills": ["required-skill"]}]),
            auth_token: Some("test-token".to_owned()),
            extra: serde_json::Map::from_iter([
                ("preload_skills".to_owned(), json!(["required-skill"])),
                (
                    "skill_refs".to_owned(),
                    json!({"required-skill": {"skill_id": 42, "namespace": "default"}}),
                ),
            ]),
            ..ExecutionRequest::default()
        };

        prepare_codex_runtime(&request).await.unwrap();

        assert_eq!(
            fs::read_to_string(
                temp.path()
                    .join("502/.codex/skills/required-skill/SKILL.md")
            )
            .unwrap(),
            "# Skill"
        );
        assert!(!temp.path().join("legacy").exists());
    });
}

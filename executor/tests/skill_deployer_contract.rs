// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, path::PathBuf};

use serde_json::json;
use wegent_executor::{
    protocol::ExecutionRequest,
    services::skill_deployer::{
        build_skill_deployment_plan, build_skill_emphasis_prompt,
        collect_skill_names_for_deployment, resolve_skill_download_map, SkillDeploymentOptions,
        SkillRef,
    },
};

#[test]
fn resolve_skill_download_map_prefers_config_and_preload_override() {
    let resolved = resolve_skill_download_map(
        &["dup-skill".to_owned(), "plain-skill".to_owned()],
        &["dup-skill".to_owned()],
        &[json!({
            "name": "dup-skill",
            "skill_id": 100,
            "namespace": "team-a",
            "is_public": false,
        })],
        &BTreeMap::from([(
            "plain-skill".to_owned(),
            json!({
                "skill_id": 200,
                "namespace": "default",
                "is_public": true,
            }),
        )]),
        &BTreeMap::from([(
            "dup-skill".to_owned(),
            json!({
                "skill_id": 300,
                "namespace": "team-b",
                "is_public": false,
            }),
        )]),
    );

    assert_eq!(resolved["dup-skill"].skill_id, 300);
    assert_eq!(resolved["plain-skill"].skill_id, 200);
}

#[test]
fn resolve_skill_download_map_prefers_explicit_refs_over_skill_configs() {
    let resolved = resolve_skill_download_map(
        &["conflict-skill".to_owned()],
        &[],
        &[json!({
            "name": "conflict-skill",
            "skill_id": 111,
            "namespace": "default",
            "is_public": false,
        })],
        &BTreeMap::from([(
            "conflict-skill".to_owned(),
            json!({
                "skill_id": 222,
                "namespace": "team-a",
                "is_public": false,
                "content_hash": "sha256:new",
            }),
        )]),
        &BTreeMap::new(),
    );

    assert_eq!(
        resolved["conflict-skill"],
        SkillRef {
            skill_id: 222,
            namespace: "team-a".to_owned(),
            is_public: false,
            content_hash: Some("sha256:new".to_owned()),
        }
    );
}

#[test]
fn emphasis_prompt_prioritizes_selected_knowledge_skill() {
    let prompt = build_skill_emphasis_prompt(&["wegent-knowledge".to_owned()]);

    assert!(prompt.contains("wegent-knowledge"));
    assert!(prompt
        .to_ascii_lowercase()
        .contains("selected knowledge bases"));
    assert!(prompt.to_ascii_lowercase().contains("before web search"));
}

#[test]
fn coordinate_mode_collects_member_bot_skills_for_deployment() {
    let request = ExecutionRequest {
        bot: json!([
            {"name": "leader", "skills": ["leader-skill"]},
            {"name": "dubhe_bot", "skills": ["dubhe-skill"]},
        ]),
        extra: serde_json::Map::from_iter([
            ("mode".to_owned(), json!("coordinate")),
            ("skill_names".to_owned(), json!(["request-skill"])),
            ("preload_skills".to_owned(), json!(["preload-skill"])),
        ]),
        ..ExecutionRequest::default()
    };

    let skills = collect_skill_names_for_deployment(&request.bot[0], &request);

    assert_eq!(
        skills,
        vec![
            "leader-skill",
            "dubhe-skill",
            "request-skill",
            "preload-skill"
        ]
    );
}

#[test]
fn deployment_plan_passes_task_id_for_shared_skill_auth() {
    let request = ExecutionRequest {
        task_id: "5_258_563".to_owned(),
        auth_token: Some("token".to_owned()),
        team_namespace: Some("default".to_owned()),
        extra: serde_json::Map::from_iter([(
            "skill_refs".to_owned(),
            json!({
                "private-skill": {
                    "skill_id": 251069,
                    "namespace": "default",
                    "is_public": false,
                }
            }),
        )]),
        ..ExecutionRequest::default()
    };

    let plan = build_skill_deployment_plan(
        &json!({"skills": ["private-skill"]}),
        &request,
        SkillDeploymentOptions {
            skills_dir: PathBuf::from("/tmp/skills"),
            clear_cache: true,
            skip_existing: false,
        },
    )
    .unwrap();

    assert_eq!(plan.task_id.as_deref(), Some("5_258_563"));
    assert_eq!(plan.auth_token, "token");
    assert_eq!(plan.team_namespace, "default");
    assert_eq!(plan.skills_dir, PathBuf::from("/tmp/skills"));
    assert!(plan.clear_cache);
    assert!(!plan.skip_existing);
    assert_eq!(plan.resolved_skill_map["private-skill"].skill_id, 251069);
}

#[test]
fn deployment_plan_is_none_without_skills_or_auth_token() {
    let options = SkillDeploymentOptions {
        skills_dir: PathBuf::from("/tmp/skills"),
        clear_cache: true,
        skip_existing: false,
    };
    let request = ExecutionRequest::default();

    assert!(build_skill_deployment_plan(&json!({}), &request, options.clone()).is_none());
    assert!(
        build_skill_deployment_plan(&json!({"skills": ["private-skill"]}), &request, options)
            .is_none()
    );
}

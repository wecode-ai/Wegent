// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Execution request construction and lookup ordering.

use super::super::resolution::flat_model_config_error;
use super::{BuildExecutionRequestInput, KindRow, build_chat_execution_request};
use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value as SqlValue};
use brz_mysql::Json;
use serde_json::{Value, json};

#[test]
fn a_bot_without_a_model_is_a_400_with_the_source_message() {
    // `get_model_config_for_bot`: `not model_name` raises
    // `Bot {bot.name} has no model configured`.
    let error = flat_model_config_error(None, "示例机器人");
    assert_eq!(error.status(), brz_http_server::StatusCode::BAD_REQUEST);
    assert_eq!(
        error.detail_message(),
        Some("Bot 示例机器人 has no model configured")
    );
}

#[test]
fn an_unresolved_model_is_a_400_with_the_source_message() {
    // `get_model_config_for_bot`: `model_name` with no Model raises
    // `Model {model_name} not found`.
    let error = flat_model_config_error(Some("sample-model（国内）"), "示例机器人");
    assert_eq!(error.status(), brz_http_server::StatusCode::BAD_REQUEST);
    assert_eq!(
        error.detail_message(),
        Some("Model sample-model（国内） not found")
    );
}

const ANALYSIS_SKILL: &str = "offline-analyzer";

fn stored_kind(id: i64, owner: i64, kind: &str, name: &str, spec: Value) -> KindRow {
    KindRow {
        id,
        user_id: owner,
        kind: kind.into(),
        name: name.into(),
        namespace: "default".into(),
        json: Json(json!({"spec": spec})),
        is_active: 1,
        created_at: None,
        updated_at: None,
    }
}

fn kind_result(kind: KindRow) -> (Row, Vec<Row>) {
    let row = vec![
        ("kinds_id", SqlValue::I64(kind.id)),
        ("kinds_user_id", SqlValue::I64(kind.user_id)),
        ("kinds_kind", SqlValue::Text(kind.kind)),
        ("kinds_name", SqlValue::Text(kind.name)),
        ("kinds_namespace", SqlValue::Text(kind.namespace)),
        ("kinds_json", SqlValue::Text(kind.json.0.to_string())),
        ("kinds_is_active", SqlValue::I8(1)),
        ("kinds_created_at", SqlValue::DateTime),
        ("kinds_updated_at", SqlValue::DateTime),
    ];
    (row.clone(), vec![row])
}

fn skill_fixture(sql: &str, automatic: bool, preload: bool) -> (Row, Vec<Row>) {
    if sql.contains("'SkillBinding'") && automatic {
        return kind_result(stored_kind(
            10,
            7,
            "SkillBinding",
            "automatic-analysis",
            json!({
                "targetType": "user",
                "targetId": "user:7",
                "skillRef": {"skillId": 11},
                "forcePreload": preload,
            }),
        ));
    }
    if sql.contains("'Ghost'") || sql.contains("kinds.user_id = 0 AND kinds.kind = ?") {
        return kind_result(stored_kind(
            12,
            0,
            "Ghost",
            "analysis-ghost",
            if automatic {
                json!({})
            } else {
                json!({
                    "skills": [ANALYSIS_SKILL],
                    "preload_skills": if preload { vec![ANALYSIS_SKILL] } else { vec![] },
                    "skill_refs": {(ANALYSIS_SKILL): {"skill_id": 11, "is_public": true}},
                })
            },
        ));
    }
    if sql.contains("'Skill'") && sql.contains("kinds.id = ?") {
        return kind_result(stored_kind(
            11,
            0,
            "Skill",
            ANALYSIS_SKILL,
            json!({"bindShells": ["ClaudeCode"]}),
        ));
    }
    if sql.contains("'Model'") {
        let (mut row, _) = kind_result(stored_kind(
            13,
            7,
            "Model",
            "test-model",
            json!({"modelConfig": {"env": {"model": "openai", "model_id": "test"}}}),
        ));
        row.insert(0, ("anon_1_name", SqlValue::Text("test-model".into())));
        return (row.clone(), vec![row]);
    }
    assert!(
        sql.contains("'SkillBinding'")
            || sql.contains("'Skill'")
            || sql.contains("FROM `tasks`")
            || sql.contains("FROM subtasks")
            || sql.contains("FROM subtask_contexts"),
        "unexpected query: {sql}"
    );
    (vec![("id", SqlValue::I64(0))], vec![])
}

fn chat_agent() -> (KindRow, KindRow) {
    let team = stored_kind(1, 0, "Team", "analysis-agent", json!({}));
    let bot = stored_kind(
        2,
        0,
        "Bot",
        "analysis-bot",
        json!({
            "ghostRef": {"name": "analysis-ghost", "namespace": "default"},
            "modelRef": {"name": "test-model", "namespace": "default"},
        }),
    );
    (team, bot)
}

fn chat_input<'a>(team: &'a KindRow, bot: &'a KindRow) -> BuildExecutionRequestInput<'a> {
    BuildExecutionRequestInput {
        user_id: 7,
        user_name: "user",
        user_git_info: &Value::Null,
        user_preferences: None,
        task_id: 3,
        assistant_subtask_id: 5,
        user_subtask_id: 4,
        team,
        bot,
        bot_role: "leader",
        team_member_prompt: None,
        bot_ids: &[2],
        message: "Analyze the report",
        reasoning: None,
        enable_tools: false,
        enable_web_search: false,
        enable_deep_thinking: false,
        task_json: &Value::Null,
        request_id: "skill-test",
        message_id: 2,
        is_group_chat: false,
        task_project_id: 0,
        executor_name: "",
        executor_namespace: "",
        executor_deleted: false,
        new_session: false,
        knowledge_base_refs: &[],
        knowledge_base_names: &[],
        web_runtime_guidance: false,
        subtask_bot_resolved: true,
    }
}

#[tokio::test]
async fn chat_preserves_configured_skills_with_legacy_shell_metadata() {
    let (team, bot) = chat_agent();
    let input = chat_input(&team, &bot);
    for (automatic, preload) in [(false, true), (false, false), (true, true), (true, false)] {
        let fixture =
            MysqlRows::start_results(move |sql| skill_fixture(sql, automatic, preload)).await;
        let state = crate::app_test_support::app(fixture.mysql.clone());
        let request = build_chat_execution_request(&state, &input, &[], None, None, None)
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "automatic={automatic}, preload={preload}: {error:?}; queries: {:?}",
                    fixture.queries()
                )
            });

        assert_eq!(request.git_url.as_deref(), Some(""));
        assert_eq!(request.bot[0]["shell_type"], "Chat");
        assert_eq!(request.bot[0]["skills"], json!([ANALYSIS_SKILL]));
        assert_eq!(request.skill_names, vec![json!(ANALYSIS_SKILL)]);
        assert_eq!(
            request.skill_configs[0]["bindShells"],
            json!(["ClaudeCode"])
        );
        let skill_ref = &request.skill_refs[ANALYSIS_SKILL];
        assert_eq!(skill_ref["skill_id"], 11);
        assert_eq!(skill_ref["bind_shells"], json!(["ClaudeCode"]));
        assert_eq!(request.bot[0]["skill_refs"][ANALYSIS_SKILL], *skill_ref);
        if preload {
            assert_eq!(request.preload_skills, vec![json!(ANALYSIS_SKILL)]);
            assert_eq!(request.preload_skill_refs[ANALYSIS_SKILL], *skill_ref);
        } else {
            assert!(request.preload_skills.is_empty());
            assert!(request.preload_skill_refs.get(ANALYSIS_SKILL).is_none());
        }
    }
}

#[tokio::test]
async fn web_chat_dispatches_coordinate_workers_and_keeps_pipeline_on_its_current_bot() {
    let leader = stored_kind(
        2,
        0,
        "Bot",
        "leader",
        json!({
            "modelRef": {"name": "test-model", "namespace": "default"},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
        }),
    );
    let fixture = MysqlRows::start_results(coordinate_fixture).await;
    let state = crate::app_test_support::app(fixture.mysql.clone());

    for mode in ["coordinate", "pipeline", "solo"] {
        let team = stored_kind(
            1,
            0,
            "Team",
            "team",
            json!({
                "collaborationModel": mode,
                "members": [
                    {"botRef": {"name": "leader"}, "role": "leader"},
                    {"botRef": {"name": "writer", "namespace": "reviews"}, "role": "writer", "prompt": "Write the result."},
                    {"botRef": {"name": "reviewer"}, "role": "", "prompt": "Review the result."},
                ],
            }),
        );
        let mut input = chat_input(&team, &leader);
        input.bot_ids = &[2, 3, 4];
        let request = build_chat_execution_request(&state, &input, &[], None, None, None)
            .await
            .unwrap_or_else(|error| {
                panic!("mode={mode}: {error:?}; queries: {:?}", fixture.queries())
            });
        let configs = request.bot.as_array().expect("Bot configs");
        assert_eq!(configs[0]["id"], 2);
        assert_eq!(configs[0]["shell_type"], "ClaudeCode");
        if mode == "coordinate" {
            assert_eq!(configs.len(), 3);
            assert_eq!(configs[0]["skills"], json!([ANALYSIS_SKILL]));
            assert_eq!(configs[0]["skill_refs"][ANALYSIS_SKILL]["skill_id"], 11);
            assert!(
                configs[0]["mcp_servers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|server| { server["name"] == "worker-tool" && server["type"] == "http" })
            );
            let compiled: Vec<_> = configs
                .iter()
                .flat_map(|bot| bot["mcp_servers"].as_array().unwrap())
                .chain(&request.mcp_servers)
                .filter(|server| server["name"] == ANALYSIS_SKILL)
                .collect();
            assert_eq!(
                compiled,
                vec![&json!({
                    "name": ANALYSIS_SKILL,
                    "type": "http",
                    "url": "https://skill.invalid",
                    "headers": {"Authorization": "Bearer fixture"}
                })]
            );
            assert_eq!(configs[1]["id"], 3);
            assert_eq!(configs[1]["role"], "writer");
            assert_eq!(
                configs[1]["agent_config"]["env"]["model_id"],
                "writer-model"
            );
            assert!(
                configs[1]["system_prompt"]
                    .as_str()
                    .unwrap()
                    .contains("Write the result.")
            );
            assert_eq!(configs[2]["id"], 4);
            assert_eq!(configs[2]["role"], "worker");
            assert_eq!(
                configs[2]["agent_config"]["env"]["model_id"],
                "reviewer-model"
            );
            assert!(
                configs[2]["system_prompt"]
                    .as_str()
                    .unwrap()
                    .contains("Review the result.")
            );
        } else {
            assert_eq!(configs.len(), 1);
        }

        let cloud = super::super::dispatch::assemble(&request, false, true);
        let device = super::super::dispatch::device_execution_payload(&request, "app-record-42");
        assert_eq!(cloud.metadata["bot"], request.bot);
        assert_eq!(device["bot"], request.bot);
        assert_eq!(cloud.metadata["mode"], mode);
        assert_eq!(device["mode"], mode);
    }
}

fn coordinate_fixture(sql: &str) -> (Row, Vec<Row>) {
    if sql.contains("'Skill'") && sql.contains("kinds.id = ?") {
        return kind_result(stored_kind(
            11,
            0,
            "Skill",
            ANALYSIS_SKILL,
            json!({
                "mcpServers": {
                    (ANALYSIS_SKILL): {
                        "type": "streamable-http",
                        "url": "https://skill.invalid",
                        "headers": {"Authorization": "Bearer fixture"}
                    }
                }
            }),
        ));
    }
    if sql.contains("kinds.kind = 'Bot'") {
        let (id, name, namespace) = if sql.contains("kinds.namespace = ?") {
            (3, "writer", "reviews")
        } else {
            (4, "reviewer", "default")
        };
        let mut spec = json!({
            "agent_config": {"env": {"model": "claude", "model_id": format!("{name}-model"), "api_key": "test-key"}},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
        });
        if name == "writer" {
            spec["ghostRef"] = json!({"name": "writer-ghost", "namespace": "default"});
        } else {
            spec["capability_mode"] = json!("follow_device");
        }
        let mut bot = stored_kind(id, 0, "Bot", name, spec);
        bot.namespace = namespace.into();
        return kind_result(bot);
    }
    if sql.contains("kinds.kind = 'Shell'") {
        let (mut row, _) = kind_result(stored_kind(
            15,
            0,
            "Shell",
            "ClaudeCode",
            json!({"shellType": "ClaudeCode"}),
        ));
        row.splice(
            0..0,
            [
                ("requested_owner_id", SqlValue::I64(0)),
                ("requested_name", SqlValue::Text("ClaudeCode".into())),
                ("requested_namespace", SqlValue::Text("default".into())),
            ],
        );
        return (row.clone(), vec![row]);
    }
    if sql.contains("kinds.user_id = 0 AND kinds.kind = ?") {
        return kind_result(stored_kind(
            12,
            0,
            "Ghost",
            "writer-ghost",
            json!({
                "mcpServers": {
                    "worker-tool": {"type": "streamable-http", "url": "https://worker.invalid"},
                    (ANALYSIS_SKILL): {"type": "streamable-http", "url": "https://member.invalid"},
                },
                "skills": [ANALYSIS_SKILL],
                "skill_refs": {(ANALYSIS_SKILL): {"skill_id": 11, "namespace": "default", "is_public": true}},
            }),
        ));
    }
    if sql.contains("kinds.kind = 'Ghost'") {
        return (
            kind_result(stored_kind(12, 0, "Ghost", "unused", json!({}))).0,
            Vec::new(),
        );
    }
    if sql.contains("FROM tasks") && sql.contains("WHERE id = ? AND user_id = ?") {
        return (vec![("id", SqlValue::I64(0))], vec![]);
    }
    skill_fixture(sql, false, false)
}

#[tokio::test]
async fn coordinate_member_skills_resolve_in_the_team_owner_and_group_scope() {
    let fixture = MysqlRows::start_results(|sql| {
        if sql.contains("kinds.name = 'personal-tool'") {
            assert!(sql.contains("kinds.user_id = ?") && sql.contains("kinds.namespace = 'default'"));
            return kind_result(stored_kind(
                21,
                42,
                "Skill",
                "personal-tool",
                json!({"mcpServers": {"personal-tool": {"type": "http", "url": "https://personal.invalid"}}}),
            ));
        }
        assert!(sql.contains("kinds.name = 'group-tool'"), "{sql}");
        let mut skill = stored_kind(
            22,
            43,
            "Skill",
            "group-tool",
            json!({"mcpServers": {"group-tool": {"type": "http", "url": "https://group.invalid"}}}),
        );
        skill.namespace = "reviews".into();
        let (schema, rows) = kind_result(skill);
        if sql.contains("kinds.user_id = ?") {
            return (schema, vec![]);
        }
        assert!(sql.contains("kinds.namespace = 'reviews'"), "{sql}");
        (schema, rows)
    })
    .await;
    let cache = crate::task_skills::kinds::KindCacheStore::<_, brz_redis::RedisService> {
        mysql: &fixture.mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    let mut members = [json!({
        "skills": ["personal-tool", "group-tool"],
        "skill_refs": {"group-tool": {"namespace": "reviews"}}
    })];
    let mut skills = super::super::skills::BotSkills::default();
    let tokens = crate::user_mcp_oauth::token_service(7, &fixture.mysql);

    super::super::skills::extend_resolved_skills_from_bot_configs(
        &cache,
        &members,
        &mut skills,
        None,
        &tokens,
        42,
        "reviews",
    )
    .await
    .unwrap();
    super::super::skills::sync_bot_skill_refs(&mut members[0], &skills.skill_refs);

    assert_eq!(skills.skills[0]["skill_user_id"], 42);
    assert_eq!(skills.skills[1]["skill_user_id"], 43);
    assert_eq!(members[0]["skill_refs"]["personal-tool"]["skill_id"], 21);
    assert_eq!(members[0]["skill_refs"]["group-tool"]["skill_id"], 22);
    let mut servers = Vec::new();
    super::super::skills::append_coding_mcp(&mut servers, &skills, "ClaudeCode");
    assert_eq!(servers[0]["url"], "https://personal.invalid");
    assert_eq!(servers[1]["url"], "https://group.invalid");
}

#[tokio::test]
async fn first_git_chat_dispatch_uses_written_workspace_while_replica_is_missing_it() {
    use crate::task_creation::{WorkspaceRepository, build_workspace_payload};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use wegent_protocol::{OpenAIResponsesRequest, dispatch};

    let (team, bot) = chat_agent();
    let task_json =
        json!({"spec": {"workspaceRef": {"name": "workspace-3", "namespace": "default"}}});
    let mut input = chat_input(&team, &bot);
    input.task_json = &task_json;
    let repository = WorkspaceRepository {
        git_url: "https://git.example.com/team/demo.git",
        git_repo: "team/demo",
        git_repo_id: 12,
        git_domain: "git.example.com",
        branch_name: "develop",
    };
    let written = build_workspace_payload("workspace-3", "default", &repository);
    let replica_caught_up = Arc::new(AtomicBool::new(false));
    let workspace_row = vec![("json", SqlValue::Text(written.to_string()))];
    let replica = replica_caught_up.clone();
    let fixture = MysqlRows::start_results(move |sql| {
        if sql.contains("kind = 'Workspace'") {
            let rows = if replica.load(Ordering::Relaxed) {
                vec![workspace_row.clone()]
            } else {
                vec![]
            };
            return (workspace_row.clone(), rows);
        }
        skill_fixture(sql, false, false)
    })
    .await;
    let state = crate::app_test_support::app(fixture.mysql.clone());
    let first =
        build_chat_execution_request(&state, &input, &[], None, None, Some(&repository.to_json()))
            .await
            .expect("first turn uses the repository written with the task");
    assert!(
        !fixture
            .queries()
            .iter()
            .any(|sql| sql.contains("kind = 'Workspace'")),
        "first turn must not read its freshly written Workspace from the replica"
    );

    replica_caught_up.store(true, Ordering::Relaxed);
    input.assistant_subtask_id = 7;
    input.user_subtask_id = 6;
    input.message_id = 4;
    let followup = build_chat_execution_request(&state, &input, &[], None, None, None)
        .await
        .expect("follow-up reads the persisted repository");
    assert!(
        fixture
            .queries()
            .iter()
            .any(|sql| sql.contains("kind = 'Workspace'"))
    );
    for request in [first, followup] {
        assert_eq!(
            request.workspace["repository"],
            written["spec"]["repository"]
        );
        let wire = serde_json::to_value(dispatch::assemble(&request, false, true)).unwrap();
        let execution = OpenAIResponsesRequest::from_value(wire)
            .unwrap()
            .to_execution_request();
        assert_eq!(execution.task_id, "3");
        assert_eq!(execution.git_url().as_deref(), Some(repository.git_url));
        assert_eq!(execution.extra["branch_name"], repository.branch_name);
        assert!(!execution.skip_git_clone);
    }
}

#[tokio::test]
async fn a_new_git_chat_without_a_repository_url_fails_before_dispatch() {
    let (team, bot) = chat_agent();
    let input = chat_input(&team, &bot);
    let fixture = MysqlRows::start_results(|sql| skill_fixture(sql, false, false)).await;
    let state = crate::app_test_support::app(fixture.mysql.clone());
    let repository = json!({"gitRepo": "team/demo", "gitUrl": " "});
    let error = build_chat_execution_request(&state, &input, &[], None, None, Some(&repository))
        .await
        .expect_err("missing Git URL must fail");
    assert_eq!(error.status(), brz_http_server::StatusCode::BAD_REQUEST);
    assert_eq!(
        error.detail_message(),
        Some("Git workspace is missing a repository URL")
    );
}

/// `_get_model_config` (`request_builder.py:318`), `_get_bot_skills` (`:393`)
/// and only then `_build_bot_config` (`:415`), whose `_resolve_shell_info`
/// (`:2219`) is the Shell read. Both flat-config failures return before the
/// Shell call, so a failed flat config never issues a Shell query.
#[test]
fn the_flat_model_config_precedes_the_shell_read() {
    let source = include_str!("request.rs");
    let no_model = source
        .find("None => return Err(flat_model_config_error(None, &input.bot.name)),")
        .expect("bot-without-model raise");
    let unresolved = source
        .find("None => return Err(flat_model_config_error(Some(&model_name), &input.bot.name)),")
        .expect("model-not-found raise");
    let skills = source
        .find("let mut skills = get_bot_skills(")
        .expect("skill resolution");
    let shell = source
        .find("let (shell_type, base_image) = resolve_shell_type(state, input).await?;")
        .expect("shell resolution");
    assert!(
        no_model < unresolved && unresolved < skills && skills < shell,
        "both flat-model-config failures must return before Skill and Shell reads"
    );
}

/// Source `TaskRequestBuilder.build` resolves `_get_bot_for_subtask` once and
/// reuses that Bot row for the team-member lookup. The `/chat` trigger already
/// performs that read to resolve the member role/prompt, so it marks the input
/// resolved and the builder must not issue the identical second `kinds` read.
#[test]
fn a_resolved_subtask_bot_skips_the_builder_reread() {
    let source = include_str!("request.rs");
    let guard = source
        .find("let subtask_bot = if input.subtask_bot_resolved {")
        .expect("the resolved-bot guard");
    let read = source
        .find("super::subtask_bot::bot_by_id(&state.mysql, input.bot_ids.first().copied())")
        .expect("the bot-by-id read");
    assert!(
        guard < read,
        "the builder must skip its bot re-read when the caller resolved it"
    );
    let trigger = include_str!("../../socketio/chat_trigger.rs");
    assert!(
        trigger.contains("subtask_bot_resolved: true,"),
        "the /chat trigger reuses the Bot it resolved for the member lookup"
    );
    let other_callers = [
        include_str!("seam.rs"),
        include_str!("../../background_jobs/code_wiki_task.rs"),
        include_str!("../../background_jobs/subscription_execution.rs"),
        include_str!("../../background_jobs/project_managed.rs"),
        include_str!("../../internal_callback/pipeline.rs"),
    ];
    for caller in other_callers {
        assert!(
            caller.contains("subtask_bot_resolved: false,"),
            "non-/chat callers keep the builder's single _get_bot_for_subtask read"
        );
    }
}

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_deploys_standalone_task_skills_before_claude() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let home = unique_dir("claude-standalone-task-skill-home");
    let workspace_root = unique_dir("claude-standalone-task-skill-workspace");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let backend_url =
        serve_one_http_response(skill_zip_bytes("task-skill"), Arc::clone(&requests)).await;
    let fake_claude = write_fake_executable(
        "fake-claude-task-skill",
        r#"#!/bin/sh
global_config=false
task_skill=false
if [ "$CLAUDE_CONFIG_DIR" = "$HOME/.claude" ]; then global_config=true; fi
if [ -f "$SKILLS_DIR/task-skill/SKILL.md" ]; then task_skill=true; fi
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"global=%s skill=%s"}]}}\n' "$global_config" "$task_skill"
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _task_api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let mut request = ExecutionRequest {
        task_id: "86".to_owned(),
        backend_url: Some("http://payload-backend.invalid".to_owned()),
        auth_token: Some("task-token".to_owned()),
        prompt: json!("run with task skill"),
        bot: json!([{"id": 326, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([
            ("project_id".to_owned(), json!(0)),
            ("standalone_chat_workspace".to_owned(), json!(true)),
            ("skill_names".to_owned(), json!(["task-skill"])),
            (
                "skill_refs".to_owned(),
                json!({
                    "task-skill": {
                        "skill_id": 42,
                        "namespace": "default",
                        "is_public": false,
                    }
                }),
            ),
        ]),
        ..ExecutionRequest::default()
    };

    request.extra.insert("team_id".to_owned(), json!(0));
    let outcome = engine.run(with_backend_identity(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "global=true skill=true".to_owned()
        }
    );
    let request = requests.lock().unwrap().first().cloned().unwrap();
    assert!(
        request.starts_with(
            "GET /api/v1/kinds/skills/42/download?namespace=default&task_id=86 HTTP/1.1"
        ),
        "{request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer task-token"),
        "{request}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_deploys_bot_skills_for_regular_claude_tasks() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let home = unique_dir("claude-regular-bot-skill-home");
    let workspace_root = unique_dir("claude-regular-bot-skill-workspace");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let backend_url =
        serve_one_http_response(skill_zip_bytes("agent-skill"), Arc::clone(&requests)).await;
    let fake_claude = write_fake_executable(
        "fake-claude-regular-bot-skill",
        r#"#!/bin/sh
isolated_config=false
agent_skill=false
if [ "$CLAUDE_CONFIG_DIR" = "$WEGENT_WORKBENCH_HOME/agents/test-user/default/test-agent" ]; then isolated_config=true; fi
if [ -f "$SKILLS_DIR/agent-skill/SKILL.md" ]; then agent_skill=true; fi
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"isolated=%s skill=%s"}]}}\n' "$isolated_config" "$agent_skill"
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _task_api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "87".to_owned(),
        backend_url: Some("http://payload-backend.invalid".to_owned()),
        auth_token: Some("task-token".to_owned()),
        prompt: json!("run with bot skill"),
        bot: json!([{
            "id": 327,
            "shell_type": "ClaudeCode",
            "skills": ["agent-skill"],
            "skill_refs": {
                "agent-skill": {
                    "skill_id": 43,
                    "namespace": "default",
                    "is_public": false,
                }
            }
        }]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "isolated=true skill=true".to_owned()
        }
    );
    let request = requests.lock().unwrap().first().cloned().unwrap();
    assert!(
        request.starts_with(
            "GET /api/v1/kinds/skills/43/download?namespace=default&task_id=87 HTTP/1.1"
        ),
        "{request}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_isolates_bot_skills_for_regular_claude_tasks() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let home = unique_dir("claude-refresh-bot-skill-home");
    let workspace_root = unique_dir("claude-refresh-bot-skill-workspace");
    let existing_skill = home.join(".claude/skills/agent-skill");
    fs::create_dir_all(&existing_skill).unwrap();
    fs::write(existing_skill.join("SKILL.md"), "# Old Agent Skill\n").unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let backend_url =
        serve_one_http_response(skill_zip_bytes("agent-skill"), Arc::clone(&requests)).await;
    let fake_claude = write_fake_executable(
        "fake-claude-refresh-bot-skill",
        r#"#!/bin/sh
cat >/dev/null
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "local");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _task_api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "88".to_owned(),
        backend_url: Some(backend_url),
        auth_token: Some("task-token".to_owned()),
        prompt: json!("run with refreshed bot skill"),
        bot: json!([{
            "id": 328,
            "shell_type": "ClaudeCode",
            "skills": ["agent-skill"],
            "skill_refs": {
                "agent-skill": {
                    "skill_id": 44,
                    "namespace": "default",
                    "is_public": false,
                    "content_hash": format!("sha256:{:x}", <sha2::Sha256 as sha2::Digest>::digest(skill_zip_bytes("agent-skill"))),
                }
            }
        }]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
    assert_eq!(
        fs::read_to_string(existing_skill.join("SKILL.md")).unwrap(),
        "# Old Agent Skill\n"
    );
    assert_eq!(
        fs::read_to_string(fixture_agent_home().join("skills/agent-skill/SKILL.md")).unwrap(),
        "# Task Skill"
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_skips_claude_fallback_when_skill_hash_is_missing() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let home = unique_dir("claude-skip-fallback-no-hash-home");
    let workspace_root = unique_dir("claude-skip-fallback-no-hash-workspace");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let backend_url =
        serve_one_http_response(skill_zip_bytes("agent-skill"), Arc::clone(&requests)).await;
    let fake_claude = write_fake_executable(
        "fake-claude-skip-fallback-no-hash",
        r#"#!/bin/sh
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "local");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _task_api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "89".to_owned(),
        backend_url: Some(backend_url),
        auth_token: Some("task-token".to_owned()),
        prompt: json!("run with bot skill"),
        bot: json!([{
            "id": 329,
            "shell_type": "ClaudeCode",
            "skills": ["agent-skill"],
            "skill_refs": {
                "agent-skill": {
                    "skill_id": 44,
                    "namespace": "default",
                    "is_public": false
                }
            }
        }]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_restores_enabled_claude_plugin_zip_before_claude() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let home = unique_dir("claude-plugin-zip-home");
    let workspace_root = unique_dir("claude-plugin-zip-workspace");
    let claude_dir = home.join(".claude");
    let plugins_dir = claude_dir.join("plugins");
    let install_path = plugins_dir.join("cache/wegent/superpowers/5.0.7");
    fs::create_dir_all(plugins_dir.join("cache/claude-plugins-official")).unwrap();
    fs::write(
        claude_dir.join("settings.json"),
        json!({"enabledPlugins": {"superpowers@wegent": true}}).to_string(),
    )
    .unwrap();
    fs::write(
        plugins_dir.join("installed_plugins.json"),
        json!({
            "version": 2,
            "plugins": {
                "superpowers@wegent": [{
                    "installPath": install_path.display().to_string(),
                    "version": "5.0.7"
                }]
            }
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        plugins_dir.join("cache/claude-plugins-official/superpowers.zip"),
        plugin_zip_bytes("superpowers", "5.0.7", "systematic-debugging"),
    )
    .unwrap();
    let fake_claude = write_fake_executable(
        "fake-claude-plugin-zip",
        r#"#!/bin/sh
plugin_skill=false
if [ -f "$HOME/.claude/plugins/cache/wegent/superpowers/5.0.7/skills/systematic-debugging/SKILL.md" ]; then plugin_skill=true; fi
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"plugin=%s"}]}}\n' "$plugin_skill"
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let mut request = ExecutionRequest {
        task_id: "88".to_owned(),
        prompt: json!("run with global plugin skill"),
        bot: json!([{"id": 328, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    request.extra.insert("team_id".to_owned(), json!(0));
    let outcome = engine.run(with_backend_identity(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "plugin=true".to_owned()
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_runs_pre_execute_hook_before_claude() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let workspace_root = unique_dir("claude-hook-workspace-root");
    let marker_dir = unique_dir("claude-hook-marker");
    fs::create_dir_all(&marker_dir).unwrap();
    let marker = marker_dir.join("hook-ran");
    let hook_script = write_fake_executable(
        "pre-execute-hook",
        &format!(
            r#"#!/bin/sh
if [ ! -d "$WEGENT_TASK_DIR" ]; then exit 10; fi
if [ "$WEGENT_TASK_ID" != "83" ]; then exit 11; fi
if [ "$WEGENT_GIT_URL" != "https://github.com/wecode-ai/Wegent.git" ]; then exit 12; fi
printf hook > "{}"
exit 0
"#,
            marker.display()
        ),
    );
    let fake_claude = write_fake_executable(
        "fake-claude-hook",
        &format!(
            r#"#!/bin/sh
if [ ! -f "{}" ]; then exit 13; fi
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hook first"}}]}}}}'
"#,
            marker.display()
        ),
    );
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _hook = EnvGuard::set(
        "WEGENT_HOOK_PRE_EXECUTE",
        &hook_script.display().to_string(),
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "83".to_owned(),
        skip_git_clone: true,
        prompt: json!("run with hook"),
        bot: json!([{"id": 323, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([(
            "git_url".to_owned(),
            json!("https://github.com/wecode-ai/Wegent.git"),
        )]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "hook first".to_owned()
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_writes_file_edit_hooks_before_claude() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let home = unique_dir("claude-file-edit-hook-home");
    let workspace_root = unique_dir("claude-file-edit-hook-workspace-root");
    let hook_command = "curl -s -X POST http://127.0.0.1:3456/api/file-edit-log --data-binary @-";
    let fake_claude = write_fake_executable(
        "fake-claude-file-edit-hook",
        r#"#!/bin/sh
settings="$CLAUDE_CONFIG_DIR/settings.json"
python3 - "$settings" <<'PY'
import json
import sys

settings_path = sys.argv[1]
with open(settings_path, "r", encoding="utf-8") as handle:
    settings = json.load(handle)
hooks = settings.get("hooks", {})
pre = hooks.get("PreToolUse", [])
post = hooks.get("PostToolUse", [])
file_edit_groups = [
    group
    for group in pre + post
    if group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit"
]
commands = [
    hook.get("command")
    for group in file_edit_groups
    for hook in group.get("hooks", [])
]
payload = {
    "has_pre": any(group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit" for group in pre),
    "has_post": any(group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit" for group in post),
    "commands": commands,
    "matchers": [group.get("matcher") for group in file_edit_groups],
}
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": json.dumps(payload, sort_keys=True)}]}}))
PY
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _file_edit_hook = EnvGuard::set("WEGENT_FILE_EDIT_HOOK_COMMAND", hook_command);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "85".to_owned(),
        prompt: json!("inspect file edit hooks"),
        bot: json!([{"id": 325, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;
    let content = match outcome {
        ExecutionOutcome::Completed { content } => content,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let payload: serde_json::Value = serde_json::from_str(&content).unwrap();

    assert_eq!(payload["has_pre"], true);
    assert_eq!(payload["has_post"], true);
    assert!(payload["commands"]
        .as_array()
        .unwrap()
        .iter()
        .all(|command| command == hook_command));
    assert!(payload["matchers"]
        .as_array()
        .unwrap()
        .iter()
        .all(|matcher| matcher == "Write|Edit|MultiEdit|NotebookEdit"));
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_writes_default_claude_settings_before_claude() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let home = unique_dir("claude-default-settings-home");
    let workspace_root = unique_dir("claude-default-settings-workspace-root");
    let fake_claude = write_fake_executable(
        "fake-claude-default-settings",
        r#"#!/bin/sh
settings="$CLAUDE_CONFIG_DIR/settings.json"
python3 - "$settings" <<'PY'
import json
import os
import sys

settings_path = sys.argv[1]
with open(settings_path, "r", encoding="utf-8") as handle:
    settings = json.load(handle)
payload = {
    "includeCoAuthoredBy": settings.get("includeCoAuthoredBy"),
    "skipDangerousModePermissionPrompt": settings.get("skipDangerousModePermissionPrompt"),
    "env": settings.get("env", {}),
    "maxContextTokens": os.environ.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"),
}
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": json.dumps(payload, sort_keys=True)}]}}))
PY
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "86".to_owned(),
        prompt: json!("inspect default settings"),
        bot: json!([{"id": 326, "shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "anthropic",
            "model_id": "claude-sonnet-4",
            "context_window": 1_000_000
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;
    let content = match outcome {
        ExecutionOutcome::Completed { content } => content,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let payload: serde_json::Value = serde_json::from_str(&content).unwrap();

    assert_eq!(payload["includeCoAuthoredBy"], true);
    assert_eq!(payload["skipDangerousModePermissionPrompt"], false);
    assert_eq!(
        payload["env"]["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
        "0"
    );
    assert_eq!(payload["env"]["CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY"], "0");
    assert_eq!(
        payload["env"]["CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK"],
        "0"
    );
    assert_eq!(payload["env"]["ENABLE_TOOL_SEARCH"], "false");
    assert_eq!(payload["maxContextTokens"], "1000000");
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_uses_process_env_for_claude_settings_env() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let home = unique_dir("claude-settings-env-home");
    let workspace_root = unique_dir("claude-settings-env-workspace-root");
    let fake_claude = write_fake_executable(
        "fake-claude-settings-env",
        r#"#!/bin/sh
settings="$CLAUDE_CONFIG_DIR/settings.json"
python3 - "$settings" <<'PY'
import json
import os
import sys

settings_path = sys.argv[1]
with open(settings_path, "r", encoding="utf-8") as handle:
    settings = json.load(handle)
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": json.dumps(settings.get("env", {}), sort_keys=True)}]}}))
PY
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _disable_traffic = EnvGuard::set("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    let _disable_survey = EnvGuard::set("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "1");
    let _disable_fallback = EnvGuard::set("CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK", "1");
    let _tool_search = EnvGuard::set("ENABLE_TOOL_SEARCH", "false");
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "87".to_owned(),
        prompt: json!("inspect process env settings"),
        bot: json!([{"id": 327, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;
    let content = match outcome {
        ExecutionOutcome::Completed { content } => content,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let env: serde_json::Value = serde_json::from_str(&content).unwrap();

    assert_eq!(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1");
    assert_eq!(env["CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY"], "1");
    assert_eq!(env["CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK"], "1");
    assert_eq!(env["ENABLE_TOOL_SEARCH"], "false");
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_replaces_stale_file_edit_hooks_before_claude() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let workspace_root = unique_dir("claude-stale-file-edit-hook-workspace-root");
    let settings_path = fixture_agent_home().join("settings.json");
    fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    fs::write(
        &settings_path,
        r#"{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "tee -a /tmp/hook-debug.log | curl -sS -X POST http://127.0.0.1:3456/api/file-edit-log --data-binary @-"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "tee -a /tmp/hook-debug.log | curl -sS -X POST http://127.0.0.1:3456/api/file-edit-log --data-binary @-"
          }
        ]
      }
    ]
  }
}
"#,
    )
    .unwrap();
    let hook_command = "curl -s -X POST http://127.0.0.1:3456/api/file-edit-log --data-binary @-";
    let fake_claude = write_fake_executable(
        "fake-claude-stale-file-edit-hook",
        r#"#!/bin/sh
settings="$CLAUDE_CONFIG_DIR/settings.json"
python3 - "$settings" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    settings = json.load(handle)
hooks = settings.get("hooks", {})
pre = [
    group
    for group in hooks.get("PreToolUse", [])
    if group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit"
]
post = [
    group
    for group in hooks.get("PostToolUse", [])
    if group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit"
]
payload = {
    "pre_count": len(pre),
    "post_count": len(post),
    "commands": [
        hook.get("command")
        for group in pre + post
        for hook in group.get("hooks", [])
    ],
}
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": json.dumps(payload, sort_keys=True)}]}}))
PY
"#,
    );
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _file_edit_hook = EnvGuard::set("WEGENT_FILE_EDIT_HOOK_COMMAND", hook_command);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "86".to_owned(),
        prompt: json!("replace stale file edit hooks"),
        bot: json!([{"id": 326, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;
    let content = match outcome {
        ExecutionOutcome::Completed { content } => content,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let payload: serde_json::Value = serde_json::from_str(&content).unwrap();

    assert_eq!(payload["pre_count"], 1);
    assert_eq!(payload["post_count"], 1);
    assert!(payload["commands"]
        .as_array()
        .unwrap()
        .iter()
        .all(|command| command == hook_command));
}

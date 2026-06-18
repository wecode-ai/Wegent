from chat_shell.api.v1.response import _summarize_metadata_for_log


def test_metadata_log_summary_excludes_sensitive_values() -> None:
    metadata = {
        "task_id": 1,
        "subtask_id": 2,
        "request_id": "req-123",
        "user_id": 3,
        "user_name": "alice",
        "auth_token": "raw-auth-token",
        "skill_identity_token": "raw-skill-token",
        "user": {
            "git_token": "github_pat_SECRET",
            "sina_mail": {"token": "mail-secret"},
        },
        "skill_names": ["sandbox", "web-tools"],
        "skill_configs": [
            {"name": "sandbox", "mcpServers": {"sandbox": {}}},
            {"name": "web-tools", "mcpServers": {"web": {}}, "tools": [{}]},
        ],
        "preload_skills": ["sandbox"],
        "user_selected_skills": ["sandbox"],
        "knowledge_base_ids": [10, 11],
        "table_contexts": [{"table": "a"}],
        "task_data": {
            "user_mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {
                            "credentials": {
                                "url": "https://example.invalid/mcp?key=secret"
                            }
                        }
                    }
                }
            }
        },
    }

    summary = _summarize_metadata_for_log(metadata)

    assert summary == {
        "task_id": 1,
        "subtask_id": 2,
        "request_id": "req-123",
        "user_id": 3,
        "user_name": "alice",
        "team_id": None,
        "team_name": None,
        "bot_name": None,
        "message_id": None,
        "user_message_id": None,
        "user_subtask_id": None,
        "is_group_chat": None,
        "stateless": None,
        "enable_tools": None,
        "enable_web_search": None,
        "enable_deep_thinking": None,
        "skill_count": 2,
        "skill_names": ["sandbox", "web-tools"],
        "skill_config_count": 2,
        "skill_mcp_server_count": 2,
        "skill_declared_tool_count": 1,
        "preload_skills": ["sandbox"],
        "user_selected_skills": ["sandbox"],
        "knowledge_base_count": 2,
        "document_count": 0,
        "knowledge_base_scope_count": 0,
        "table_context_count": 1,
        "has_auth_token": True,
        "has_skill_identity_token": True,
        "has_task_data": True,
    }
    assert "raw-auth-token" not in str(summary)
    assert "github_pat_SECRET" not in str(summary)
    assert "secret" not in str(summary)

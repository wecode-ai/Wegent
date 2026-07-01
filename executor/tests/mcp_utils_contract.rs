// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::env;

use serde_json::{json, Value};
use wegent_executor::{
    mcp_utils::{
        extract_mcp_servers_config, get_nested_value, replace_mcp_server_variables,
        replace_placeholders_in_string, replace_variables_recursive,
    },
    protocol::ExecutionRequest,
};

fn request(value: Value) -> ExecutionRequest {
    serde_json::from_value(value).unwrap()
}

fn source(request: &ExecutionRequest) -> Value {
    request.variable_context()
}

struct EnvGuard {
    key: &'static str,
    old_value: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let old_value = env::var(key).ok();
        env::set_var(key, value);
        Self { key, old_value }
    }

    fn remove(key: &'static str) -> Self {
        let old_value = env::var(key).ok();
        env::remove_var(key);
        Self { key, old_value }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.old_value {
            env::set_var(self.key, value);
        } else {
            env::remove_var(self.key);
        }
    }
}

#[test]
fn nested_value_reads_top_level_request_fields() {
    let task = request(json!({"git_repo": "owner/repo", "branch_name": "main"}));
    let source = source(&task);

    assert_eq!(
        get_nested_value(Some(&source), "git_repo"),
        Some(&json!("owner/repo"))
    );
    assert_eq!(
        get_nested_value(Some(&source), "branch_name"),
        Some(&json!("main"))
    );
}

#[test]
fn nested_value_reads_nested_dict_keys() {
    let task = request(json!({"user": {"name": "John", "id": 123}}));
    let source = source(&task);

    assert_eq!(
        get_nested_value(Some(&source), "user.name"),
        Some(&json!("John"))
    );
    assert_eq!(
        get_nested_value(Some(&source), "user.id"),
        Some(&json!(123))
    );
}

#[test]
fn nested_value_reads_deeply_nested_dict_keys() {
    let task = request(json!({"user": {"profile": {"address": {"city": "Beijing"}}}}));
    let source = source(&task);

    assert_eq!(
        get_nested_value(Some(&source), "user.profile.address.city"),
        Some(&json!("Beijing"))
    );
}

#[test]
fn nested_value_returns_none_for_missing_paths() {
    let task = request(json!({"user": {"name": "John"}}));
    let source = source(&task);

    assert_eq!(get_nested_value(Some(&source), "user.email"), None);
    assert_eq!(get_nested_value(Some(&source), "nonexistent"), None);
    assert_eq!(get_nested_value(Some(&source), "user.address.city"), None);
}

#[test]
fn nested_value_returns_none_for_empty_path() {
    let task = request(json!({"git_repo": "owner/repo"}));
    let source = source(&task);

    assert_eq!(get_nested_value(Some(&source), ""), None);
}

#[test]
fn nested_value_returns_none_for_missing_source() {
    assert_eq!(get_nested_value(None, "any.path"), None);
}

#[test]
fn nested_value_reads_list_items_by_index() {
    let task = request(json!({"bot": [{"name": "bot1"}, {"name": "bot2"}]}));
    let source = source(&task);

    assert_eq!(
        get_nested_value(Some(&source), "bot.0.name"),
        Some(&json!("bot1"))
    );
    assert_eq!(
        get_nested_value(Some(&source), "bot.1.name"),
        Some(&json!("bot2"))
    );
}

#[test]
fn nested_value_rejects_out_of_range_or_negative_list_index() {
    let task = request(json!({"bot": [{"name": "bot1"}]}));
    let source = source(&task);

    assert_eq!(get_nested_value(Some(&source), "bot.5.name"), None);
    assert_eq!(get_nested_value(Some(&source), "bot.-1.name"), None);
}

#[test]
fn nested_value_rejects_non_numeric_list_index() {
    let task = request(json!({"bot": [{"name": "bot1"}]}));
    let source = source(&task);

    assert_eq!(get_nested_value(Some(&source), "bot.first.name"), None);
}

#[test]
fn nested_value_reads_deeply_nested_list_items() {
    let task = request(json!({"bot": [{"agent_config": {"env": {"api_key": "123"}}}]}));
    let source = source(&task);

    assert_eq!(
        get_nested_value(Some(&source), "bot.0.agent_config.env.api_key"),
        Some(&json!("123"))
    );
}

#[test]
fn placeholder_replaces_single_value() {
    let task = request(json!({"user": {"name": "John"}}));
    let source = source(&task);

    assert_eq!(
        replace_placeholders_in_string("Hello ${{user.name}}", Some(&source)),
        "Hello John"
    );
}

#[test]
fn placeholder_replaces_multiple_values() {
    let task = request(json!({"user": {"name": "John"}, "git_repo": "owner/repo"}));
    let source = source(&task);

    assert_eq!(
        replace_placeholders_in_string(
            "User ${{user.name}} working on ${{git_repo}}",
            Some(&source),
        ),
        "User John working on owner/repo"
    );
}

#[test]
fn placeholder_preserves_unknown_value() {
    let task = request(json!({"user": {"name": "John"}}));
    let source = source(&task);

    assert_eq!(
        replace_placeholders_in_string("Email: ${{user.email}}", Some(&source)),
        "Email: ${{user.email}}"
    );
}

#[test]
fn placeholder_mixes_replaced_and_unknown_values() {
    let task = request(json!({"user": {"name": "John"}}));
    let source = source(&task);

    assert_eq!(
        replace_placeholders_in_string(
            "Hello ${{user.name}}, email: ${{user.email}}",
            Some(&source),
        ),
        "Hello John, email: ${{user.email}}"
    );
}

#[test]
fn placeholder_leaves_plain_string_unchanged() {
    let task = request(json!({"user": {"name": "John"}}));
    let source = source(&task);

    assert_eq!(
        replace_placeholders_in_string("Hello World", Some(&source)),
        "Hello World"
    );
}

#[test]
fn placeholder_converts_numeric_values_to_strings() {
    let task = request(json!({"user": {"id": 12345}}));
    let source = source(&task);

    assert_eq!(
        replace_placeholders_in_string("User ID: ${{user.id}}", Some(&source)),
        "User ID: 12345"
    );
}

#[test]
fn placeholder_trims_spaces_around_path() {
    let task = request(json!({"user": {"name": "John"}}));
    let source = source(&task);

    assert_eq!(
        replace_placeholders_in_string("Hello ${{ user.name }}", Some(&source)),
        "Hello John"
    );
}

#[test]
fn recursive_replacement_handles_flat_dict() {
    let task = request(json!({"user": {"name": "John"}}));
    let source = source(&task);

    assert_eq!(
        replace_variables_recursive(&json!({"key": "${{user.name}}"}), Some(&source)),
        json!({"key": "John"})
    );
}

#[test]
fn recursive_replacement_handles_nested_dicts() {
    let task = request(json!({"user": {"name": "John", "token": "abc123"}}));
    let source = source(&task);

    let result = replace_variables_recursive(
        &json!({
            "server": {
                "url": "https://api.com/${{user.name}}",
                "headers": {"Authorization": "Bearer ${{user.token}}"}
            }
        }),
        Some(&source),
    );

    assert_eq!(result["server"]["url"], "https://api.com/John");
    assert_eq!(
        result["server"]["headers"]["Authorization"],
        "Bearer abc123"
    );
}

#[test]
fn recursive_replacement_handles_lists_inside_dicts() {
    let task = request(json!({"user": {"name": "John"}}));
    let source = source(&task);

    assert_eq!(
        replace_variables_recursive(
            &json!({"items": ["${{user.name}}", "static", "${{user.email}}"]}),
            Some(&source),
        ),
        json!({"items": ["John", "static", "${{user.email}}"]})
    );
}

#[test]
fn recursive_replacement_preserves_non_string_values() {
    let task = request(json!({"user": {"name": "John"}}));
    let source = source(&task);

    assert_eq!(
        replace_variables_recursive(
            &json!({"name": "${{user.name}}", "count": 42, "active": true, "data": null}),
            Some(&source),
        ),
        json!({"name": "John", "count": 42, "active": true, "data": null})
    );
}

#[test]
fn mcp_variables_replace_full_server_config() {
    let servers = json!({
        "server1": {
            "url": "https://api.example.com/${{user.git_login}}",
            "headers": {
                "Authorization": "Bearer ${{user.git_token}}",
                "X-User": "${{user.name}}"
            }
        }
    });
    let task = request(json!({
        "user": {"name": "Zhang San", "git_login": "zhangsan", "git_token": "token123"}
    }));

    let result = replace_mcp_server_variables(&servers, Some(&task));

    assert_eq!(result["server1"]["url"], "https://api.example.com/zhangsan");
    assert_eq!(
        result["server1"]["headers"]["Authorization"],
        "Bearer token123"
    );
    assert_eq!(result["server1"]["headers"]["X-User"], "Zhang San");
}

#[test]
fn mcp_variables_return_empty_servers_unchanged() {
    let task = request(json!({"user": {"name": "John"}}));

    assert_eq!(
        replace_mcp_server_variables(&json!({}), Some(&task)),
        json!({})
    );
}

#[test]
fn mcp_variables_preserve_placeholders_for_empty_request_data() {
    let task = ExecutionRequest::default();

    assert_eq!(
        replace_mcp_server_variables(&json!({"key": "${{user.name}}"}), Some(&task)),
        json!({"key": "${{user.name}}"})
    );
}

#[test]
fn mcp_variables_replace_backend_url_and_task_token_alias() {
    let servers = json!({
        "wegent-knowledge": {
            "type": "streamable-http",
            "url": "${{backend_url}}/mcp/knowledge/sse",
            "headers": {"Authorization": "Bearer ${{task_token}}"},
            "timeout": 300
        }
    });
    let task = request(json!({
        "backend_url": "http://localhost:8000",
        "auth_token": "test-token-"
    }));

    let result = replace_mcp_server_variables(&servers, Some(&task));

    assert_eq!(
        result["wegent-knowledge"]["url"],
        "http://localhost:8000/mcp/knowledge/sse"
    );
    assert_eq!(
        result["wegent-knowledge"]["headers"]["Authorization"],
        "Bearer test-token-"
    );
}

#[test]
fn mcp_variables_replace_empty_backend_url_from_task_api_domain() {
    let _mode = EnvGuard::remove("EXECUTOR_MODE");
    let _local_backend = EnvGuard::remove("WEGENT_BACKEND_URL");
    let _task_api = EnvGuard::set("TASK_API_DOMAIN", "http://backend:8000");
    let servers = json!({
        "wegent-knowledge": {
            "type": "streamable-http",
            "url": "${{backend_url}}/mcp/knowledge/sse",
            "headers": {"Authorization": "Bearer ${{task_token}}"},
            "timeout": 300
        }
    });
    let task = request(json!({
        "backend_url": "",
        "auth_token": "test-token"
    }));

    let result = replace_mcp_server_variables(&servers, Some(&task));

    assert_eq!(
        result["wegent-knowledge"]["url"],
        "http://backend:8000/mcp/knowledge/sse"
    );
    assert_eq!(
        result["wegent-knowledge"]["headers"]["Authorization"],
        "Bearer test-token"
    );
}

#[test]
fn mcp_variables_preserve_null_values_as_unknown_placeholders() {
    let servers = json!({"key": "${{user.name}}"});
    let task = request(json!({"user": {"name": null}}));

    assert_eq!(
        replace_mcp_server_variables(&servers, Some(&task)),
        json!({"key": "${{user.name}}"})
    );
}

#[test]
fn mcp_variables_return_config_unchanged_without_request_data() {
    assert_eq!(
        replace_mcp_server_variables(&json!({"key": "${{user.name}}"}), None),
        json!({"key": "${{user.name}}"})
    );
}

#[test]
fn mcp_variables_replace_top_level_request_fields() {
    let servers = json!({
        "repo": "${{git_repo}}",
        "branch": "${{branch_name}}",
        "url": "${{git_url}}"
    });
    let task = request(json!({
        "git_repo": "owner/myrepo",
        "branch_name": "develop",
        "git_url": "https://github.com/owner/myrepo.git"
    }));

    let result = replace_mcp_server_variables(&servers, Some(&task));

    assert_eq!(result["repo"], "owner/myrepo");
    assert_eq!(result["branch"], "develop");
    assert_eq!(result["url"], "https://github.com/owner/myrepo.git");
}

#[test]
fn mcp_variables_replace_real_world_gitlab_config() {
    let servers = json!({
        "gitlab": {
            "command": "npx",
            "args": [
                "-y",
                "@anthropics/mcp-gitlab",
                "--gitlab-url",
                "https://${{git_domain}}",
                "--token",
                "${{user.git_token}}",
                "--project",
                "${{git_repo}}"
            ],
            "env": {
                "GITLAB_TOKEN": "${{user.git_token}}",
                "GITLAB_URL": "https://${{git_domain}}"
            }
        }
    });
    let task = request(json!({
        "git_domain": "gitlab.example.com",
        "git_repo": "group/project",
        "user": {"git_token": "glpat-xxxxxxxxxxxx"}
    }));

    let result = replace_mcp_server_variables(&servers, Some(&task));

    assert_eq!(result["gitlab"]["args"][3], "https://gitlab.example.com");
    assert_eq!(result["gitlab"]["args"][5], "glpat-xxxxxxxxxxxx");
    assert_eq!(result["gitlab"]["args"][7], "group/project");
    assert_eq!(
        result["gitlab"]["env"]["GITLAB_TOKEN"],
        "glpat-xxxxxxxxxxxx"
    );
    assert_eq!(
        result["gitlab"]["env"]["GITLAB_URL"],
        "https://gitlab.example.com"
    );
}

#[test]
fn mcp_variables_preserve_original_on_no_match() {
    let servers = json!({
        "server": {
            "url": "${{nonexistent.path}}",
            "static": "no_placeholder"
        }
    });
    let task = request(json!({"user": {"name": "John"}}));

    let result = replace_mcp_server_variables(&servers, Some(&task));

    assert_eq!(result["server"]["url"], "${{nonexistent.path}}");
    assert_eq!(result["server"]["static"], "no_placeholder");
}

#[test]
fn mcp_variables_replace_bot_array_values() {
    let servers = json!({
        "server": {
            "bot_name": "${{bot.0.name}}",
            "shell_type": "${{bot.0.shell_type}}",
            "api_key": "${{bot.0.agent_config.env.api_key}}"
        }
    });
    let task = request(json!({
        "bot": [{
            "id": 1,
            "name": "my-claude-bot",
            "shell_type": "claudecode",
            "agent_config": {"env": {"api_key": "sk-xxx-123"}},
            "system_prompt": "You are helpful"
        }]
    }));

    let result = replace_mcp_server_variables(&servers, Some(&task));

    assert_eq!(result["server"]["bot_name"], "my-claude-bot");
    assert_eq!(result["server"]["shell_type"], "claudecode");
    assert_eq!(result["server"]["api_key"], "sk-xxx-123");
}

#[test]
fn mcp_variables_replace_multiple_bot_values() {
    let servers = json!({
        "primary": "${{bot.0.name}}",
        "secondary": "${{bot.1.name}}"
    });
    let task = request(json!({
        "bot": [{"name": "primary-bot"}, {"name": "secondary-bot"}]
    }));

    let result = replace_mcp_server_variables(&servers, Some(&task));

    assert_eq!(result["primary"], "primary-bot");
    assert_eq!(result["secondary"], "secondary-bot");
}

#[test]
fn extract_mcp_servers_prefers_double_nested_camel_case() {
    let config = json!({
        "mcpServers": {
            "mcpServers": {"docs": {"url": "https://camel.example.com"}},
            "mcp_servers": {"docs": {"url": "https://snake.example.com"}}
        }
    });

    assert_eq!(
        extract_mcp_servers_config(&config),
        Some(&json!({"docs": {"url": "https://camel.example.com"}}))
    );
}

#[test]
fn extract_mcp_servers_supports_single_nested_snake_case() {
    let config = json!({
        "mcp_servers": {"docs": {"url": "https://docs.example.com"}}
    });

    assert_eq!(
        extract_mcp_servers_config(&config),
        Some(&json!({"docs": {"url": "https://docs.example.com"}}))
    );
}

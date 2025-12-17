#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Unit tests for executor/utils/mcp_utils.py
"""

import pytest
from executor.utils.mcp_utils import (
    _get_nested_value,
    _replace_placeholders_in_string,
    _replace_variables_recursive,
    extract_mcp_servers_config,
    replace_mcp_server_variables,
)


class TestGetNestedValue:
    """Tests for _get_nested_value function"""

    def test_simple_key(self):
        """Test getting a simple top-level key"""
        data = {"git_repo": "owner/repo", "branch_name": "main"}
        assert _get_nested_value(data, "git_repo") == "owner/repo"
        assert _get_nested_value(data, "branch_name") == "main"

    def test_nested_key(self):
        """Test getting nested keys with dot notation"""
        data = {"user": {"name": "John", "id": 123}}
        assert _get_nested_value(data, "user.name") == "John"
        assert _get_nested_value(data, "user.id") == 123

    def test_deeply_nested_key(self):
        """Test getting deeply nested keys"""
        data = {"level1": {"level2": {"level3": {"value": "deep"}}}}
        assert _get_nested_value(data, "level1.level2.level3.value") == "deep"

    def test_nonexistent_key(self):
        """Test that nonexistent keys return None"""
        data = {"user": {"name": "John"}}
        assert _get_nested_value(data, "user.email") is None
        assert _get_nested_value(data, "nonexistent") is None
        assert _get_nested_value(data, "user.address.city") is None

    def test_empty_data(self):
        """Test with empty data dictionary"""
        assert _get_nested_value({}, "any.path") is None

    def test_empty_path(self):
        """Test with empty path string"""
        data = {"key": "value"}
        assert _get_nested_value(data, "") is None

    def test_none_data(self):
        """Test with None data"""
        assert _get_nested_value(None, "any.path") is None

    def test_non_dict_intermediate(self):
        """Test when intermediate value is not a dict"""
        data = {"user": "string_value"}
        assert _get_nested_value(data, "user.name") is None

    def test_list_index_access(self):
        """Test accessing list elements by index"""
        data = {"bot": [{"name": "bot1"}, {"name": "bot2"}]}
        assert _get_nested_value(data, "bot.0.name") == "bot1"
        assert _get_nested_value(data, "bot.1.name") == "bot2"

    def test_list_index_out_of_range(self):
        """Test that out of range index returns None"""
        data = {"bot": [{"name": "bot1"}]}
        assert _get_nested_value(data, "bot.5.name") is None
        assert _get_nested_value(data, "bot.-1.name") is None

    def test_list_invalid_index(self):
        """Test that non-numeric index on list returns None"""
        data = {"bot": [{"name": "bot1"}]}
        assert _get_nested_value(data, "bot.first.name") is None

    def test_deeply_nested_with_list(self):
        """Test deeply nested path with list access"""
        data = {"bot": [{"agent_config": {"env": {"api_key": "secret123"}}}]}
        assert _get_nested_value(data, "bot.0.agent_config.env.api_key") == "secret123"


class TestReplacePlaceholdersInString:
    """Tests for _replace_placeholders_in_string function"""

    def test_single_placeholder(self):
        """Test replacing a single placeholder"""
        task_data = {"user": {"name": "John"}}
        text = "Hello ${{user.name}}"
        result = _replace_placeholders_in_string(text, task_data)
        assert result == "Hello John"

    def test_multiple_placeholders(self):
        """Test replacing multiple placeholders in one string"""
        task_data = {"user": {"name": "John"}, "git_repo": "owner/repo"}
        text = "User ${{user.name}} working on ${{git_repo}}"
        result = _replace_placeholders_in_string(text, task_data)
        assert result == "User John working on owner/repo"

    def test_placeholder_not_found(self):
        """Test that unknown placeholders are preserved"""
        task_data = {"user": {"name": "John"}}
        text = "Email: ${{user.email}}"
        result = _replace_placeholders_in_string(text, task_data)
        assert result == "Email: ${{user.email}}"

    def test_mixed_found_and_not_found(self):
        """Test with some placeholders found and some not"""
        task_data = {"user": {"name": "John"}}
        text = "Hello ${{user.name}}, email: ${{user.email}}"
        result = _replace_placeholders_in_string(text, task_data)
        assert result == "Hello John, email: ${{user.email}}"

    def test_no_placeholder(self):
        """Test string without any placeholders"""
        task_data = {"user": {"name": "John"}}
        text = "Hello World"
        result = _replace_placeholders_in_string(text, task_data)
        assert result == "Hello World"

    def test_numeric_value(self):
        """Test that numeric values are converted to string"""
        task_data = {"user": {"id": 12345}}
        text = "User ID: ${{user.id}}"
        result = _replace_placeholders_in_string(text, task_data)
        assert result == "User ID: 12345"

    def test_placeholder_with_spaces(self):
        """Test placeholder with spaces around path"""
        task_data = {"user": {"name": "John"}}
        text = "Hello ${{ user.name }}"
        result = _replace_placeholders_in_string(text, task_data)
        assert result == "Hello John"


class TestReplaceVariablesRecursive:
    """Tests for _replace_variables_recursive function"""

    def test_simple_dict(self):
        """Test with a simple flat dictionary"""
        task_data = {"user": {"name": "John"}}
        obj = {"key": "${{user.name}}"}
        result = _replace_variables_recursive(obj, task_data)
        assert result == {"key": "John"}

    def test_nested_dict(self):
        """Test with nested dictionaries"""
        task_data = {"user": {"name": "John", "token": "abc123"}}
        obj = {
            "server": {
                "url": "https://api.com/${{user.name}}",
                "headers": {"Authorization": "Bearer ${{user.token}}"},
            }
        }
        result = _replace_variables_recursive(obj, task_data)
        assert result["server"]["url"] == "https://api.com/John"
        assert result["server"]["headers"]["Authorization"] == "Bearer abc123"

    def test_list_in_dict(self):
        """Test with lists containing placeholders"""
        task_data = {"user": {"name": "John"}}
        obj = {"items": ["${{user.name}}", "static", "${{user.email}}"]}
        result = _replace_variables_recursive(obj, task_data)
        assert result["items"] == ["John", "static", "${{user.email}}"]

    def test_non_string_values(self):
        """Test that non-string values are preserved"""
        task_data = {"user": {"name": "John"}}
        obj = {"name": "${{user.name}}", "count": 42, "active": True, "data": None}
        result = _replace_variables_recursive(obj, task_data)
        assert result["name"] == "John"
        assert result["count"] == 42
        assert result["active"] is True
        assert result["data"] is None


class TestReplaceMcpServerVariables:
    """Tests for replace_mcp_server_variables function"""

    def test_full_example(self):
        """Test complete MCP servers configuration replacement"""
        mcp_servers = {
            "server1": {
                "url": "https://api.example.com/${{user.git_login}}",
                "headers": {
                    "Authorization": "Bearer ${{user.git_token}}",
                    "X-User": "${{user.name}}",
                },
            }
        }
        task_data = {
            "user": {"name": "张三", "git_login": "zhangsan", "git_token": "token123"}
        }
        result = replace_mcp_server_variables(mcp_servers, task_data)
        assert result["server1"]["url"] == "https://api.example.com/zhangsan"
        assert result["server1"]["headers"]["Authorization"] == "Bearer token123"
        assert result["server1"]["headers"]["X-User"] == "张三"

    def test_empty_mcp_servers(self):
        """Test with empty mcp_servers"""
        task_data = {"user": {"name": "John"}}
        result = replace_mcp_server_variables({}, task_data)
        assert result == {}

    def test_empty_task_data(self):
        """Test with empty task_data - should return unchanged"""
        mcp_servers = {"key": "${{user.name}}"}
        result = replace_mcp_server_variables(mcp_servers, {})
        assert result == {"key": "${{user.name}}"}

    def test_none_task_data(self):
        """Test with None task_data - should return unchanged"""
        mcp_servers = {"key": "${{user.name}}"}
        result = replace_mcp_server_variables(mcp_servers, None)
        assert result == {"key": "${{user.name}}"}

    def test_top_level_placeholders(self):
        """Test with top-level task_data keys"""
        mcp_servers = {
            "repo": "${{git_repo}}",
            "branch": "${{branch_name}}",
            "url": "${{git_url}}",
        }
        task_data = {
            "git_repo": "owner/myrepo",
            "branch_name": "develop",
            "git_url": "https://github.com/owner/myrepo.git",
        }
        result = replace_mcp_server_variables(mcp_servers, task_data)
        assert result["repo"] == "owner/myrepo"
        assert result["branch"] == "develop"
        assert result["url"] == "https://github.com/owner/myrepo.git"

    def test_complex_real_world_config(self):
        """Test with a realistic MCP server configuration"""
        mcp_servers = {
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
                    "${{git_repo}}",
                ],
                "env": {
                    "GITLAB_TOKEN": "${{user.git_token}}",
                    "GITLAB_URL": "https://${{git_domain}}",
                },
            }
        }
        task_data = {
            "git_domain": "gitlab.example.com",
            "git_repo": "group/project",
            "user": {"git_token": "glpat-xxxxxxxxxxxx"},
        }
        result = replace_mcp_server_variables(mcp_servers, task_data)

        assert result["gitlab"]["args"][3] == "https://gitlab.example.com"
        assert result["gitlab"]["args"][5] == "glpat-xxxxxxxxxxxx"
        assert result["gitlab"]["args"][7] == "group/project"
        assert result["gitlab"]["env"]["GITLAB_TOKEN"] == "glpat-xxxxxxxxxxxx"
        assert result["gitlab"]["env"]["GITLAB_URL"] == "https://gitlab.example.com"

    def test_preserves_original_on_no_match(self):
        """Test that original dict is preserved when no placeholders match"""
        mcp_servers = {
            "server": {
                "url": "${{nonexistent.path}}",
                "static": "no_placeholder",
            }
        }
        task_data = {"user": {"name": "John"}}
        result = replace_mcp_server_variables(mcp_servers, task_data)
        assert result["server"]["url"] == "${{nonexistent.path}}"
        assert result["server"]["static"] == "no_placeholder"

    def test_bot_array_access(self):
        """Test accessing bot array elements from task_data"""
        mcp_servers = {
            "server": {
                "bot_name": "${{bot.0.name}}",
                "shell_type": "${{bot.0.shell_type}}",
                "api_key": "${{bot.0.agent_config.env.api_key}}",
            }
        }
        task_data = {
            "bot": [
                {
                    "id": 1,
                    "name": "my-claude-bot",
                    "shell_type": "claudecode",
                    "agent_config": {"env": {"api_key": "sk-xxx-123"}},
                    "system_prompt": "You are helpful",
                }
            ]
        }
        result = replace_mcp_server_variables(mcp_servers, task_data)
        assert result["server"]["bot_name"] == "my-claude-bot"
        assert result["server"]["shell_type"] == "claudecode"
        assert result["server"]["api_key"] == "sk-xxx-123"

    def test_multiple_bot_access(self):
        """Test accessing multiple bots from array"""
        mcp_servers = {
            "primary": "${{bot.0.name}}",
            "secondary": "${{bot.1.name}}",
        }
        task_data = {
            "bot": [
                {"name": "primary-bot"},
                {"name": "secondary-bot"},
            ]
        }
        result = replace_mcp_server_variables(mcp_servers, task_data)
        assert result["primary"] == "primary-bot"
        assert result["secondary"] == "secondary-bot"

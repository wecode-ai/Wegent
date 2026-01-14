#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Unit tests for Weibo skill MCP variable substitution.
Tests specific to Weibo API token and configuration patterns.
"""

import pytest

from shared.utils.mcp_utils import replace_mcp_server_variables


class TestWeiboMcpVariableSubstitution:
    """Tests for Weibo-specific MCP configuration variable substitution"""

    def test_weibo_token_substitution(self):
        """Test Weibo API token substitution in headers"""
        mcp_servers = {
            "weiboServer": {
                "type": "streamable-http",
                "transport": "streamable_http",
                "url": "https://weibo-api.example.com/mcp",
                "headers": {
                    "Authorization": "Bearer ${{user.weibo_token}}",
                    "X-User-ID": "${{user.id}}",
                },
            }
        }
        task_data = {
            "user": {
                "id": 12345,
                "name": "张三",
                "weibo_token": "secret_abc123xyz456",
            }
        }

        result = replace_mcp_server_variables(mcp_servers, task_data)

        assert (
            result["weiboServer"]["headers"]["Authorization"]
            == "Bearer secret_abc123xyz456"
        )
        assert result["weiboServer"]["headers"]["X-User-ID"] == "12345"

    def test_weibo_multiple_variables(self):
        """Test multiple variable substitutions in Weibo config"""
        mcp_servers = {
            "weiboServer": {
                "url": "https://${{weibo_domain}}/api/v1/mcp",
                "headers": {
                    "Authorization": "Bearer ${{user.weibo_token}}",
                    "X-User-ID": "${{user.id}}",
                    "X-User-Name": "${{user.name}}",
                    "X-Workspace": "${{workspace.repo_name}}",
                },
            }
        }
        task_data = {
            "weibo_domain": "weibo-api.example.com",
            "user": {
                "id": 67890,
                "name": "analyst_user",
                "weibo_token": "ZINFOID_01Q_token789",
            },
            "workspace": {"repo_name": "data-analysis-project"},
        }

        result = replace_mcp_server_variables(mcp_servers, task_data)

        assert (
            result["weiboServer"]["url"] == "https://weibo-api.example.com/api/v1/mcp"
        )
        assert (
            result["weiboServer"]["headers"]["Authorization"]
            == "Bearer ZINFOID_01Q_token789"
        )
        assert result["weiboServer"]["headers"]["X-User-ID"] == "67890"
        assert result["weiboServer"]["headers"]["X-User-Name"] == "analyst_user"
        assert (
            result["weiboServer"]["headers"]["X-Workspace"] == "data-analysis-project"
        )

    def test_weibo_missing_token_preserves_placeholder(self):
        """Test that missing weibo_token preserves the placeholder"""
        mcp_servers = {
            "weiboServer": {
                "headers": {
                    "Authorization": "Bearer ${{user.weibo_token}}",
                }
            }
        }
        task_data = {"user": {"id": 123, "name": "user"}}  # No weibo_token

        result = replace_mcp_server_variables(mcp_servers, task_data)

        # Should preserve placeholder when variable not found
        assert (
            result["weiboServer"]["headers"]["Authorization"]
            == "Bearer ${{user.weibo_token}}"
        )

    def test_weibo_env_variable_substitution(self):
        """Test Weibo token in environment variables"""
        mcp_servers = {
            "weiboServer": {
                "command": "python",
                "args": ["-m", "weibo_mcp_server"],
                "env": {
                    "WEIBO_TOKEN": "${{user.weibo_token}}",
                    "WEIBO_USER_ID": "${{user.id}}",
                    "WEIBO_API_URL": "https://${{weibo_domain}}",
                },
            }
        }
        task_data = {
            "weibo_domain": "api.weibo.com",
            "user": {
                "id": 999,
                "weibo_token": "ZINFOID_02Q_envtoken",
            },
        }

        result = replace_mcp_server_variables(mcp_servers, task_data)

        assert result["weiboServer"]["env"]["WEIBO_TOKEN"] == "ZINFOID_02Q_envtoken"
        assert result["weiboServer"]["env"]["WEIBO_USER_ID"] == "999"
        assert result["weiboServer"]["env"]["WEIBO_API_URL"] == "https://api.weibo.com"

    def test_weibo_with_git_integration(self):
        """Test Weibo config with Git workspace variables"""
        mcp_servers = {
            "weiboServer": {
                "url": "https://weibo-api.example.com",
                "headers": {
                    "Authorization": "Bearer ${{user.weibo_token}}",
                    "X-Git-Repo": "${{git_repo}}",
                    "X-Git-User": "${{user.git_login}}",
                },
            }
        }
        task_data = {
            "git_repo": "wecode-ai/Wegent",
            "user": {
                "weibo_token": "ZINFOID_03Q_gitintegration",
                "git_login": "developer123",
            },
        }

        result = replace_mcp_server_variables(mcp_servers, task_data)

        assert (
            result["weiboServer"]["headers"]["Authorization"]
            == "Bearer ZINFOID_03Q_gitintegration"
        )
        assert result["weiboServer"]["headers"]["X-Git-Repo"] == "wecode-ai/Wegent"
        assert result["weiboServer"]["headers"]["X-Git-User"] == "developer123"

    def test_weibo_complex_nested_config(self):
        """Test deeply nested Weibo configuration"""
        mcp_servers = {
            "weiboServer": {
                "type": "streamable-http",
                "config": {
                    "auth": {
                        "type": "bearer",
                        "token": "${{user.weibo_token}}",
                    },
                    "endpoints": {
                        "base": "https://${{weibo_domain}}",
                        "user": "${{user.id}}",
                    },
                    "metadata": {
                        "project": "${{workspace.name}}",
                        "branch": "${{branch_name}}",
                    },
                },
            }
        }
        task_data = {
            "weibo_domain": "api.weibo.com",
            "branch_name": "feature/weibo-analysis",
            "user": {
                "id": 555,
                "weibo_token": "ZINFOID_04Q_nested",
            },
            "workspace": {"name": "social-media-analytics"},
        }

        result = replace_mcp_server_variables(mcp_servers, task_data)

        assert result["weiboServer"]["config"]["auth"]["token"] == "ZINFOID_04Q_nested"
        assert (
            result["weiboServer"]["config"]["endpoints"]["base"]
            == "https://api.weibo.com"
        )
        assert result["weiboServer"]["config"]["endpoints"]["user"] == "555"
        assert (
            result["weiboServer"]["config"]["metadata"]["project"]
            == "social-media-analytics"
        )
        assert (
            result["weiboServer"]["config"]["metadata"]["branch"]
            == "feature/weibo-analysis"
        )

    def test_weibo_with_chinese_characters(self):
        """Test Weibo config with Chinese character values"""
        mcp_servers = {
            "weiboServer": {
                "headers": {
                    "X-User-Name": "${{user.name}}",
                    "X-Project-Name": "${{workspace.display_name}}",
                }
            }
        }
        task_data = {
            "user": {"name": "微博分析师"},
            "workspace": {"display_name": "社交媒体数据分析项目"},
        }

        result = replace_mcp_server_variables(mcp_servers, task_data)

        assert result["weiboServer"]["headers"]["X-User-Name"] == "微博分析师"
        assert (
            result["weiboServer"]["headers"]["X-Project-Name"] == "社交媒体数据分析项目"
        )

    def test_weibo_empty_config_returns_empty(self):
        """Test empty Weibo MCP config returns empty"""
        result = replace_mcp_server_variables({}, {"user": {"weibo_token": "token"}})
        assert result == {}

    def test_weibo_none_config_returns_none(self):
        """Test None Weibo MCP config returns None"""
        result = replace_mcp_server_variables(None, {"user": {"weibo_token": "token"}})
        assert result is None

    def test_weibo_url_path_substitution(self):
        """Test URL path variable substitution for Weibo"""
        mcp_servers = {
            "weiboServer": {
                "url": "https://weibo-api.example.com/v1/users/${{user.id}}/timeline",
                "headers": {"Authorization": "Bearer ${{user.weibo_token}}"},
            }
        }
        task_data = {
            "user": {
                "id": 12345678,
                "weibo_token": "ZINFOID_05Q_urlpath",
            }
        }

        result = replace_mcp_server_variables(mcp_servers, task_data)

        assert (
            result["weiboServer"]["url"]
            == "https://weibo-api.example.com/v1/users/12345678/timeline"
        )
        assert (
            result["weiboServer"]["headers"]["Authorization"]
            == "Bearer ZINFOID_05Q_urlpath"
        )

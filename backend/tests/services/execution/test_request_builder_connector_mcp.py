# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connector apps reach the Chat shell through the backend MCP endpoint."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_connections import connector_connection_service
from app.services.execution.request_builder import TaskRequestBuilder


def _create_app(
    db: Session,
    admin: User,
    *,
    slug: str,
    auth_type: str = "oauth2",
    tool_loading_mode: str = "static",
    keywords: list[str] | None = None,
):
    return connector_app_service.create_app(
        db,
        ConnectorAppWrite(
            slug=slug,
            name=slug,
            transport="streamable-http",
            mcp_url=f"https://mcp.example.test/{slug}",
            auth_type=auth_type,
            tool_loading_mode=tool_loading_mode,
            keywords=keywords or [],
        ),
        admin,
    )


def test_unauthorized_apps_are_not_exposed(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(test_db, test_admin_user, slug="pending-app")
    builder = TaskRequestBuilder(test_db)

    assert builder._user_has_callable_connectors(test_user) is False


def test_authorized_apps_are_exposed(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(test_db, test_admin_user, slug="connected-app")
    connector_connection_service.save_oauth_connection(
        test_db,
        slug="connected-app",
        user_id=test_user.id,
        access_token="token",
        refresh_token=None,
        token_type="bearer",
        granted_scopes=[],
        external_account_name=None,
        expires_at=None,
    )
    builder = TaskRequestBuilder(test_db)

    assert builder._user_has_callable_connectors(test_user) is True


def test_no_auth_apps_are_always_exposed(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(test_db, test_admin_user, slug="public-app", auth_type="none")
    builder = TaskRequestBuilder(test_db)

    assert builder._user_has_callable_connectors(test_user) is True


def test_lazy_mode_apps_are_not_statically_loaded(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(
        test_db,
        test_admin_user,
        slug="lazy-app",
        auth_type="none",
        tool_loading_mode="lazy",
    )
    builder = TaskRequestBuilder(test_db)

    assert builder._user_has_callable_connectors(test_user) is False


def test_lazy_mode_apps_build_scoped_skill_configs(
    test_db: Session, test_admin_user: User, test_user: User, monkeypatch
) -> None:
    _create_app(
        test_db,
        test_admin_user,
        slug="lazy-app",
        auth_type="none",
        tool_loading_mode="lazy",
    )
    builder = TaskRequestBuilder(test_db)
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_bot_uses_chat_shell",
        staticmethod(lambda bot, user_id: True),
    )

    configs, preload, matched_slugs = builder._connector_skill_configs(
        bot=SimpleNamespace(), user=test_user, auth_token="task-token"
    )

    assert len(configs) == 1
    assert preload == []
    assert matched_slugs == []
    config = configs[0]
    assert config["name"] == "wegent-connector-lazy-app"
    assert "mcpServers" in config
    server = config["mcpServers"]["wegent-connector-lazy-app"]
    assert server["url"].endswith("/mcp/connectors/sse")
    assert server["headers"] == {
        "Authorization": "Bearer task-token",
        "X-Connector-App": "lazy-app",
    }


def test_static_mode_apps_do_not_build_skill_configs(
    test_db: Session, test_admin_user: User, test_user: User, monkeypatch
) -> None:
    _create_app(test_db, test_admin_user, slug="eager-app", auth_type="none")
    builder = TaskRequestBuilder(test_db)
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_bot_uses_chat_shell",
        staticmethod(lambda bot, user_id: True),
    )

    configs, preload, matched_slugs = builder._connector_skill_configs(
        bot=SimpleNamespace(), user=test_user, auth_token="task-token"
    )
    assert configs == []
    assert preload == []
    assert matched_slugs == []


def test_lazy_mode_apps_preload_when_message_matches_keywords(
    test_db: Session, test_admin_user: User, test_user: User, monkeypatch
) -> None:
    _create_app(
        test_db,
        test_admin_user,
        slug="lazy-app",
        auth_type="none",
        tool_loading_mode="lazy",
        keywords=["钉钉 表格"],
    )
    builder = TaskRequestBuilder(test_db)
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_bot_uses_chat_shell",
        staticmethod(lambda bot, user_id: True),
    )

    configs, preload, matched_slugs = builder._connector_skill_configs(
        bot=SimpleNamespace(),
        user=test_user,
        auth_token="task-token",
        message="帮我看一下钉钉里的表格数据",
    )

    assert len(configs) == 1
    assert preload == ["wegent-connector-lazy-app"]
    assert matched_slugs == ["lazy-app"]
    assert "mcpServers" not in configs[0]


def test_matched_lazy_app_adds_scoped_mcp_server(monkeypatch) -> None:
    builder = TaskRequestBuilder(MagicMock())
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_bot_uses_chat_shell",
        staticmethod(lambda bot, user_id: True),
    )
    monkeypatch.setattr(
        TaskRequestBuilder, "_user_has_callable_connectors", lambda self, user: False
    )

    servers = builder._connector_mcp_servers(
        bot=SimpleNamespace(),
        user=SimpleNamespace(id=7),
        auth_token="task-token",
        matched_lazy_connector_slugs=["dingtalk_sheet"],
    )

    assert servers == [
        {
            "name": "wegent-connector-dingtalk_sheet",
            "url": servers[0]["url"],
            "type": "streamable-http",
            "auth": {
                "Authorization": "Bearer task-token",
                "X-Connector-App": "dingtalk_sheet",
            },
            "timeout": 180,
        }
    ]
    assert servers[0]["url"].endswith("/mcp/connectors/sse")


def test_chat_shell_gets_one_authenticated_connector_server(monkeypatch) -> None:
    builder = TaskRequestBuilder(MagicMock())
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_bot_uses_chat_shell",
        staticmethod(lambda bot, user_id: True),
    )
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_user_has_callable_connectors",
        lambda self, user: True,
    )

    servers = builder._connector_mcp_servers(
        bot=SimpleNamespace(), user=SimpleNamespace(id=7), auth_token="task-token"
    )

    assert len(servers) == 1
    assert servers[0]["name"] == "wegent-connectors"
    assert servers[0]["url"].endswith("/mcp/connectors/sse")
    assert servers[0]["auth"] == {"Authorization": "Bearer task-token"}


def test_coding_shells_keep_their_local_proxy(monkeypatch) -> None:
    builder = TaskRequestBuilder(MagicMock())
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_bot_uses_chat_shell",
        staticmethod(lambda bot, user_id: False),
    )

    servers = builder._connector_mcp_servers(
        bot=SimpleNamespace(), user=SimpleNamespace(id=7), auth_token="task-token"
    )

    assert servers == []


def test_chat_shell_detection_uses_the_resolved_shell_type(monkeypatch) -> None:
    builder = TaskRequestBuilder(MagicMock())
    bot = SimpleNamespace(json={})
    monkeypatch.setattr(builder, "_resolve_shell_type", lambda bot, user_id: "Chat")

    assert builder._bot_uses_chat_shell(bot, 7) is True


def test_chat_shell_detection_rejects_an_unresolvable_shell(monkeypatch) -> None:
    builder = TaskRequestBuilder(MagicMock())
    bot = SimpleNamespace(json={})

    def unavailable_shell(_bot, _user_id):
        raise ValueError("missing shell")

    monkeypatch.setattr(builder, "_resolve_shell_type", unavailable_shell)

    assert builder._bot_uses_chat_shell(bot, 7) is False


def test_chat_shell_detection_fails_closed_for_a_partial_bot() -> None:
    builder = TaskRequestBuilder(MagicMock())

    assert builder._bot_uses_chat_shell(SimpleNamespace(id=9), 7) is False


def test_cloud_coding_shell_gets_the_matched_connector_server(monkeypatch) -> None:
    """Cloud Claude Code/Codex tasks have no local proxy to fall back on."""
    builder = TaskRequestBuilder(MagicMock())
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_user_has_callable_connectors",
        lambda self, user: False,
    )
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_authorized_lazy_connector_apps",
        lambda self, user: [
            SimpleNamespace(slug="dingding_log", keywords=["钉钉日志", "dingding log"])
        ],
    )
    bot_config: dict = {"shell_type": "ClaudeCode", "mcp_servers": []}

    builder._attach_connector_mcp_for_coding_shell(
        bot_config,
        user=SimpleNamespace(id=6),
        auth_token="task-token",
        message="钉钉日志",
    )

    servers = bot_config["mcp_servers"]
    assert [server["name"] for server in servers] == ["wegent-connector-dingding_log"]
    assert servers[0]["type"] == "http"
    assert servers[0]["url"] == "${{backend_api_url}}/mcp/connectors/sse"
    assert servers[0]["headers"] == {
        "Authorization": "Bearer ${{task_token}}",
        "X-Connector-App": "dingding_log",
    }


@pytest.mark.parametrize(
    "backend_url",
    [
        "http://backend.example:8000",
        "http://backend.example:8000/",
        "http://backend.example:8000/api",
        "http://backend.example:8000/api/",
    ],
)
def test_cloud_coding_shell_does_not_double_an_api_prefix(
    monkeypatch, backend_url: str
) -> None:
    from shared.models.execution import ExecutionRequest
    from shared.utils.mcp_utils import replace_mcp_server_variables

    builder = TaskRequestBuilder(MagicMock())
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_user_has_callable_connectors",
        lambda self, user: False,
    )
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_authorized_lazy_connector_apps",
        lambda self, user: [SimpleNamespace(slug="dingding_log", keywords=[])],
    )
    bot_config: dict = {"shell_type": "ClaudeCode", "mcp_servers": []}

    builder._attach_connector_mcp_for_coding_shell(
        bot_config, user=SimpleNamespace(id=6), auth_token="t", message=""
    )

    assert (
        bot_config["mcp_servers"][0]["url"] == "${{backend_api_url}}/mcp/connectors/sse"
    )
    request = ExecutionRequest(backend_url=backend_url, auth_token="synthetic")
    resolved = replace_mcp_server_variables(bot_config["mcp_servers"], request)
    assert resolved[0]["url"] == "http://backend.example:8000/api/mcp/connectors/sse"
    assert resolved[0]["headers"]["Authorization"] == "Bearer synthetic"


@pytest.mark.parametrize("shell_type", ["ClaudeCode", "Codex"])
def test_coding_shell_can_discover_unmatched_lazy_apps(monkeypatch, shell_type) -> None:
    """Claude shares a compact server; Codex preserves its per-app scope."""
    builder = TaskRequestBuilder(MagicMock())
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_user_has_callable_connectors",
        lambda self, user: False,
    )
    monkeypatch.setattr(
        TaskRequestBuilder,
        "_authorized_lazy_connector_apps",
        lambda self, user: [
            SimpleNamespace(slug="dingding_log", keywords=["钉钉日志"])
        ],
    )
    bot_config: dict = {"shell_type": shell_type, "mcp_servers": []}

    builder._attach_connector_mcp_for_coding_shell(
        bot_config, user=SimpleNamespace(id=6), auth_token="t", message="写周报"
    )

    assert len(bot_config["mcp_servers"]) == 1
    headers = {
        "Authorization": "Bearer ${{task_token}}",
        "X-Connector-Loading": "lazy",
    }
    if shell_type == "ClaudeCode":
        assert bot_config["mcp_servers"][0]["name"] == "wca"
        assert bot_config["mcp_servers"][0]["alwaysLoad"] is True
    else:
        headers["X-Connector-App"] = "dingding_log"
        assert "alwaysLoad" not in bot_config["mcp_servers"][0]
    assert bot_config["mcp_servers"][0]["headers"] == headers


def test_claude_lazy_apps_share_one_server_and_fit_the_full_tool_name_budget(
    monkeypatch,
) -> None:
    builder = TaskRequestBuilder(MagicMock())
    apps = [
        SimpleNamespace(slug="a" * 100, keywords=[]),
        SimpleNamespace(slug="another-app", keywords=[]),
    ]
    monkeypatch.setattr(builder, "_user_has_callable_connectors", lambda user: False)
    monkeypatch.setattr(builder, "_authorized_lazy_connector_apps", lambda user: apps)
    bot_config = {"shell_type": "ClaudeCode", "mcp_servers": []}
    builder._attach_connector_mcp_for_coding_shell(
        bot_config, user=SimpleNamespace(id=6), auth_token="t", message="unrelated"
    )
    servers = bot_config["mcp_servers"]
    assert len(servers) == 1
    assert "X-Connector-App" not in servers[0]["headers"]
    for app in apps:
        for entry in ("_wegent_discover__", "_wegent_call__"):
            assert len(f"mcp__{servers[0]['name']}__{entry}{app.slug}") <= 128


@pytest.mark.parametrize("shell_type", ["Chat", "Codex", "ClaudeCode"])
def test_selected_provider_mounts_its_authorized_scope_without_keywords(
    shell_type,
) -> None:
    from app.services.chat.selected_knowledge import activate_provider_native_knowledge
    from app.services.execution.skill_mcp import extract_skill_mcp_servers
    from shared.models import ExecutionRequest
    from shared.utils.mcp_utils import replace_mcp_server_variables

    skills = [
        {
            "name": "dingtalk-docs",
            "connector_slug": "documents",
            "connector_available": True,
        }
    ]
    TaskRequestBuilder._attach_selected_connector_skill_servers(
        skills, ["dingtalk-docs"]
    )
    servers = extract_skill_mcp_servers(skills)
    request = ExecutionRequest(
        backend_url="https://backend.example/api/",
        auth_token="synthetic",
        bot=[{"shell_type": shell_type, "mcp_servers": servers}],
        skill_names=["dingtalk-docs"],
        skill_configs=skills,
    )
    activate_provider_native_knowledge(request, ["dingtalk-docs"])
    assert request.provider_native_knowledge is True
    assert len(servers) == 1
    assert servers[0]["headers"]["X-Connector-App"] == "documents"
    assert "X-Connector-Loading" not in servers[0]["headers"]
    resolved = replace_mcp_server_variables(servers, request)
    assert resolved[0]["url"] == "https://backend.example/api/mcp/connectors/sse"
    assert resolved[0]["headers"]["Authorization"] == "Bearer synthetic"


def test_available_but_unselected_provider_keeps_its_tools_deferred() -> None:
    skills = [
        {
            "name": "dingtalk-docs",
            "connector_slug": "documents",
            "connector_available": True,
        }
    ]
    TaskRequestBuilder._attach_selected_connector_skill_servers(skills, [])
    assert "mcpServers" not in skills[0]


def test_unavailable_selected_provider_does_not_get_a_scoped_server() -> None:
    skills = [
        {
            "name": "dingtalk-docs",
            "connector_slug": "documents",
            "connector_available": False,
        }
    ]
    TaskRequestBuilder._attach_selected_connector_skill_servers(
        skills, ["dingtalk-docs"]
    )
    assert "mcpServers" not in skills[0]


@pytest.mark.parametrize("enabled", [True, False])
def test_selected_provider_checks_app_availability_not_just_a_user_grant(
    test_db: Session, test_admin_user: User, test_user: User, enabled: bool
) -> None:
    from app.schemas.connector import ConnectorAppUpdate

    app = _create_app(
        test_db,
        test_admin_user,
        slug="dingtalk_docs",
        auth_type="none",
        tool_loading_mode="lazy",
    )
    if not enabled:
        connector_app_service.update_app(
            test_db, app, ConnectorAppUpdate(enabled=False)
        )
    skill = SimpleNamespace(
        id=101,
        user_id=0,
        json={
            "kind": "Skill",
            "metadata": {"name": "dingtalk-docs", "namespace": "default"},
            "spec": {"description": "Documents", "prompt": "Use documents."},
        },
    )
    builder = TaskRequestBuilder(test_db)
    data = builder._build_skill_data(skill, user=test_user)
    builder._attach_selected_connector_skill_servers([data], ["dingtalk-docs"])
    assert data["connector_available"] is enabled
    assert ("mcpServers" in data) is enabled

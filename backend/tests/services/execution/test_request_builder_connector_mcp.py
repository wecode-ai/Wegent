# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connector apps reach the Chat shell through the backend MCP endpoint."""

from types import SimpleNamespace
from unittest.mock import MagicMock

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
        TaskRequestBuilder, "_bot_uses_chat_shell", staticmethod(lambda bot: True)
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
        TaskRequestBuilder, "_bot_uses_chat_shell", staticmethod(lambda bot: True)
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
        TaskRequestBuilder, "_bot_uses_chat_shell", staticmethod(lambda bot: True)
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
        TaskRequestBuilder, "_bot_uses_chat_shell", staticmethod(lambda bot: True)
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
        TaskRequestBuilder, "_bot_uses_chat_shell", staticmethod(lambda bot: True)
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
        TaskRequestBuilder, "_bot_uses_chat_shell", staticmethod(lambda bot: False)
    )

    servers = builder._connector_mcp_servers(
        bot=SimpleNamespace(), user=SimpleNamespace(id=7), auth_token="task-token"
    )

    assert servers == []


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
    assert servers[0]["url"] == "${{backend_url}}/mcp/connectors/sse"
    assert servers[0]["headers"] == {
        "Authorization": "Bearer ${{task_token}}",
        "X-Connector-App": "dingding_log",
    }


def test_coding_shell_skips_unmatched_lazy_apps(monkeypatch) -> None:
    """Lazy apps stay out of a coding shell until the message asks for them."""
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
    bot_config: dict = {"shell_type": "ClaudeCode", "mcp_servers": []}

    builder._attach_connector_mcp_for_coding_shell(
        bot_config, user=SimpleNamespace(id=6), auth_token="t", message="写周报"
    )

    assert bot_config["mcp_servers"] == []

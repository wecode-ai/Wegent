# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Built-in DingTalk connector apps backfill once and respect deletions."""

from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_builtin_apps import (
    BUILTIN_CONNECTOR_APPS,
    ensure_builtin_connector_apps,
)


def test_creates_every_missing_builtin_app(test_db: Session) -> None:
    created = ensure_builtin_connector_apps(test_db)

    assert created == [definition.slug for definition in BUILTIN_CONNECTOR_APPS]
    for definition in BUILTIN_CONNECTOR_APPS:
        app = connector_app_service.get_app_by_slug(test_db, definition.slug)
        assert app is not None
        assert app.mcp_url == definition.mcp_url
        assert app.auth_type == "oauth2"
        assert app.tool_loading_mode == "lazy"
        assert app.keywords
        assert app.enabled is True


def test_is_idempotent(test_db: Session) -> None:
    ensure_builtin_connector_apps(test_db)

    assert ensure_builtin_connector_apps(test_db) == []


def test_same_name_owned_by_another_user_is_left_untouched(
    test_db: Session, test_user: User
) -> None:
    """Kind identity is (namespace, name, user), so backfill must match owner 0."""
    from app.models.kind import Kind
    from app.services.connector_apps import (
        CONNECTOR_APP_KIND,
        CONNECTOR_APP_NAMESPACE,
    )

    definition = BUILTIN_CONNECTOR_APPS[0]
    foreign = Kind(
        kind=CONNECTOR_APP_KIND,
        namespace=CONNECTOR_APP_NAMESPACE,
        name=definition.slug,
        user_id=test_user.id,
        is_active=True,
        json={"spec": {"mcpUrl": "https://other.example.test/mcp", "keywords": []}},
    )
    test_db.add(foreign)
    test_db.commit()

    ensure_builtin_connector_apps(test_db)

    test_db.refresh(foreign)
    assert foreign.json["spec"]["mcpUrl"] == "https://other.example.test/mcp"
    assert "toolLoadingMode" not in foreign.json["spec"]
    system_row = (
        test_db.query(Kind)
        .filter(
            Kind.kind == CONNECTOR_APP_KIND,
            Kind.namespace == CONNECTOR_APP_NAMESPACE,
            Kind.name == definition.slug,
            Kind.user_id == 0,
            Kind.is_active,
        )
        .one()
    )
    assert system_row.id != foreign.id


def test_deleted_app_is_recreated_on_next_bootstrap(test_db: Session) -> None:
    ensure_builtin_connector_apps(test_db)
    app = connector_app_service.get_app_by_slug(test_db, "dingtalk_docs")
    assert app is not None
    connector_app_service.delete_app(test_db, app)

    assert connector_app_service.get_app_by_slug(test_db, "dingtalk_docs") is None

    assert ensure_builtin_connector_apps(test_db) == ["dingtalk_docs"]
    restored = connector_app_service.get_app_by_slug(test_db, "dingtalk_docs")
    assert restored is not None
    assert restored.name == "钉钉文档"


def test_upstream_already_published_is_not_duplicated(
    test_db: Session, test_admin_user: User
) -> None:
    """A hand-created app for the same MCP server suppresses the built-in copy."""
    connector_app_service.create_app(
        test_db,
        ConnectorAppWrite(
            slug="my-dingtalk-docs",
            name="My DingTalk Docs",
            transport="streamable-http",
            mcp_url="https://mcp-gw.dingtalk.com/oauth/server/doc",
            auth_type="oauth2",
        ),
        test_admin_user,
    )

    created = ensure_builtin_connector_apps(test_db)

    assert "dingtalk_docs" not in created
    assert connector_app_service.get_app_by_slug(test_db, "dingtalk_docs") is None
    assert len(created) == len(BUILTIN_CONNECTOR_APPS) - 1


def test_backfills_existing_builtin_apps_to_lazy_mode(test_db: Session) -> None:
    ensure_builtin_connector_apps(test_db)
    app = connector_app_service.get_app_by_slug(test_db, "dingtalk_docs")
    assert app is not None
    spec = dict(app.row.json["spec"])
    spec.pop("builtinToolLoadingMode", None)
    spec["toolLoadingMode"] = "static"
    spec.pop("keywords", None)
    spec.pop("builtinKeywordsSeeded", None)
    app.row.json = {**app.row.json, "spec": spec}
    test_db.commit()

    assert ensure_builtin_connector_apps(test_db) == []

    refreshed = connector_app_service.get_app_by_slug(test_db, "dingtalk_docs")
    assert refreshed is not None
    assert refreshed.tool_loading_mode == "lazy"
    assert refreshed.row.json["spec"]["builtinToolLoadingMode"] == "lazy"
    assert refreshed.keywords
    assert refreshed.row.json["spec"]["builtinKeywordsSeeded"] is True


def test_backfill_preserves_an_explicit_static_choice(test_db: Session) -> None:
    ensure_builtin_connector_apps(test_db)
    app = connector_app_service.get_app_by_slug(test_db, "dingtalk_docs")
    assert app is not None
    spec = dict(app.row.json["spec"])
    spec["toolLoadingMode"] = "static"
    app.row.json = {**app.row.json, "spec": spec}
    test_db.commit()

    assert ensure_builtin_connector_apps(test_db) == []

    refreshed = connector_app_service.get_app_by_slug(test_db, "dingtalk_docs")
    assert refreshed is not None
    assert refreshed.tool_loading_mode == "static"

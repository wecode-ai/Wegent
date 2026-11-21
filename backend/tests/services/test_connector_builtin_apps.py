# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Built-in DingTalk connector apps backfill once and respect deletions."""

from copy import deepcopy

import pytest
from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_builtin_apps import (
    BUILTIN_COMPLETION_KEY,
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
    completion = (
        test_db.query(SystemConfig).filter_by(config_key=BUILTIN_COMPLETION_KEY).one()
    )
    assert completion.config_value == {"completed": True}
    assert completion.updated_by == 0


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


def test_deleted_app_is_not_recreated_after_successful_bootstrap(
    test_db: Session,
) -> None:
    ensure_builtin_connector_apps(test_db)
    app = connector_app_service.get_app_by_slug(test_db, "dingtalk_docs")
    assert app is not None
    connector_app_service.delete_app(test_db, app)

    assert connector_app_service.get_app_by_slug(test_db, "dingtalk_docs") is None

    assert ensure_builtin_connector_apps(test_db) == []
    assert connector_app_service.get_app_by_slug(test_db, "dingtalk_docs") is None


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


def test_same_url_owned_by_another_user_does_not_hide_the_builtin(
    test_db: Session, test_user: User
) -> None:
    """Only the system owner publishes apps, so its catalog drives de-duplication."""
    from app.models.kind import Kind
    from app.services.connector_apps import (
        CONNECTOR_APP_KIND,
        CONNECTOR_APP_NAMESPACE,
    )

    definition = BUILTIN_CONNECTOR_APPS[0]
    test_db.add(
        Kind(
            kind=CONNECTOR_APP_KIND,
            namespace=CONNECTOR_APP_NAMESPACE,
            name=f"{definition.slug}-foreign",
            user_id=test_user.id,
            is_active=True,
            json={"spec": {"mcpUrl": definition.mcp_url}},
        )
    )
    test_db.commit()

    created = ensure_builtin_connector_apps(test_db)

    assert definition.slug in created
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
    assert system_row.json["spec"]["mcpUrl"] == definition.mcp_url


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
    # Model an installation that predates the shared completion marker.
    test_db.query(SystemConfig).filter_by(config_key=BUILTIN_COMPLETION_KEY).delete()
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


def test_rust_completion_marker_skips_the_catalog(test_db: Session) -> None:
    test_db.add(
        SystemConfig(
            config_key=BUILTIN_COMPLETION_KEY,
            config_value={"completed": True},
            version=1,
            updated_by=0,
        )
    )
    test_db.commit()

    assert ensure_builtin_connector_apps(test_db) == []
    assert test_db.query(Kind).filter_by(kind="ConnectorApp", user_id=0).count() == 0


def verify_failed_bootstrap_rolls_back_and_can_retry(
    test_db: Session, failed_slug: str | None
) -> None:
    model = Kind if failed_slug else SystemConfig
    staged_rows: list[Kind] = []

    def retain_staged_rows(
        session: Session, _flush_context: object, _instances: object
    ) -> None:
        staged_rows.extend(row for row in session.dirty if isinstance(row, Kind))

    def reject_insert(
        _mapper: object, _connection: object, row: Kind | SystemConfig
    ) -> None:
        if isinstance(row, SystemConfig) or row.name == failed_slug:
            raise RuntimeError("test bootstrap write failure")

    event.listen(test_db, "before_flush", retain_staged_rows)
    event.listen(model, "before_insert", reject_insert)
    try:
        with pytest.raises(RuntimeError, match="test bootstrap write failure"):
            ensure_builtin_connector_apps(test_db)
    finally:
        event.remove(model, "before_insert", reject_insert)
        event.remove(test_db, "before_flush", retain_staged_rows)

    if failed_slug != BUILTIN_CONNECTOR_APPS[0].slug:
        assert staged_rows
    assert all(inspect(row).transient for row in staged_rows)

    assert (
        test_db.query(Kind)
        .filter(
            Kind.kind == "ConnectorApp",
            Kind.namespace == "system",
            Kind.user_id == 0,
            Kind.name.in_([definition.slug for definition in BUILTIN_CONNECTOR_APPS]),
        )
        .count()
    ) == 0
    assert (
        test_db.query(SystemConfig).filter_by(config_key=BUILTIN_COMPLETION_KEY).count()
        == 0
    )
    assert ensure_builtin_connector_apps(test_db) == [
        definition.slug for definition in BUILTIN_CONNECTOR_APPS
    ]


@pytest.mark.parametrize(
    "failed_slug", [definition.slug for definition in BUILTIN_CONNECTOR_APPS] + [None]
)
@pytest.mark.filterwarnings(
    "error:Identity map already had an identity:sqlalchemy.exc.SAWarning"
)
def test_failed_bootstrap_rolls_back_apps_and_marker_and_can_retry(
    test_db: Session, failed_slug: str | None
) -> None:
    verify_failed_bootstrap_rolls_back_and_can_retry(test_db, failed_slug)


def test_incomplete_marker_is_retried(test_db: Session) -> None:
    test_db.add(
        SystemConfig(
            config_key=BUILTIN_COMPLETION_KEY, config_value={"completed": False}
        )
    )
    test_db.commit()

    assert ensure_builtin_connector_apps(test_db) == [
        definition.slug for definition in BUILTIN_CONNECTOR_APPS
    ]
    completion = (
        test_db.query(SystemConfig).filter_by(config_key=BUILTIN_COMPLETION_KEY).one()
    )
    assert completion.config_value == {"completed": True}


def test_failed_bootstrap_rolls_back_existing_app_backfill(
    test_db: Session, test_admin_user: User
) -> None:
    definition = BUILTIN_CONNECTOR_APPS[0]
    app = connector_app_service.create_app(
        test_db,
        ConnectorAppWrite(
            slug=definition.slug,
            name=definition.name,
            mcp_url=definition.mcp_url,
            auth_type="oauth2",
            tool_loading_mode="static",
        ),
        test_admin_user,
    )
    before = deepcopy(app.row.json)

    def reject_insert(_mapper: object, _connection: object, row: Kind) -> None:
        if row.name == BUILTIN_CONNECTOR_APPS[2].slug:
            raise RuntimeError("test bootstrap write failure")

    event.listen(Kind, "before_insert", reject_insert)
    try:
        with pytest.raises(RuntimeError, match="test bootstrap write failure"):
            ensure_builtin_connector_apps(test_db)
    finally:
        event.remove(Kind, "before_insert", reject_insert)

    test_db.refresh(app.row)
    assert app.row.json == before
    assert test_db.query(Kind).filter_by(kind="ConnectorApp", user_id=0).count() == 1
    assert (
        test_db.query(SystemConfig).filter_by(config_key=BUILTIN_COMPLETION_KEY).count()
        == 0
    )

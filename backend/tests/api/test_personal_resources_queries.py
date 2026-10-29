# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resource discovery batches dependencies and deployment permission providers."""

import uuid
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services import external_entity_resolver
from app.services.user_runtime_config import user_runtime_config_service
from app.services.workspaces.personal_resources import WorkspacePersonalResourceService


def _kind(user_id: int, kind: str, name: str, spec: dict, namespace="default"):
    return Kind(
        user_id=user_id,
        kind=kind,
        name=name,
        namespace=namespace,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {"name": name, "namespace": namespace},
            "spec": spec,
        },
    )


def _catalog(db: Session, user_id: int, owner_id: int, size: int) -> Namespace:
    """
    Create distinct agent dependencies and identity-scoped models at catalog scale.
    """
    prefix = uuid.uuid4().hex[:8]
    group = Namespace(name=f"catalog-{prefix}", owner_user_id=owner_id)
    db.add(group)
    db.flush()
    db.add(
        ResourceMember.create(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="test_department",
            entity_id="department",
            role="Developer",
            status="approved",
            invited_by_user_id=owner_id,
        )
    )
    shell_name = f"shell-{prefix}"
    db.add(_kind(user_id, "Shell", shell_name, {"shellType": "Chat"}))
    for index in range(size):
        name = f"{prefix}-{index}"
        db.add_all(
            [
                _kind(
                    owner_id,
                    "Model",
                    name,
                    {
                        "modelConfig": {"env": {"model": "openai", "model_id": "test"}},
                        "protocol": "openai",
                    },
                    group.name,
                ),
                _kind(user_id, "Ghost", name, {"systemPrompt": "Test."}),
                _kind(
                    user_id,
                    "Bot",
                    name,
                    {
                        "ghostRef": {"name": name, "namespace": "default"},
                        "shellRef": {"name": shell_name, "namespace": "default"},
                        "modelRef": {"name": name, "namespace": "default"},
                    },
                ),
                _kind(
                    user_id,
                    "Team",
                    name,
                    {
                        "members": [{"botRef": {"name": name, "namespace": "default"}}],
                        "collaborationModel": "solo",
                    },
                ),
            ]
        )
    db.commit()
    return group


@pytest.mark.parametrize("size", [2, 86])
async def test_resource_catalog_batches_distinct_dependencies_and_entity_permissions(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    monkeypatch: pytest.MonkeyPatch,
    record_property,
    size: int,
) -> None:
    """Keep dependency and group lookups bounded as distinct agent count grows."""
    _catalog(test_db, test_user.id, test_admin_user.id, size)
    resolver = Mock(spec=external_entity_resolver.IExternalEntityResolver)
    resolver.match_entity_bindings.return_value = ["department"]
    monkeypatch.setattr(
        external_entity_resolver,
        "_external_entity_resolvers",
        {
            "test_department": type(resolver),
        },
    )
    monkeypatch.setattr(
        external_entity_resolver,
        "_resolver_instances",
        {
            "test_department": resolver,
        },
    )
    monkeypatch.setattr(
        "app.core.cache.cache_manager.mget_or_raise", AsyncMock(return_value={})
    )
    statements: list[str] = []

    def record_sql(connection, cursor, statement, *args):
        """Collect SELECT statements for the catalog query budget."""
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    connection = test_db.get_bind()
    user_id = test_user.id
    event.listen(connection, "before_cursor_execute", record_sql)
    try:
        with Session(bind=connection) as db:
            resources = (
                await WorkspacePersonalResourceService().list_personal_resources(
                    db, user_id
                )
            )
    finally:
        event.remove(connection, "before_cursor_execute", record_sql)

    assert len(resources["agents"]) == size
    assert {agent["status"] for agent in resources["agents"]} == {"available"}
    resolver.match_entity_bindings.assert_called_once()

    assert (
        len(statements) <= 16
    ), f"{len(statements)} SELECTs for {size} distinct agents"
    record_property("agent_count", size)
    record_property("catalog_selects", len(statements))

    resolver.match_entity_bindings.reset_mock()
    resolver.match_entity_bindings.return_value = []
    with Session(bind=connection) as db:
        revoked = await WorkspacePersonalResourceService().list_personal_resources(
            db, user_id
        )
    assert {agent["status"] for agent in revoked["agents"]} == {"unavailable"}
    resolver.match_entity_bindings.assert_called_once()


@pytest.mark.parametrize("size", [2, 86])
async def test_runtime_model_readiness_is_resolved_once_per_request(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    monkeypatch: pytest.MonkeyPatch,
    size: int,
) -> None:
    """Reuse runtime model resolution only within the current catalog request."""
    _catalog(test_db, test_user.id, test_admin_user.id, size)
    for bot in test_db.query(Kind).filter_by(user_id=test_user.id, kind="Bot"):
        bot.json = {
            **bot.json,
            "spec": {
                **bot.json["spec"],
                "modelRef": {"name": "codex-gpt-5.5", "namespace": "default"},
            },
        }
    user_runtime_config_service.save_auth_json(
        test_db, user_id=test_user.id, runtime="codex", auth_json='{"token":"test"}'
    )
    user_runtime_config_service.set_use_user_config(
        test_db, user=test_user, runtime="codex", use_user_config=True
    )
    monkeypatch.setattr(
        "app.core.cache.cache_manager.mget_or_raise", AsyncMock(return_value={})
    )
    resolve = Mock(wraps=user_runtime_config_service.get_execution_config)
    monkeypatch.setattr(user_runtime_config_service, "get_execution_config", resolve)
    user_id = test_user.id
    for enabled in [True, False]:
        user_runtime_config_service.set_use_user_config(
            test_db, user=test_user, runtime="codex", use_user_config=enabled
        )
        resolve.reset_mock()
        with Session(bind=test_db.get_bind()) as db:
            resources = (
                await WorkspacePersonalResourceService().list_personal_resources(
                    db, user_id
                )
            )
        assert len(resources["agents"]) == size
        assert {agent["status"] for agent in resources["agents"]} == {
            "available" if enabled else "unavailable"
        }
        assert resolve.call_count == 1

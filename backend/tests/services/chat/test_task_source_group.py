# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task sources reuse separate groups without changing ordinary chat history."""

from collections.abc import Generator
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Literal
from unittest.mock import Mock, call, patch

import pytest
from fastapi import HTTPException
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import MetaData, create_engine, event
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import ORMExecuteState, Session

from app.core.cache import RedisCache
from app.models.api_key import APIKey
from app.models.project import Project
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.project import ProjectConfig
from app.services import project_service
from app.services.chat import task_source_group
from app.services.chat.storage.task_manager import TaskCreationParams, create_new_task
from app.services.chat.task_source_group import get_or_create_task_source_group


@pytest.fixture(autouse=True)
def source_group_cache(monkeypatch: pytest.MonkeyPatch) -> Mock:
    cache = Mock(spec=RedisCache)
    cache.get_sync.return_value = None
    cache.set_from_sync.return_value = True
    monkeypatch.setattr(task_source_group, "cache_manager", cache)
    monkeypatch.setattr(
        task_source_group.settings,
        "TASK_SOURCE_GROUP_NAMES",
        {"api": "API Tasks", "dingtalk": "DingTalk"},
    )
    return cache


@pytest.fixture
def committing_db() -> Generator[tuple[Session, User], None, None]:
    """Use real session transactions without the test fixture's outer savepoint."""
    engine = create_engine("sqlite:///:memory:")
    User.__table__.create(engine)
    Project.__table__.create(engine)
    try:
        with Session(engine, expire_on_commit=False) as db:
            user = User(user_name="api-cache-user", password_hash="unused")
            db.add(user)
            db.commit()
            yield db, user
    finally:
        engine.dispose()


@contextmanager
def _selects(db: Session) -> Generator[list[str], None, None]:
    statements: list[str] = []

    def record(state: ORMExecuteState) -> None:
        if state.is_select:
            statements.append(str(state.statement.compile(dialect=mysql.dialect())))

    event.listen(db, "do_orm_execute", record)
    try:
        yield statements
    finally:
        event.remove(db, "do_orm_execute", record)


def _create_task(db: Session, user: User, **kwargs: object) -> TaskResource:
    team = SimpleNamespace(user_id=user.id, name="quickstart", namespace="default")
    with patch(
        "app.services.chat.storage.task_manager.build_initial_task_knowledge_base_refs",
        return_value=[],
    ):
        return create_new_task(
            db, user, team, TaskCreationParams(message="Hello", **kwargs)
        )


@pytest.mark.parametrize("task_source", ["api", "dingtalk"])
def test_source_group_creation_with_non_nullable_description_and_color(
    task_source: Literal["api", "dingtalk"],
) -> None:
    """Older installations require non-null project description and color."""
    engine = create_engine("sqlite:///:memory:")
    metadata = MetaData()
    User.__table__.to_metadata(metadata)
    projects = Project.__table__.to_metadata(metadata)
    projects.c.description.nullable = False
    projects.c.color.nullable = False
    metadata.create_all(engine)
    try:
        with Session(engine) as db:
            user = User(user_name="source-group-user", password_hash="unused")
            db.add(user)
            db.flush()

            group = get_or_create_task_source_group(
                db,
                user_id=user.id,
                client_origin="frontend",
                task_source=task_source,
            )
            db.commit()
            db.refresh(group)

            assert group.description == ""
            assert group.color == ""
            assert group.config["taskSource"] == task_source
    finally:
        engine.dispose()


def test_api_tasks_share_collapsed_group_and_web_chat_stays_ungrouped(
    test_db: Session, test_user: User
) -> None:
    web_task = _create_task(test_db, test_user)
    api_task = _create_task(test_db, test_user, is_api_call=True)
    second_api_task = _create_task(test_db, test_user, is_api_call=True)
    test_db.flush()

    groups = project_service.list_projects(
        test_db, test_user.id, client_origin="frontend"
    ).items
    assert len(groups) == 1
    group = groups[0]
    assert group.name == "API Tasks"
    assert group.is_expanded is False
    assert group.config.taskSource == "api"
    assert group.config.is_workspace is False
    assert {task.task_id for task in group.tasks} == {
        api_task.id,
        second_api_task.id,
    }
    assert web_task.project_id == 0
    assert api_task.project_id == second_api_task.project_id == group.id
    assert api_task.json["metadata"]["labels"]["projectId"] == str(group.id)


def test_api_task_respects_explicit_group(test_db: Session, test_user: User) -> None:
    group = Project(user_id=test_user.id, name="My group", client_origin="frontend")
    test_db.add(group)
    test_db.flush()

    task = _create_task(test_db, test_user, is_api_call=True, project_id=group.id)

    assert task.project_id == group.id
    assert test_db.query(Project).count() == 1


@pytest.mark.parametrize("client_origin", ["frontend", "wework"])
def test_dingtalk_tasks_reuse_a_group_separate_from_api_and_web_tasks(
    test_db: Session, test_user: User, client_origin: str
) -> None:
    message_source = {"source": "im", "channel_type": "dingtalk"}
    first = _create_task(
        test_db, test_user, client_origin=client_origin, message_source=message_source
    )
    second = _create_task(
        test_db, test_user, client_origin=client_origin, message_source=message_source
    )
    api_task = _create_task(
        test_db, test_user, client_origin=client_origin, is_api_call=True
    )
    web_task = _create_task(test_db, test_user, client_origin=client_origin)

    group = test_db.get(Project, first.project_id)
    assert group.name == "DingTalk"
    assert group.config["taskSource"] == "dingtalk"
    assert group.client_origin == client_origin
    assert group.is_expanded is False
    assert ProjectConfig.model_validate(group.config).is_workspace is False
    assert first.project_id == second.project_id
    assert first.json["metadata"]["labels"]["projectId"] == str(group.id)
    assert api_task.project_id != group.id
    assert test_db.get(Project, api_task.project_id).config["taskSource"] == "api"
    assert web_task.project_id == 0
    assert test_db.query(Project).count() == 2


def test_dingtalk_task_respects_explicit_group(
    test_db: Session, test_user: User
) -> None:
    group = Project(user_id=test_user.id, name="My group", client_origin="wework")
    test_db.add(group)
    test_db.flush()

    task = _create_task(
        test_db,
        test_user,
        client_origin="wework",
        project_id=group.id,
        message_source={"source": "im", "channel_type": "dingtalk"},
    )

    assert task.project_id == group.id
    assert test_db.query(Project).count() == 1
    assert not group.config or "taskSource" not in group.config


@pytest.mark.parametrize("client_origin", ["frontend", "wework"])
@pytest.mark.parametrize("channel_type", ["feishu", "wecom"])
def test_other_im_tasks_do_not_enter_a_source_group(
    test_db: Session, test_user: User, client_origin: str, channel_type: str
) -> None:
    task = _create_task(
        test_db,
        test_user,
        client_origin=client_origin,
        message_source={"source": "im", "channel_type": channel_type},
    )

    assert task.project_id == 0
    assert test_db.query(Project).count() == 0


def test_api_group_reuse_survives_rename_and_preserves_expansion(
    test_db: Session, test_user: User
) -> None:
    group = get_or_create_task_source_group(
        test_db,
        user_id=test_user.id,
        client_origin="frontend",
        task_source="api",
    )
    group.name = "Automation"
    group.is_expanded = True
    test_db.flush()

    task = _create_task(test_db, test_user, is_api_call=True)

    assert task.project_id == group.id
    assert group.name == "Automation"
    assert group.is_expanded is True
    assert test_db.query(Project).count() == 1
    assert ProjectConfig.model_validate(group.config).taskSource == "api"


def test_api_groups_are_scoped_by_owner_and_client(
    test_db: Session, test_user: User
) -> None:
    other_user = User(user_name="other-api-user", password_hash="hash")
    test_db.add(other_user)
    test_db.flush()

    own_group = get_or_create_task_source_group(
        test_db,
        user_id=test_user.id,
        client_origin="frontend",
        task_source="api",
    )
    other_group = get_or_create_task_source_group(
        test_db,
        user_id=other_user.id,
        client_origin="frontend",
        task_source="api",
    )
    wework_group = get_or_create_task_source_group(
        test_db,
        user_id=test_user.id,
        client_origin="wework",
        task_source="api",
    )

    assert len({own_group.id, other_group.id, wework_group.id}) == 3
    assert other_group.user_id == other_user.id
    assert wework_group.client_origin == "wework"


def test_deleted_api_group_is_replaced_without_reclaiming_old_tasks(
    test_db: Session, test_user: User
) -> None:
    old_task = _create_task(test_db, test_user, is_api_call=True)
    old_group = test_db.get(Project, old_task.project_id)
    old_group.is_active = False
    old_task.project_id = 0
    test_db.flush()

    new_task = _create_task(test_db, test_user, is_api_call=True)

    assert new_task.project_id != old_group.id
    assert old_task.project_id == 0
    assert test_db.get(Project, new_task.project_id).is_active is True


def test_api_group_creation_rolls_back_with_task_transaction(
    test_db: Session, test_user: User
) -> None:
    get_or_create_task_source_group(
        test_db,
        user_id=test_user.id,
        client_origin="frontend",
        task_source="api",
    )
    test_db.rollback()

    assert test_db.query(Project).count() == 0


def test_invalid_explicit_group_does_not_create_default_api_group(
    test_db: Session, test_user: User
) -> None:
    with pytest.raises(HTTPException) as exc_info:
        _create_task(test_db, test_user, is_api_call=True, project_id=9999)

    assert exc_info.value.status_code == 404
    assert test_db.query(Project).count() == 0


def test_cache_hit_uses_one_primary_key_query_and_locks_the_group(
    committing_db: tuple[Session, User], source_group_cache: Mock
) -> None:
    db, user = committing_db
    group = Project(
        user_id=user.id,
        name="Renamed API group",
        client_origin="frontend",
        config={"taskSource": "api"},
    )
    db.add(group)
    db.commit()
    source_group_cache.get_sync.return_value = group.id

    with _selects(db) as statements:
        resolved = get_or_create_task_source_group(
            db,
            user_id=user.id,
            client_origin="frontend",
            task_source="api",
        )

    assert resolved.id == group.id
    assert resolved.name == "Renamed API group"
    source_group_cache.get_sync.assert_called_once_with(
        f"task_source_group:api:frontend:{user.id}"
    )
    assert len(statements) == 1
    assert "projects.id =" in statements[0]
    assert "FOR UPDATE" in statements[0]
    assert "users" not in statements[0]


@pytest.mark.parametrize("client_origin", ["frontend", "wework"])
def test_dingtalk_cache_cannot_reuse_an_api_group(
    committing_db: tuple[Session, User],
    source_group_cache: Mock,
    client_origin: str,
) -> None:
    db, user = committing_db
    api_group = Project(
        user_id=user.id,
        name="API",
        client_origin=client_origin,
        config={"taskSource": "api"},
    )
    db.add(api_group)
    db.commit()
    source_group_cache.get_sync.return_value = api_group.id

    resolved = get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin=client_origin,
        task_source="dingtalk",
    )

    assert resolved.id != api_group.id
    assert resolved.config["taskSource"] == "dingtalk"
    assert api_group.config["taskSource"] == "api"
    cache_key = f"task_source_group:dingtalk:{client_origin}:{user.id}"
    source_group_cache.get_sync.assert_called_once_with(cache_key)
    source_group_cache.set_from_sync.assert_not_called()
    db.commit()
    source_group_cache.set_from_sync.assert_called_once_with(
        cache_key, resolved.id, expire=3600
    )


def test_different_api_keys_for_one_owner_reuse_the_same_cache_key(
    committing_db: tuple[Session, User], source_group_cache: Mock
) -> None:
    db, user = committing_db
    keys = [
        APIKey(
            id=index,
            user_id=user.id,
            name=f"Integration {index}",
            key_hash=f"unused-test-hash-{index}",
            key_prefix=f"test-{index}",
        )
        for index in (1, 2)
    ]
    first = get_or_create_task_source_group(
        db,
        user_id=keys[0].user_id,
        client_origin="frontend",
        task_source="api",
    )
    db.commit()
    source_group_cache.get_sync.return_value = first.id

    second = get_or_create_task_source_group(
        db,
        user_id=keys[1].user_id,
        client_origin="frontend",
        task_source="api",
    )

    assert first.id == second.id
    cache_key = f"task_source_group:api:frontend:{user.id}"
    assert source_group_cache.get_sync.call_args_list == [
        call(cache_key),
        call(cache_key),
    ]
    assert db.query(Project).count() == 1


def test_new_group_is_cached_only_after_commit(
    committing_db: tuple[Session, User], source_group_cache: Mock
) -> None:
    db, user = committing_db
    group = get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin="frontend",
        task_source="api",
    )
    group_id = group.id

    source_group_cache.set_from_sync.assert_not_called()
    db.flush()
    source_group_cache.set_from_sync.assert_not_called()
    db.commit()

    source_group_cache.set_from_sync.assert_called_once_with(
        f"task_source_group:api:frontend:{user.id}", group_id, expire=3600
    )


def test_rollback_discards_pending_cache_and_does_not_publish_on_next_transaction(
    committing_db: tuple[Session, User], source_group_cache: Mock
) -> None:
    db, user = committing_db
    get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin="frontend",
        task_source="api",
    )

    db.rollback()

    assert db.query(Project).count() == 0
    source_group_cache.set_from_sync.assert_not_called()
    db.add(Project(user_id=user.id, name="Ordinary group"))
    db.commit()
    source_group_cache.set_from_sync.assert_not_called()

    fresh_group = get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin="frontend",
        task_source="api",
    )
    db.commit()
    source_group_cache.set_from_sync.assert_called_once_with(
        f"task_source_group:api:frontend:{user.id}", fresh_group.id, expire=3600
    )


def test_nested_commit_does_not_cache_before_outer_commit(
    committing_db: tuple[Session, User], source_group_cache: Mock
) -> None:
    db, user = committing_db
    nested = db.begin_nested()
    group = get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin="frontend",
        task_source="api",
    )
    group_id = group.id

    nested.commit()

    source_group_cache.set_from_sync.assert_not_called()
    db.commit()
    source_group_cache.set_from_sync.assert_called_once_with(
        f"task_source_group:api:frontend:{user.id}", group_id, expire=3600
    )


def test_close_discards_pending_cache_before_session_reuse(
    committing_db: tuple[Session, User], source_group_cache: Mock
) -> None:
    db, user = committing_db
    user_id = user.id
    get_or_create_task_source_group(
        db,
        user_id=user_id,
        client_origin="frontend",
        task_source="api",
    )

    db.close()

    source_group_cache.set_from_sync.assert_not_called()
    assert db.query(Project).count() == 0
    db.add(Project(user_id=user_id, name="Ordinary group after close"))
    db.commit()
    source_group_cache.set_from_sync.assert_not_called()


def test_nested_rollback_does_not_cache_its_group_on_outer_commit(
    committing_db: tuple[Session, User], source_group_cache: Mock
) -> None:
    db, user = committing_db
    nested = db.begin_nested()
    get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin="frontend",
        task_source="api",
    )

    nested.rollback()
    db.commit()

    source_group_cache.set_from_sync.assert_not_called()
    assert db.query(Project).count() == 0


@pytest.mark.parametrize(
    "invalid_field,invalid_value",
    [
        ("user_id", 999),
        ("client_origin", "wework"),
        ("config", {}),
        ("config", None),
        ("is_active", False),
    ],
)
def test_cached_group_is_revalidated_before_use(
    committing_db: tuple[Session, User],
    source_group_cache: Mock,
    invalid_field: str,
    invalid_value: object,
) -> None:
    db, user = committing_db
    group = Project(
        user_id=user.id,
        name="Stale cached group",
        client_origin="frontend",
        config={"taskSource": "api"},
    )
    setattr(group, invalid_field, invalid_value)
    db.add(group)
    db.commit()
    source_group_cache.get_sync.return_value = group.id

    resolved = get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin="frontend",
        task_source="api",
    )

    assert resolved.id != group.id
    assert resolved.user_id == user.id
    assert resolved.client_origin == "frontend"
    assert resolved.is_active is True
    assert resolved.config["taskSource"] == "api"
    source_group_cache.set_from_sync.assert_not_called()
    db.commit()
    source_group_cache.set_from_sync.assert_called_once_with(
        f"task_source_group:api:frontend:{user.id}", resolved.id, expire=3600
    )


@pytest.mark.parametrize("cached_id", [999, "invalid-id"])
def test_missing_or_malformed_cached_id_creates_a_valid_group(
    committing_db: tuple[Session, User], source_group_cache: Mock, cached_id: object
) -> None:
    db, user = committing_db
    source_group_cache.get_sync.return_value = cached_id

    group = get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin="frontend",
        task_source="api",
    )

    assert group.id != cached_id
    assert group.user_id == user.id
    assert group.config["taskSource"] == "api"


@pytest.mark.parametrize("redis_result", ["miss", "read_failure", "write_failure"])
def test_redis_miss_or_failure_preserves_committed_database_result(
    committing_db: tuple[Session, User],
    monkeypatch: pytest.MonkeyPatch,
    redis_result: str,
) -> None:
    db, user = committing_db
    redis_client = Mock()
    redis_client.get.return_value = None
    redis_client.set.return_value = True
    if redis_result == "read_failure":
        redis_client.get.side_effect = RedisConnectionError("Test Redis unavailable")
    elif redis_result == "write_failure":
        redis_client.set.side_effect = RedisConnectionError("Test Redis unavailable")
    cache = RedisCache("redis://cache.invalid/0")
    monkeypatch.setattr(cache, "_get_sync_client", lambda: redis_client)
    monkeypatch.setattr(task_source_group, "cache_manager", cache)

    group = get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin="frontend",
        task_source="api",
    )
    group_id = group.id
    redis_client.set.assert_not_called()
    db.commit()

    redis_client.get.assert_called_once_with(
        f"task_source_group:api:frontend:{user.id}"
    )
    assert redis_client.set.call_count == 1
    with Session(db.get_bind()) as verifier:
        persisted = verifier.get(Project, group_id)
        assert persisted is not None
        assert persisted.user_id == user.id
        assert persisted.config["taskSource"] == "api"
    db.commit()
    assert redis_client.set.call_count == 1


def test_unexpected_cache_publish_exception_does_not_change_committed_result(
    committing_db: tuple[Session, User], source_group_cache: Mock
) -> None:
    db, user = committing_db
    source_group_cache.set_from_sync.side_effect = RuntimeError(
        "Test cache publish failed"
    )
    group = get_or_create_task_source_group(
        db,
        user_id=user.id,
        client_origin="frontend",
        task_source="api",
    )
    group_id = group.id

    db.commit()

    with Session(db.get_bind()) as verifier:
        persisted = verifier.get(Project, group_id)
        assert persisted is not None
        assert persisted.config["taskSource"] == "api"
    db.commit()
    assert source_group_cache.set_from_sync.call_count == 1

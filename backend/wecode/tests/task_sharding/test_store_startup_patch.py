import importlib

import pytest

import app.services.adapters.task_kinds.queries as task_queries
import app.services.admin_task_run_stats as admin_task_run_stats
import app.stores.tasks as task_stores
from app.stores.tasks.sqlalchemy_access_store import SqlAlchemyTaskAccessStore
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore
from wecode.config.task_sharding_config import task_sharding_settings
from wecode.task_sharding.access_store import ShardedTaskAccessStore
from wecode.task_sharding.global_id_allocator import UserScopedGlobalIdAllocator
from wecode.task_sharding.subtask_store import ShardedSubtaskStore
from wecode.task_sharding.task_run_metric_hooks import (
    sharded_task_run_metric_hooks,
)
from wecode.task_sharding.task_store import ShardedTaskStore

pytestmark = pytest.mark.unit


class FakeRedisIdFactory:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False
        self._counter = 0

    def next_seq(self) -> int:
        self._counter += 1
        return self._counter

    def close(self) -> None:
        self.closed = True


def configure_redis_settings(monkeypatch) -> None:
    monkeypatch.setattr(
        task_sharding_settings,
        "WECODE_TASK_SEQ_REDIS_SERVER",
        "redis://redis.example:6379/0",
    )
    monkeypatch.setattr(
        task_sharding_settings,
        "WECODE_TASK_SEQ_REDIS_KEY",
        "wecode_task_global_seq",
    )
    monkeypatch.setattr(
        task_sharding_settings,
        "WECODE_TASK_SEQ_INITIAL_SEQUENCE",
        250_000,
    )


def test_task_sharding_startup_patch_installs_all_global_stores(monkeypatch):
    monkeypatch.setattr(task_stores, "task_store", SqlAlchemyTaskStore())
    monkeypatch.setattr(task_stores, "subtask_store", SqlAlchemySubtaskStore())
    monkeypatch.setattr(task_stores, "task_access_store", SqlAlchemyTaskAccessStore())
    monkeypatch.setattr(
        admin_task_run_stats,
        "subtask_store",
        task_stores.subtask_store,
    )
    monkeypatch.setattr(task_queries, "task_store", task_stores.task_store)
    monkeypatch.setattr(
        task_queries,
        "task_access_store",
        task_stores.task_access_store,
    )

    configure_redis_settings(monkeypatch)
    patch_module = importlib.import_module("wecode.task_sharding.store_patch")
    importlib.reload(patch_module)
    monkeypatch.setattr(patch_module, "RedisIdFactory", FakeRedisIdFactory)
    patch_module.shutdown_task_sharding_store_patch()

    assert isinstance(task_stores.task_store, SqlAlchemyTaskStore)
    assert isinstance(task_stores.subtask_store, SqlAlchemySubtaskStore)
    assert isinstance(task_stores.task_access_store, SqlAlchemyTaskAccessStore)

    patch_module.install_task_sharding_store_patch()

    assert isinstance(task_stores.task_store, ShardedTaskStore)
    assert isinstance(task_stores.subtask_store, ShardedSubtaskStore)
    assert isinstance(task_stores.task_access_store, ShardedTaskAccessStore)
    assert isinstance(task_queries.task_store, ShardedTaskStore)
    assert isinstance(task_queries.task_access_store, ShardedTaskAccessStore)
    assert isinstance(admin_task_run_stats.subtask_store, ShardedSubtaskStore)
    assert sharded_task_run_metric_hooks._registered is True
    assert isinstance(
        patch_module._global_id_allocator,
        UserScopedGlobalIdAllocator,
    )
    assert (
        task_stores.task_store.global_id_allocator is patch_module._global_id_allocator
    )
    assert (
        task_stores.subtask_store.global_id_allocator
        is patch_module._global_id_allocator
    )
    assert (
        patch_module._global_id_allocator.user_scoped_factory._seq_source.kwargs[
            "initial_sequence"
        ]
        == 250_000
    )

    patch_module.shutdown_task_sharding_store_patch()
    assert patch_module._global_id_allocator is None
    assert sharded_task_run_metric_hooks._registered is False


def test_task_sharding_startup_patch_requires_internal_extension_gate(monkeypatch):
    monkeypatch.setattr(task_stores, "task_store", SqlAlchemyTaskStore())
    monkeypatch.setattr(task_stores, "subtask_store", SqlAlchemySubtaskStore())
    monkeypatch.setattr(task_stores, "task_access_store", SqlAlchemyTaskAccessStore())
    monkeypatch.setattr(task_queries, "task_store", task_stores.task_store)
    monkeypatch.setattr(
        task_queries,
        "task_access_store",
        task_stores.task_access_store,
    )
    monkeypatch.setattr(
        task_sharding_settings,
        "WECODE_INTERNAL_EXTENSIONS_ENABLED",
        False,
        raising=False,
    )
    monkeypatch.setattr(
        task_sharding_settings,
        "WECODE_TASK_SHARDING_ENABLED",
        True,
        raising=False,
    )
    configure_redis_settings(monkeypatch)
    patch_module = importlib.import_module("wecode.task_sharding.store_patch")
    importlib.reload(patch_module)
    monkeypatch.setattr(patch_module, "RedisIdFactory", FakeRedisIdFactory)
    patch_module.shutdown_task_sharding_store_patch()

    patch_module.install_task_sharding_store_patch_if_enabled()

    assert isinstance(task_stores.task_store, SqlAlchemyTaskStore)
    assert isinstance(task_stores.subtask_store, SqlAlchemySubtaskStore)
    assert patch_module._global_id_allocator is None

    monkeypatch.setattr(
        task_sharding_settings,
        "WECODE_INTERNAL_EXTENSIONS_ENABLED",
        True,
        raising=False,
    )

    patch_module.install_task_sharding_store_patch_if_enabled()

    assert isinstance(task_stores.task_store, ShardedTaskStore)
    assert isinstance(task_stores.subtask_store, ShardedSubtaskStore)
    assert isinstance(
        patch_module._global_id_allocator,
        UserScopedGlobalIdAllocator,
    )

    patch_module.shutdown_task_sharding_store_patch()

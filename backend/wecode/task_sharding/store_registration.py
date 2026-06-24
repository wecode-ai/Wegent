from __future__ import annotations

import sys
from typing import Any

from wecode.task_sharding.access_store import ShardedTaskAccessStore
from wecode.task_sharding.global_id_allocator import GlobalIdAllocator
from wecode.task_sharding.subtask_store import ShardedSubtaskStore
from wecode.task_sharding.task_store import ShardedTaskStore

_STORE_ATTRIBUTE_NAMES = ("task_store", "subtask_store", "task_access_store")


def install_task_sharding_task_store(
    *,
    global_id_allocator: GlobalIdAllocator | None = None,
) -> ShardedTaskStore:
    import app.stores.tasks as task_stores

    store = ShardedTaskStore(
        global_id_allocator=global_id_allocator,
    )
    task_stores.task_store = store
    return store


def install_task_sharding_subtask_store(
    *,
    global_id_allocator: GlobalIdAllocator | None = None,
) -> ShardedSubtaskStore:
    import app.stores.tasks as task_stores

    store = ShardedSubtaskStore(
        global_id_allocator=global_id_allocator,
    )
    task_stores.subtask_store = store
    return store


def install_task_sharding_access_store() -> ShardedTaskAccessStore:
    import app.stores.tasks as task_stores

    store = ShardedTaskAccessStore()
    task_stores.task_access_store = store
    return store


def install_task_sharding_stores(
    *,
    global_id_allocator: GlobalIdAllocator | None = None,
) -> tuple[ShardedTaskStore, ShardedSubtaskStore, ShardedTaskAccessStore]:
    import app.stores.tasks as task_stores

    previous_stores = {
        "task_store": task_stores.task_store,
        "subtask_store": task_stores.subtask_store,
        "task_access_store": task_stores.task_access_store,
    }

    task_store = ShardedTaskStore(
        global_id_allocator=global_id_allocator,
    )
    subtask_store = ShardedSubtaskStore(
        global_id_allocator=global_id_allocator,
    )
    access_store = ShardedTaskAccessStore(task_store=task_store)

    task_stores.task_store = task_store
    task_stores.subtask_store = subtask_store
    task_stores.task_access_store = access_store

    _replace_imported_store_aliases(
        previous_stores,
        {
            "task_store": task_store,
            "subtask_store": subtask_store,
            "task_access_store": access_store,
        },
    )
    return task_store, subtask_store, access_store


def _replace_imported_store_aliases(
    previous_stores: dict[str, Any],
    installed_stores: dict[str, Any],
) -> None:
    for module in tuple(sys.modules.values()):
        if module is None:
            continue
        module_dict = getattr(module, "__dict__", None)
        if not module_dict:
            continue
        for attr_name in _STORE_ATTRIBUTE_NAMES:
            if module_dict.get(attr_name) is previous_stores[attr_name]:
                setattr(module, attr_name, installed_stores[attr_name])
